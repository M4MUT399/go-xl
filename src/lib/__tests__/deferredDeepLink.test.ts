import {
  DEFERRED_CLIP_PREFIX,
  parseClipboardPayload,
  parseInstallReferrer,
} from '../deferredDeepLink';

describe('parseClipboardPayload', () => {
  it('extrai um código válido com o prefixo canônico', () => {
    expect(parseClipboardPayload('goxl-ride:ABC234')).toBe('ABC234');
  });

  it('usa a constante exportada como prefixo', () => {
    expect(parseClipboardPayload(`${DEFERRED_CLIP_PREFIX}XYZ789`)).toBe('XYZ789');
  });

  it('normaliza caixa e espaços em volta', () => {
    expect(parseClipboardPayload('  goxl-ride:abc234  ')).toBe('ABC234');
  });

  it('rejeita conteúdo sem o prefixo', () => {
    expect(parseClipboardPayload('ABC234')).toBeNull();
    expect(parseClipboardPayload('https://goxl.app/qr?driver=ABC234')).toBeNull();
  });

  it('rejeita código com comprimento errado', () => {
    expect(parseClipboardPayload('goxl-ride:ABC23')).toBeNull();
    expect(parseClipboardPayload('goxl-ride:ABC2345')).toBeNull();
  });

  it('rejeita caracteres fora do charset (I, O, 0, 1)', () => {
    expect(parseClipboardPayload('goxl-ride:ABCI23')).toBeNull();
    expect(parseClipboardPayload('goxl-ride:ABO023')).toBeNull();
    expect(parseClipboardPayload('goxl-ride:ABC101')).toBeNull();
  });

  it('trata null/undefined/vazio como ausência de código', () => {
    expect(parseClipboardPayload(null)).toBeNull();
    expect(parseClipboardPayload(undefined)).toBeNull();
    expect(parseClipboardPayload('')).toBeNull();
    expect(parseClipboardPayload('goxl-ride:')).toBeNull();
  });
});

describe('parseInstallReferrer', () => {
  it('extrai goxl_driver de um referrer padrão', () => {
    expect(parseInstallReferrer('utm_source=goxl_qr&goxl_driver=ABC234')).toBe('ABC234');
  });

  it('aceita a chave alternativa driver', () => {
    expect(parseInstallReferrer('driver=XYZ789')).toBe('XYZ789');
  });

  it('decodifica referrer url-encoded', () => {
    expect(parseInstallReferrer('utm_source%3Dqr%26goxl_driver%3DABC234')).toBe('ABC234');
  });

  it('normaliza caixa', () => {
    expect(parseInstallReferrer('goxl_driver=abc234')).toBe('ABC234');
  });

  it('rejeita código inválido', () => {
    expect(parseInstallReferrer('goxl_driver=ABC1')).toBeNull();
    expect(parseInstallReferrer('goxl_driver=ABCI23')).toBeNull();
  });

  it('trata ausência de driver como null', () => {
    expect(parseInstallReferrer('utm_source=organic')).toBeNull();
    expect(parseInstallReferrer(null)).toBeNull();
    expect(parseInstallReferrer('')).toBeNull();
  });
});
