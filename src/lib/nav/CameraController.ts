// nav/CameraController — funil ÚNICO de toda atualização de câmera do mapa.
//
// Bloco 1 (bug crítico iOS). Regra de ouro: NENHUMA tela chama
// animateCamera/animateToRegion/fitToCoordinates direto no mapRef. Tudo passa
// por aqui, que:
//   1. valida a coordenada (nav/cameraGuard) — rejeita null/NaN/(0,0), fix ruim
//      e salto impossível (> 200 km), mantendo a ÚLTIMA câmera válida;
//   2. faz o clamp do zoom/deltas (nunca "abre" pro continente em operação);
//   3. espera o mapa estar pronto (onMapReady) — chamar câmera antes disso é a
//      causa raiz do "explode pro mundo" no iOS;
//   4. serializa/debounca animações concorrentes (uma nova cancela a pendente,
//      mas ignora rajadas dentro de um curto intervalo mínimo);
//   5. loga todo update REJEITADO na telemetria unificada (errorReporting),
//      para confirmar a causa raiz em produção.
//
// Quando a flag `camera_controller_enabled` está OFF, o controller vira um
// pass-through (aplica direto, sem guarda) — rollback imediato para o legado.

import type MapView from 'react-native-maps';
import { addBreadcrumb, reportWarning } from '../errorReporting';
import {
  clampAltitude,
  clampRegionDelta,
  clampZoom,
  sanitizeCoords,
  validateTarget,
  DEFAULT_GUARD,
  type GuardConfig,
} from './cameraGuard';
import { altitudeForZoom } from './follow';
import { setLastValidCamera } from './lastCamera';

export interface CameraTarget {
  lat: number;
  lng: number;
  accuracy?: number | null;
}

export interface CameraPose {
  /** Rumo da câmera (graus, contínuo/desenrolado permitido). */
  heading?: number;
  /** Inclinação (perspectiva de navegação). */
  pitch?: number;
  /** Nível de zoom; será clampado à faixa operacional. */
  zoom?: number;
}

export interface CameraControllerOptions {
  /** Como obter o MapView vivo (ref.current). */
  getMap: () => MapView | null;
  /** Flag de rollout: false → pass-through legado (sem guarda). */
  enabled: () => boolean;
  /** Origem (nome da tela/call-site) para telemetria. */
  source: string;
  /** Intervalo mínimo (ms) entre duas animações de follow — anti-rajada. */
  minIntervalMs?: number;
  guard?: GuardConfig;
}

export class CameraController {
  private opts: CameraControllerOptions;
  private guard: GuardConfig;
  private ready = false;
  private lastValid: { lat: number; lng: number } | null = null;
  private lastAnimateAt = 0;

  constructor(opts: CameraControllerOptions) {
    this.opts = opts;
    this.guard = opts.guard ?? DEFAULT_GUARD;
  }

  /** Marca o mapa como pronto (chamar de onMapReady). */
  setReady(ready: boolean): void {
    this.ready = ready;
  }

  /** Última posição válida conhecida (para reancorar/consultar). */
  getLastValid(): { lat: number; lng: number } | null {
    return this.lastValid;
  }

  /** Marca o centro como o último válido — local (para checar saltos) e GLOBAL
   *  (para a próxima tela herdar o enquadramento e não montar em região default). */
  private commitValid(lat: number, lng: number): void {
    this.lastValid = { lat, lng };
    setLastValidCamera({ lat, lng });
  }

  private reject(reason: string, detail?: Record<string, number>): void {
    // Toda rejeição vira telemetria — é como confirmamos a causa raiz em prod.
    addBreadcrumb('camera_update_rejected', { source: this.opts.source, reason, ...detail });
    reportWarning(`camera update rejected (${reason})`, {
      source: this.opts.source,
      reason,
      ...detail,
    });
  }

  /**
   * Câmera de perseguição (follow / recenter / troca de fase). Valida o centro,
   * faz o clamp do zoom e anima. Retorna true se aplicou, false se rejeitou.
   */
  follow(target: CameraTarget | null | undefined, pose: CameraPose, durationMs: number): boolean {
    const map = this.opts.getMap();
    if (!map || !this.ready) return false;

    if (!this.opts.enabled()) {
      // Pass-through legado (flag OFF): sem guarda de coordenada/clamp. A
      // `altitude` vai mesmo assim — sem ela o iOS não recebe escala nenhuma e
      // o mapa se afasta sozinho (ver nav/follow.altitudeForZoom), então o
      // rollback da flag não pode significar rollback deste bug.
      map.animateCamera(
        {
          center: target ? { latitude: target.lat, longitude: target.lng } : undefined,
          heading: pose.heading,
          pitch: pose.pitch,
          zoom: pose.zoom,
          altitude: altitudeForZoom(pose.zoom),
        } as any,
        { duration: durationMs },
      );
      return true;
    }

    const v = validateTarget(target, this.lastValid, this.guard);
    if (!v.ok) {
      this.reject(v.reason, v.detail);
      return false; // fallback: mantém a última câmera válida (não anima)
    }

    // Anti-rajada: ignora follows dentro do intervalo mínimo (mantém o mais novo
    // só se passou o gap). Recenter/fase passam durationMs curto e não sofrem.
    const now = Date.now();
    const minGap = this.opts.minIntervalMs ?? 0;
    if (minGap > 0 && now - this.lastAnimateAt < minGap) return false;
    this.lastAnimateAt = now;

    const { zoom, clamped } = clampZoom(pose.zoom, this.guard);
    if (clamped) this.reject('zoom_clamped', { zoom: pose.zoom ?? 0 });

    // O iOS ignora `zoom` e só obedece `altitude`; o Android é o contrário.
    // Mandamos as duas — sem a altitude, o clamp acima não protege nada no
    // iPhone (ver nav/follow.altitudeForZoom).
    const { altitude, clamped: altClamped } = clampAltitude(altitudeForZoom(zoom), this.guard);
    if (altClamped) this.reject('altitude_clamped', { altitude: altitude ?? 0 });

    this.commitValid(target!.lat, target!.lng);
    map.animateCamera(
      {
        center: { latitude: target!.lat, longitude: target!.lng },
        heading: pose.heading,
        pitch: pose.pitch,
        zoom,
        altitude,
      } as any,
      { duration: durationMs },
    );
    return true;
  }

  /**
   * Move para uma region (lat/lng + deltas). Valida o centro e faz o clamp dos
   * deltas ao teto anti-continente. Usado por telas sem perspectiva (Home).
   */
  region(
    r: { lat: number; lng: number; latitudeDelta: number; longitudeDelta: number },
    durationMs: number,
  ): boolean {
    const map = this.opts.getMap();
    if (!map || !this.ready) return false;

    if (!this.opts.enabled()) {
      map.animateToRegion(
        {
          latitude: r.lat,
          longitude: r.lng,
          latitudeDelta: r.latitudeDelta,
          longitudeDelta: r.longitudeDelta,
        },
        durationMs,
      );
      return true;
    }

    const v = validateTarget(r, this.lastValid, this.guard);
    if (!v.ok) {
      this.reject(v.reason, v.detail);
      return false;
    }
    const { latitudeDelta, longitudeDelta, clamped } = clampRegionDelta(
      r.latitudeDelta,
      r.longitudeDelta,
      this.guard,
    );
    if (clamped) this.reject('region_delta_clamped');
    this.commitValid(r.lat, r.lng);
    map.animateToRegion(
      { latitude: r.lat, longitude: r.lng, latitudeDelta, longitudeDelta },
      durationMs,
    );
    return true;
  }

  /**
   * Enquadra várias coordenadas (visão geral: motorista + embarque/destino).
   * Filtra coordenadas-lixo ANTES de chamar o SDK — array vazio ou com (0,0) é
   * a outra causa clássica do zoom-out pro mundo. Precisa de ≥ 1 ponto válido.
   */
  fit(
    coords: CameraTarget[],
    opts: { edgePadding: { top: number; right: number; bottom: number; left: number }; animated?: boolean },
  ): boolean {
    const map = this.opts.getMap();
    if (!map || !this.ready) return false;

    const clean = this.opts.enabled() ? sanitizeCoords(coords) : coords;
    if (clean.length === 0) {
      this.reject('fit_empty');
      return false;
    }
    map.fitToCoordinates(
      clean.map((c) => ({ latitude: c.lat, longitude: c.lng })),
      { edgePadding: opts.edgePadding, animated: opts.animated ?? true },
    );
    // Reancora o "último válido" no centroide, para futuras validações de salto.
    const cx = clean.reduce((s, c) => s + c.lat, 0) / clean.length;
    const cy = clean.reduce((s, c) => s + c.lng, 0) / clean.length;
    this.commitValid(cx, cy);
    return true;
  }
}
