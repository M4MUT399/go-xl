// Textos de PUSH no idioma de QUEM RECEBE.
//
// Até 29/10/2026 todo push saía em português, cravado em cada Edge Function — e
// quem recebe é, na maioria, passageiro americano em Orlando. O idioma vem de
// `profiles.language` ('en' | 'es' | 'pt', default 'en'), o mesmo campo que o
// e-mail de recibo já usa; a normalização é a MESMA (`receiptLang`), para que
// recibo e push nunca discordem sobre o idioma de um usuário.
//
// Regra: o idioma é sempre o do DESTINATÁRIO, nunca o de quem dispara. Um
// passageiro em inglês que cancela a corrida de um motorista em português gera
// um push em português para o motorista.
//
// Puro (sem Deno, sem Supabase) para rodar também sob jest:
//   npx jest supabase/functions/_shared/__tests__/pushI18n.test.ts

import { receiptLang, type ReceiptLang } from './rideReceipt.ts';

export type PushLang = ReceiptLang;

/** Normaliza `profiles.language` (ou qualquer coisa) para 'en' | 'es' | 'pt'. Fallback 'en'. */
export function pushLang(v: unknown): PushLang {
  return receiptLang(v);
}

export type PushText = { title: string; body: string };

/** Fuso da operação. Datas do push são lidas em Orlando, não no UTC do servidor. */
export const PUSH_TIME_ZONE = 'America/New_York';

const LOCALE: Record<PushLang, string> = { en: 'en-US', es: 'es-US', pt: 'pt-BR' };

/** Locale de formatação de data/hora para o idioma do destinatário. */
export function pushLocale(lang: PushLang): string {
  return LOCALE[lang];
}

/** Valor em dólar como aparece no app: `$41.53` em qualquer idioma (a moeda é sempre USD). */
export function pushMoney(v: number | null | undefined): string {
  return `$${(Number(v) || 0).toFixed(2)}`;
}

/**
 * "10/31 at 3:30 PM" · "31/10 a las 3:30 p.m." · "31/10 às 15:30" — sempre no
 * horário de Orlando. Data inválida/ausente devolve ''.
 */
export function pushWhen(iso: string | null | undefined, lang: PushLang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const locale = pushLocale(lang);
  const date = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', timeZone: PUSH_TIME_ZONE });
  const time = d.toLocaleTimeString(locale, {
    hour: lang === 'pt' ? '2-digit' : 'numeric',
    minute: '2-digit',
    timeZone: PUSH_TIME_ZONE,
  });
  const at = { en: 'at', es: 'a las', pt: 'às' }[lang];
  return `${date} ${at} ${time}`;
}

const dest = (s: string | null | undefined) => s ?? '';

// ─────────────────────────────────────────────────────────────────────────────
// send-ride-push
// ─────────────────────────────────────────────────────────────────────────────

/** Motorista: passageiro pediu corrida imediata pelo QR dele. */
export function pushNewRideDirect(lang: PushLang, destination: string | null, price: number | null): PushText {
  const tail = `${dest(destination)} • ${pushMoney(price)}`;
  return {
    en: { title: '📲 QR Code ride — Executive XL', body: `A passenger requested a ride through your QR code. Destination: ${tail}` },
    es: { title: '📲 Viaje por código QR — Executive XL', body: `Un pasajero pidió un viaje con tu código QR. Destino: ${tail}` },
    pt: { title: '📲 Corrida via QR Code — Executive XL', body: `Passageiro solicitou pelo seu QR. Destino: ${tail}` },
  }[lang];
}

/** Motorista: passageiro agendou pelo QR dele. `when` já formatado com `pushWhen`. */
export function pushNewRideScheduledDirect(
  lang: PushLang,
  when: string,
  destination: string | null,
  price: number | null,
): PushText {
  const tail = `${dest(destination)} • ${pushMoney(price)}`;
  return {
    en: { title: '🗓️📲 QR Code booking — Executive XL', body: `A passenger booked a ride through your QR code for ${when}. Destination: ${tail}` },
    es: { title: '🗓️📲 Reserva por código QR — Executive XL', body: `Un pasajero reservó un viaje con tu código QR para el ${when}. Destino: ${tail}` },
    pt: { title: '🗓️📲 Agendamento via QR Code — Executive XL', body: `Passageiro agendou pelo seu QR para ${when}. Destino: ${tail}` },
  }[lang];
}

/** Motorista (leque): nova corrida aberta no pool. */
export function pushNewRideBroadcast(lang: PushLang, destination: string | null, price: number | null): PushText {
  const tail = `${dest(destination)} • ${pushMoney(price)}`;
  return {
    en: { title: '🚗 New Executive XL ride', body: `Destination: ${tail}` },
    es: { title: '🚗 Nuevo viaje Executive XL', body: `Destino: ${tail}` },
    pt: { title: '🚗 Nova corrida Executive XL', body: `Destino: ${tail}` },
  }[lang];
}

/** Passageiro: corrida aceita (e, se houver valor, cobrada). */
export function pushRideAccepted(lang: PushLang, price: number | null, etaMin: number | null): PushText {
  const t = {
    en: {
      title: '💳 Payment confirmed — Driver on the way!',
      eta: (m: number) => ` Arriving in ${m} min.`,
      noEta: ' Your driver is on the way!',
      charged: (p: string) => `${p} charged to your card.`,
      confirmed: 'Your Executive XL is confirmed.',
    },
    es: {
      title: '💳 Pago confirmado — ¡Tu conductor va en camino!',
      eta: (m: number) => ` Llega en ${m} min.`,
      noEta: ' ¡Tu conductor va en camino!',
      charged: (p: string) => `Se cobraron ${p} a tu tarjeta.`,
      confirmed: 'Tu Executive XL está confirmado.',
    },
    pt: {
      title: '💳 Pagamento confirmado — Motorista a caminho!',
      eta: (m: number) => ` Chegando em ${m} min.`,
      noEta: ' Motorista a caminho!',
      charged: (p: string) => `${p} cobrado do seu cartão.`,
      confirmed: 'Seu Executive XL foi confirmado.',
    },
  }[lang];
  const etaPhrase = etaMin ? t.eta(etaMin) : t.noEta;
  const body = price ? `${t.charged(pushMoney(price))}${etaPhrase}` : `${t.confirmed}${etaPhrase}`;
  return { title: t.title, body };
}

/** Passageiro: motorista confirmou o agendamento. */
export function pushScheduleConfirmed(lang: PushLang): PushText {
  return {
    en: { title: '🗓️ Driver confirmed!', body: 'A driver accepted your scheduled ride. You can see the details on the scheduled rides screen.' },
    es: { title: '🗓️ ¡Conductor confirmado!', body: 'Un conductor aceptó tu viaje programado. Puedes ver los detalles en la pantalla de viajes programados.' },
    pt: { title: '🗓️ Motorista confirmado!', body: 'Um motorista aceitou seu agendamento. Você pode ver os detalhes na tela de corridas agendadas.' },
  }[lang];
}

/** Passageiro: motorista recusou o agendamento (voltou ao pool). */
export function pushScheduleRejected(lang: PushLang): PushText {
  return {
    en: { title: '🗓️ Scheduled ride not confirmed', body: "The driver couldn't confirm your scheduled ride. We're looking for another driver for you." },
    es: { title: '🗓️ Viaje programado sin confirmar', body: 'El conductor no pudo confirmar tu viaje programado. Estamos buscando otro conductor para ti.' },
    pt: { title: '🗓️ Agendamento não confirmado', body: 'O motorista não pôde confirmar seu agendamento. Estamos procurando outro motorista para você.' },
  }[lang];
}

/** Passageiro: corrida concluída. */
export function pushRideCompleted(lang: PushLang, price: number | null): PushText {
  const p = pushMoney(price);
  return {
    en: {
      title: '🏁 Ride complete!',
      body: price ? `Total: ${p}. Rate your driver and leave a tip! 🌟` : 'Your Executive XL ride is complete. Rate your driver!',
    },
    es: {
      title: '🏁 ¡Viaje finalizado!',
      body: price ? `Total: ${p}. ¡Califica a tu conductor y déjale una propina! 🌟` : 'Tu viaje Executive XL ha finalizado. ¡Califica a tu conductor!',
    },
    pt: {
      title: '🏁 Corrida finalizada!',
      body: price ? `Valor: ${p}. Avalie o motorista e deixe uma gorjeta! 🌟` : 'Sua corrida Executive XL foi concluída. Avalie o motorista!',
    },
  }[lang];
}

/** Passageiro: motorista liberou o agendamento que tinha aceitado. */
export function pushDriverReleased(lang: PushLang): PushText {
  return {
    en: { title: '⚠️ Driver cancelled your scheduled ride', body: 'The driver released your scheduled ride. Wait for a new confirmation or request a ride now.' },
    es: { title: '⚠️ El conductor canceló tu viaje programado', body: 'El conductor liberó tu viaje programado. Espera una nueva confirmación o pide un viaje ahora.' },
    pt: { title: '⚠️ Motorista cancelou o agendamento', body: 'O motorista liberou sua corrida agendada. Aguarde nova confirmação ou solicite agora.' },
  }[lang];
}

/** Motorista: passageiro cancelou a corrida já aceita. */
export function pushRideCancelledByPassenger(lang: PushLang): PushText {
  return {
    en: { title: '❌ Ride cancelled', body: 'The passenger cancelled this ride.' },
    es: { title: '❌ Viaje cancelado', body: 'El pasajero canceló este viaje.' },
    pt: { title: '❌ Corrida cancelada', body: 'O passageiro cancelou esta corrida.' },
  }[lang];
}

/** Passageiro: motorista tocou "Cheguei" no embarque (0091). */
export function pushDriverArrived(lang: PushLang): PushText {
  return {
    en: { title: '📍 Your driver has arrived', body: 'Your driver is waiting at the pickup point. After 5 free minutes, $0.75/min is added.' },
    es: { title: '📍 Tu conductor llegó', body: 'Tu conductor te espera en el punto de recogida. Después de 5 minutos gratis, se suman $0.75/min.' },
    pt: { title: '📍 Seu motorista chegou', body: 'O motorista está esperando no embarque. Depois de 5 minutos grátis, são cobrados $0,75/min.' },
  }[lang];
}

/** Motorista: passageiro mudou a rota com a corrida em curso (0091). */
export function pushRouteChanged(lang: PushLang): PushText {
  return {
    en: { title: '🗺️ Route updated', body: 'The passenger changed the destination or added a stop. Open the app to follow the new route.' },
    es: { title: '🗺️ Ruta actualizada', body: 'El pasajero cambió el destino o agregó una parada. Abre la app para seguir la nueva ruta.' },
    pt: { title: '🗺️ Rota alterada', body: 'O passageiro mudou o destino ou incluiu uma parada. Abra o app para seguir a nova rota.' },
  }[lang];
}

/** Passageiro: agendamento venceu sem motorista. */
export function pushScheduleExpired(lang: PushLang): PushText {
  return {
    en: { title: '⏰ Scheduled ride not confirmed', body: 'No driver accepted your scheduled ride in time. Please request a new ride.' },
    es: { title: '⏰ Viaje programado sin confirmar', body: 'Ningún conductor aceptó tu viaje programado a tiempo. Pide un nuevo viaje.' },
    pt: { title: '⏰ Agendamento não confirmado', body: 'Nenhum motorista aceitou seu agendamento a tempo. Solicite uma nova corrida.' },
  }[lang];
}

// ─────────────────────────────────────────────────────────────────────────────
// sweep-stale-requesting
// ─────────────────────────────────────────────────────────────────────────────

/** Passageiro: pedido encerrado sem motorista e SEM cobrança (não fala em estorno de propósito). */
export function pushRideExpiredNoDriver(lang: PushLang): PushText {
  return {
    en: { title: "We couldn't find a driver", body: 'Your request was closed and you were not charged. You can request again anytime.' },
    es: { title: 'No encontramos un conductor', body: 'Tu solicitud se cerró y no se te cobró nada. Puedes pedir de nuevo cuando quieras.' },
    pt: { title: 'Não encontramos um motorista', body: 'Sua solicitação foi encerrada e nada foi cobrado. Você pode pedir novamente quando quiser.' },
  }[lang];
}

/** Passageiro: ninguém assumiu a corrida já cobrada — valor estornado. */
export function pushRideRefundedNoDriver(lang: PushLang, amountCents: number): PushText {
  const p = pushMoney(amountCents / 100);
  return {
    en: { title: '💸 Ride cancelled — refund issued', body: `No driver picked up your ride. We refunded ${p} to your card (your bank may take a few days to show it).` },
    es: { title: '💸 Viaje cancelado — reembolso realizado', body: `Ningún conductor tomó tu viaje. Te reembolsamos ${p} a tu tarjeta (tu banco puede tardar unos días en reflejarlo).` },
    pt: { title: '💸 Corrida cancelada — valor estornado', body: `Nenhum motorista assumiu sua corrida. Estornamos ${p} no seu cartão (o banco pode levar alguns dias para mostrar).` },
  }[lang];
}
