// Emissor simples para disparar uma notificação dentro do app de qualquer lugar.
type Handler = (title: string, body: string) => void;

let handler: Handler | null = null;

export function setNotifyHandler(h: Handler | null) {
  handler = h;
}

export function notifyInApp(title: string, body: string) {
  handler?.(title, body);
}
