import { extractRevokedRideId, OFFER_REVOKED_TYPE } from '../backgroundRevocation';

// extractRevokedRideId varre um payload de push recebido EM BACKGROUND e devolve
// o rideId revogado quando o payload se declara `type:'offer_revoked'`. Como o
// formato entregue à task NÃO é estável entre plataformas/versões, os testes
// exercitam cada forma conhecida em que o `{ type, rideId }` pode aparecer.

describe('extractRevokedRideId', () => {
  it('acha no topo do payload (formato plano)', () => {
    expect(
      extractRevokedRideId({ type: OFFER_REVOKED_TYPE, rideId: 'ride-1' })
    ).toBe('ride-1');
  });

  it('aceita a variante snake_case ride_id', () => {
    expect(
      extractRevokedRideId({ type: OFFER_REVOKED_TYPE, ride_id: 'ride-2' })
    ).toBe('ride-2');
  });

  it('acha dentro de notification.request.content.data (objeto Notification do Expo)', () => {
    const payload = {
      notification: {
        request: {
          content: {
            data: { type: OFFER_REVOKED_TYPE, rideId: 'ride-3' },
          },
        },
      },
    };
    expect(extractRevokedRideId(payload)).toBe('ride-3');
  });

  it('acha dentro de data aninhado (FCM data-only no Android)', () => {
    expect(
      extractRevokedRideId({ data: { type: OFFER_REVOKED_TYPE, rideId: 'ride-4' } })
    ).toBe('ride-4');
  });

  it('abre data entregue como STRING JSON', () => {
    const payload = {
      data: JSON.stringify({ type: OFFER_REVOKED_TYPE, rideId: 'ride-5' }),
    };
    expect(extractRevokedRideId(payload)).toBe('ride-5');
  });

  it('abre dataString (chave alternativa de transporte)', () => {
    const payload = {
      dataString: JSON.stringify({ type: OFFER_REVOKED_TYPE, ride_id: 'ride-6' }),
    };
    expect(extractRevokedRideId(payload)).toBe('ride-6');
  });

  it('abre body como JSON string quando o payload chega serializado', () => {
    const payload = {
      body: JSON.stringify({ type: OFFER_REVOKED_TYPE, rideId: 'ride-7' }),
    };
    expect(extractRevokedRideId(payload)).toBe('ride-7');
  });

  it('devolve null para outro tipo de push (não é revogação)', () => {
    expect(
      extractRevokedRideId({ type: 'new_ride', rideId: 'ride-8' })
    ).toBeNull();
  });

  it('devolve null quando é revogação mas sem rideId', () => {
    expect(extractRevokedRideId({ type: OFFER_REVOKED_TYPE })).toBeNull();
  });

  it('devolve null para rideId vazio', () => {
    expect(
      extractRevokedRideId({ type: OFFER_REVOKED_TYPE, rideId: '' })
    ).toBeNull();
  });

  it('devolve null para rideId não-string', () => {
    expect(
      extractRevokedRideId({ type: OFFER_REVOKED_TYPE, rideId: 123 })
    ).toBeNull();
  });

  it.each([null, undefined, 'string solta', 42, true])(
    'devolve null para payload não-objeto (%p)',
    (input) => {
      expect(extractRevokedRideId(input)).toBeNull();
    }
  );

  it('não estoura em string JSON inválida', () => {
    expect(
      extractRevokedRideId({ data: '{ isto não é json' })
    ).toBeNull();
  });

  it('não entra em loop infinito com referência cíclica', () => {
    const cyclic: Record<string, unknown> = { foo: 'bar' };
    cyclic.self = cyclic;
    expect(extractRevokedRideId(cyclic)).toBeNull();
  });

  it('ignora nós além da profundidade máxima (payload gigante/aninhado)', () => {
    // 8 níveis de aninhamento — além do MAX_DEPTH (6) — não deve ser alcançado.
    let deep: Record<string, unknown> = {
      type: OFFER_REVOKED_TYPE,
      rideId: 'ride-deep',
    };
    for (let i = 0; i < 8; i++) deep = { nested: deep };
    expect(extractRevokedRideId(deep)).toBeNull();
  });

  it('acha o rideId em profundidade rasa dentro do limite', () => {
    const payload = { a: { b: { type: OFFER_REVOKED_TYPE, rideId: 'ride-ok' } } };
    expect(extractRevokedRideId(payload)).toBe('ride-ok');
  });
});
