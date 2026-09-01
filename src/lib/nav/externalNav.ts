// nav/externalNav — montagem PURA das URLs de navegação externa (Google Maps
// e Waze), a partir de uma coordenada.
//
// Por que existe: o motorista precisa poder sair da navegação interna e mandar
// o trecho para o app que ele já usa no dia a dia. Quem decide PARA ONDE é a
// tela (fase pickup → passageiro; fase dropoff → destino); aqui só se traduz
// {lat,lng} nas URLs de cada app. Sem React, sem Linking, sem I/O e sem
// `Platform` — assim cada esquema pode ser conferido caractere a caractere em
// teste, sem simulador e sem os apps instalados.
//
// Toda a parte suja (descobrir em que plataforma se está, perguntar se o
// esquema abre, cair para o https) vive em nav/openExternalNav.ts.

import { isFiniteCoord, isNullIsland } from './cameraGuard';

export type ExternalNavApp = 'googleMaps' | 'waze';

/**
 * As duas plataformas que recebem URL de esquema. `web` não entra: lá nenhum
 * esquema abre app nenhum e só o https faz sentido — openExternalNav trata o
 * navegador como iOS e o fallback https resolve.
 */
export type ExternalNavPlatform = 'ios' | 'android';

/** Ordem em que os botões aparecem na barra — Google Maps primeiro. */
export const EXTERNAL_NAV_APPS: readonly ExternalNavApp[] = ['googleMaps', 'waze'];

// Nome próprio de produto NÃO se traduz — por isso fica aqui e não no i18n.
export const EXTERNAL_NAV_APP_NAMES: Record<ExternalNavApp, string> = {
  googleMaps: 'Google Maps',
  waze: 'Waze',
};

export interface ExternalNavPoint {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /**
   * Nome do ponto (ex.: o endereço de embarque). NÃO entra na URL — nem o
   * esquema do Google Maps nem o do Waze documentam rótulo ao lado de uma
   * coordenada, e enfiar um parâmetro inventado faz o app abrir uma BUSCA por
   * texto em vez de navegar para o ponto exato. Fica aqui normalizado para a
   * interface usar (rótulo de acessibilidade, confirmação, log).
   */
  label?: string | null;
}

export interface ExternalNavLinks {
  app: ExternalNavApp;
  /** Nome do app, para o botão. */
  name: string;
  /**
   * URL de esquema do app instalado, UMA POR PLATAFORMA.
   *
   * Não é preciosismo: `comgooglemaps://` é o esquema do Google Maps **de
   * iOS**, e o app Android não o registra. Mandar essa string no Android faz
   * `canOpenURL` responder false mesmo com o Maps instalado, e o toque cai
   * sempre no https — que abre uma PRÉVIA de rota, com o motorista ainda
   * tendo que apertar "Iniciar", enquanto o botão do Waze ao lado já começou a
   * navegar. No Android o alvo documentado que INICIA o turn-by-turn é
   * `google.navigation:`. O Waze usa o mesmo `waze://` nas duas.
   *
   * Quem escolhe a chave é openExternalNav — este módulo não conhece
   * `Platform`.
   */
  appUrl: Record<ExternalNavPlatform, string>;
  /**
   * URL https equivalente. Não é só "plano B de quem não tem o app": no iOS,
   * sem `LSApplicationQueriesSchemes`, o esquema sequer pode ser consultado —
   * e o https ainda assim é capturado pelo app instalado (universal link).
   */
  webUrl: string;
  /** `label` do ponto após trim; string vazia vira null. */
  label: string | null;
}

/**
 * true se a coordenada pode virar URL de navegação.
 *
 * Rejeita null/undefined, não-finito, fora da faixa geográfica e a "Null
 * Island" (0,0) — que é o que o GPS devolve quando ainda não tem fix, nunca um
 * ponto de embarque real. Mesmas regras que já guardam a câmera do mapa
 * (nav/cameraGuard), de propósito: uma coordenada boa o bastante para o mapa
 * interno é boa o bastante para o app externo, e vice-versa.
 */
export function isNavigableCoord(lat: unknown, lng: unknown): boolean {
  if (!isFiniteCoord(lat, lng)) return false;
  return !isNullIsland(lat as number, lng as number);
}

/**
 * "28.5383,-81.3792".
 *
 * Seis casas decimais ≈ 11 cm, muito além do que qualquer app de navegação
 * usa. O arredondamento não é preciosismo: sem ele, o lixo de ponto flutuante
 * (28.538300000000003) vai inteiro para a URL.
 */
function formatLatLng(lat: number, lng: number): string {
  return `${Number(lat.toFixed(6))},${Number(lng.toFixed(6))}`;
}

/**
 * Monta as URLs (esquema do app por plataforma + https) para um app e uma
 * coordenada. Devolve null se a coordenada não serve — melhor não oferecer a
 * ação do que abrir o Waze no meio do Atlântico.
 */
export function buildExternalNavLinks(
  app: ExternalNavApp,
  point: ExternalNavPoint | null | undefined,
): ExternalNavLinks | null {
  if (!point) return null;
  const { lat, lng } = point;
  if (!isNavigableCoord(lat, lng)) return null;

  const ll = formatLatLng(lat as number, lng as number);
  const label = point.label?.trim() ? point.label.trim() : null;

  if (app === 'googleMaps') {
    return {
      app,
      name: EXTERNAL_NAV_APP_NAMES.googleMaps,
      appUrl: {
        ios: `comgooglemaps://?daddr=${ll}&directionsmode=driving`,
        android: `google.navigation:q=${ll}&mode=d`,
      },
      webUrl: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`,
      label,
    };
  }

  return {
    app,
    name: EXTERNAL_NAV_APP_NAMES.waze,
    appUrl: { ios: `waze://?ll=${ll}&navigate=yes`, android: `waze://?ll=${ll}&navigate=yes` },
    webUrl: `https://waze.com/ul?ll=${ll}&navigate=yes`,
    label,
  };
}

/**
 * Todos os apps suportados, na ordem da barra. Coordenada inválida → lista
 * vazia (a barra some inteira em vez de mostrar botão que não leva a lugar
 * nenhum).
 */
export function buildAllExternalNavLinks(
  point: ExternalNavPoint | null | undefined,
): ExternalNavLinks[] {
  const links: ExternalNavLinks[] = [];
  for (const app of EXTERNAL_NAV_APPS) {
    const built = buildExternalNavLinks(app, point);
    if (built) links.push(built);
  }
  return links;
}
