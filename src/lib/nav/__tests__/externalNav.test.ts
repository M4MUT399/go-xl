import {
  buildAllExternalNavLinks,
  buildExternalNavLinks,
  isNavigableCoord,
  EXTERNAL_NAV_APPS,
} from '../externalNav';

/**
 * AS URLs DE NAVEGAÇÃO EXTERNA.
 *
 * Cada URL esperada abaixo está escrita à mão, caractere por caractere. Não se
 * monta a expectativa com template string nem se reusa nada de externalNav.ts —
 * um teste que remontasse a URL com a mesma fórmula do código passaria com o
 * esquema errado e não provaria nada. Se alguém trocar `daddr` por `destination`
 * no esquema do Google Maps, ou perder o `&navigate=yes` do Waze, é aqui que
 * quebra.
 *
 * Coordenadas usadas: Orlando International Airport (28.4312, -81.3081) e
 * São Paulo (-23.5505, -46.6333), digitadas de fontes públicas.
 */

describe('buildExternalNavLinks — Google Maps', () => {
  const links = buildExternalNavLinks('googleMaps', { lat: 28.4312, lng: -81.3081 });

  it('no iOS, monta o esquema comgooglemaps com daddr e modo de direção', () => {
    expect(links?.appUrl.ios).toBe('comgooglemaps://?daddr=28.4312,-81.3081&directionsmode=driving');
  });

  it('no Android, monta google.navigation — comgooglemaps é esquema de iPhone', () => {
    // O app Android do Google Maps não registra `comgooglemaps://`. Se esta
    // linha voltar a dizer `comgooglemaps`, o canOpenURL do Android responde
    // false, o toque cai no https e o motorista ganha uma PRÉVIA de rota em
    // vez de navegação iniciada.
    expect(links?.appUrl.android).toBe('google.navigation:q=28.4312,-81.3081&mode=d');
  });

  it('as duas plataformas não compartilham a mesma URL de esquema', () => {
    expect(links?.appUrl.ios).not.toBe(links?.appUrl.android);
    expect(links?.appUrl.android).not.toContain('comgooglemaps');
  });

  it('monta a URL web da API de direções', () => {
    expect(links?.webUrl).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=28.4312,-81.3081&travelmode=driving',
    );
  });

  it('leva o nome próprio do app, sem tradução', () => {
    expect(links?.name).toBe('Google Maps');
    expect(links?.app).toBe('googleMaps');
  });
});

describe('buildExternalNavLinks — Waze', () => {
  const links = buildExternalNavLinks('waze', { lat: 28.4312, lng: -81.3081 });

  it('monta o esquema do app com ll e navigate', () => {
    expect(links?.appUrl.ios).toBe('waze://?ll=28.4312,-81.3081&navigate=yes');
  });

  it('usa o MESMO esquema no Android — waze:// é registrado nas duas lojas', () => {
    expect(links?.appUrl.android).toBe('waze://?ll=28.4312,-81.3081&navigate=yes');
  });

  it('monta a URL web equivalente', () => {
    expect(links?.webUrl).toBe('https://waze.com/ul?ll=28.4312,-81.3081&navigate=yes');
  });

  it('leva o nome próprio do app', () => {
    expect(links?.name).toBe('Waze');
  });
});

describe('formatação da coordenada', () => {
  it('preserva o sinal do hemisfério sul e oeste', () => {
    expect(buildExternalNavLinks('waze', { lat: -23.5505, lng: -46.6333 })?.appUrl.ios).toBe(
      'waze://?ll=-23.5505,-46.6333&navigate=yes',
    );
  });

  it('não deixa lixo de ponto flutuante vazar para a URL', () => {
    // 0.1 + 0.2 === 0.30000000000000004 em IEEE-754. A URL tem que dizer 0.3.
    expect(buildExternalNavLinks('waze', { lat: 0.1 + 0.2, lng: -46.6333 })?.appUrl.ios).toBe(
      'waze://?ll=0.3,-46.6333&navigate=yes',
    );
  });

  it('corta na sexta casa decimal (≈11 cm), sem notação científica', () => {
    expect(buildExternalNavLinks('waze', { lat: 28.43121234567, lng: -81.30819876543 })?.appUrl.ios).toBe(
      'waze://?ll=28.431212,-81.308199&navigate=yes',
    );
  });

  it('aceita latitude zero exata quando a longitude não é zero', () => {
    // Só (0,0) é lixo de GPS; o equador em Gabão é um lugar real.
    expect(buildExternalNavLinks('waze', { lat: 0, lng: 12.34 })?.appUrl.ios).toBe(
      'waze://?ll=0,12.34&navigate=yes',
    );
  });
});

describe('coordenada imprestável não vira URL', () => {
  const ruins: Array<[string, { lat: unknown; lng: unknown }]> = [
    ['lat nula', { lat: null, lng: -81.3081 }],
    ['lng nula', { lat: 28.4312, lng: null }],
    ['lat indefinida', { lat: undefined, lng: -81.3081 }],
    ['NaN', { lat: NaN, lng: -81.3081 }],
    ['Infinity', { lat: 28.4312, lng: Infinity }],
    ['latitude fora da faixa', { lat: 91, lng: -81.3081 }],
    ['longitude fora da faixa', { lat: 28.4312, lng: 181 }],
    ['Null Island (0,0)', { lat: 0, lng: 0 }],
    ['string em vez de número', { lat: '28.4312', lng: '-81.3081' }],
  ];

  it.each(ruins)('%s → null nos dois apps', (_nome, ponto) => {
    const p = ponto as { lat: number; lng: number };
    expect(buildExternalNavLinks('googleMaps', p)).toBeNull();
    expect(buildExternalNavLinks('waze', p)).toBeNull();
    expect(buildAllExternalNavLinks(p)).toEqual([]);
  });

  it('ponto ausente → null', () => {
    expect(buildExternalNavLinks('waze', null)).toBeNull();
    expect(buildExternalNavLinks('waze', undefined)).toBeNull();
    expect(buildAllExternalNavLinks(null)).toEqual([]);
  });

  it('isNavigableCoord reprova (0,0) e aprova um ponto real', () => {
    expect(isNavigableCoord(0, 0)).toBe(false);
    expect(isNavigableCoord(28.4312, -81.3081)).toBe(true);
  });
});

describe('rótulo do ponto', () => {
  it('vem normalizado (trim) fora da URL', () => {
    const links = buildExternalNavLinks('waze', {
      lat: 28.4312,
      lng: -81.3081,
      label: '  9 Terminal Dr, Orlando  ',
    });
    expect(links?.label).toBe('9 Terminal Dr, Orlando');
  });

  it('NÃO entra na URL — endereço em daddr/ll faria o app buscar texto em vez de navegar ao ponto', () => {
    const links = buildExternalNavLinks('googleMaps', {
      lat: 28.4312,
      lng: -81.3081,
      label: '9 Terminal Dr, Orlando',
    });
    expect(links?.appUrl.ios).toBe('comgooglemaps://?daddr=28.4312,-81.3081&directionsmode=driving');
    expect(links?.appUrl.android).toBe('google.navigation:q=28.4312,-81.3081&mode=d');
    expect(links?.webUrl).not.toContain('Terminal');
  });

  it('rótulo vazio ou só espaços vira null', () => {
    expect(buildExternalNavLinks('waze', { lat: 28.4312, lng: -81.3081, label: '   ' })?.label).toBeNull();
    expect(buildExternalNavLinks('waze', { lat: 28.4312, lng: -81.3081 })?.label).toBeNull();
  });
});

describe('lista de apps', () => {
  it('Google Maps vem antes do Waze', () => {
    expect(EXTERNAL_NAV_APPS).toEqual(['googleMaps', 'waze']);
    expect(buildAllExternalNavLinks({ lat: 28.4312, lng: -81.3081 }).map((l) => l.name)).toEqual([
      'Google Maps',
      'Waze',
    ]);
  });
});
