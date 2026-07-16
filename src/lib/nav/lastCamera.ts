// nav/lastCamera — última câmera VÁLIDA conhecida, compartilhada entre telas.
//
// Bloco 1 (bug crítico iOS: zoom-out até o continente APÓS o aceite). Uma das
// causas do "explode pro mundo" é a tela de navegação MONTAR numa região default
// ou numa coordenada-lixo (0,0) antes de o primeiro fix chegar. Para eliminar
// isso, o CameraController grava aqui todo centro que ele aplicou com sucesso;
// a próxima tela (ex.: DriverNavigate montando logo após o aceite) HERDA esse
// enquadramento em vez de abrir numa região arbitrária.
//
// Módulo puro (sem React/SDK): um único slot em memória de processo, fácil de
// testar e de resetar entre execuções.

export interface CameraSnapshot {
  lat: number;
  lng: number;
}

let last: CameraSnapshot | null = null;

/** Grava a última câmera válida (chamado pelo CameraController ao aplicar). */
export function setLastValidCamera(c: CameraSnapshot): void {
  last = { lat: c.lat, lng: c.lng };
}

/** Última câmera válida conhecida (ou null se nenhuma tela enquadrou ainda). */
export function getLastValidCamera(): CameraSnapshot | null {
  return last;
}

/** Zera o slot (uso em testes). */
export function resetLastValidCamera(): void {
  last = null;
}
