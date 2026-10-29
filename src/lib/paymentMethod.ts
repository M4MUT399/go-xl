/**
 * Como uma forma de pagamento é descrita na tela.
 *
 * ── POR QUE ISTO EXISTE ─────────────────────────────────────────────────────
 *
 * A `PaymentScreen` montava o texto assim:
 *
 *     const brandLabel = profile?.card_brand ? BRAND_LABEL[...] : 'CARTÃO';
 *     <Text>•••• •••• •••• {profile?.card_last4}</Text>
 *
 * Duas colunas, as duas de cartão. Quando o método salvo NÃO é cartão — Link,
 * por exemplo — o Stripe não devolve `pm.card`, as duas colunas ficam NULL, e a
 * tela renderizava "CARTÃO •••• •••• •••• " com o fim vazio. A passageira da
 * corrida `f28f2887` tinha método salvo, anexado e cobrável, e a tela dela não
 * mostrava nada que fizesse sentido.
 *
 * O conserto foi gravar o tipo e um rótulo prontos no servidor (migration 0078,
 * `stripe-webhook`, `remove-card`, `list-cards`). Este módulo é o lado do app:
 * usa o rótulo quando ele existe e reconstrói a partir das colunas velhas
 * quando não existe — porque perfil antigo não tem os campos novos, e produção
 * só passa a tê-los depois que a 0078 for aplicada.
 *
 * A ordem importa e é o ponto todo: nunca supor cartão. Supor cartão foi o
 * defeito.
 */

/** O mínimo que uma tela precisa saber para descrever o método. */
export interface FormaDePagamento {
  payment_method_type?: string | null;
  payment_method_label?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  stripe_payment_method_id?: string | null;
}

const MARCA: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

/** Existe forma de pagamento salva? Não pergunta se é cartão — de propósito. */
export function temFormaDePagamento(p?: FormaDePagamento | null): boolean {
  return !!p?.stripe_payment_method_id;
}

/** É cartão? Só responde `true` quando há evidência de que é. */
export function eCartao(p?: FormaDePagamento | null): boolean {
  if (!p) return false;
  if (p.payment_method_type) return p.payment_method_type === 'card';
  // Sem o campo novo, `card_last4` preenchido é a única evidência disponível.
  return !!p.card_last4;
}

/**
 * O texto que a tela mostra. Nunca devolve string vazia: uma linha em branco no
 * lugar da forma de pagamento é o que fazia a passageira concluir que não tinha
 * nada salvo.
 */
export function descreverFormaDePagamento(p?: FormaDePagamento | null): string {
  if (!temFormaDePagamento(p)) return 'Nenhuma forma de pagamento';

  // 1) O rótulo do servidor, quando existe. É o único que sabe o e-mail do Link.
  const rotulo = p?.payment_method_label?.trim();
  if (rotulo) return rotulo;

  // 2) Cartão: reconstrói do jeito antigo.
  if (p?.card_last4) {
    const marca = p.card_brand
      ? (MARCA[p.card_brand.toLowerCase()] ?? p.card_brand.toUpperCase())
      : 'Cartão';
    return `${marca} •••• ${p.card_last4}`;
  }

  // 3) Tipo conhecido, sem rótulo: melhor nomear o que é do que fingir cartão.
  if (p?.payment_method_type) {
    return p.payment_method_type === 'link' ? 'Link' : p.payment_method_type;
  }

  // 4) Perfil antigo com método salvo e nenhum detalhe. Dizer que existe algo
  //    salvo é verdade; dizer "CARTÃO •••• " não era.
  return 'Forma de pagamento salva';
}
