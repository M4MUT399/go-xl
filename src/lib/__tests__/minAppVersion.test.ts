import {
  TRAVA_DESLIGADA,
  compararVersoes,
  lerConfigTrava,
  precisaAtualizar,
  textoDaTrava,
  versaoValida,
  type TextoTrava,
} from '../minAppVersion';

/**
 * ESTE TESTE EXISTE POR CAUSA DE UM APARELHO REAL.
 *
 * Em 02/09/2026 um Motorola em campo estava na 1.0.0. O mapa dele aparecia em
 * branco (chave do Maps revogada desde 11/08), mas o custo escondido era outro:
 * `charge-ride` cobra `rides.price` como o cliente gravou, então um passageiro
 * em build velha precifica pela tabela velha e o servidor cobra menos, calado.
 *
 * A armadilha número um de qualquer trava de versão é comparar como TEXTO. Nós
 * acabamos de atravessar 1.0.9 → 1.0.10, a transição exata em que '1.0.10' <
 * '1.0.9' na ordem alfabética. Metade dos testes abaixo é sobre isso.
 */

const RESERVA: TextoTrava = { titulo: 'T', corpo: 'C', botao: 'B' };

describe('compararVersoes compara número, não texto', () => {
  // O caso que motivou tudo. Como string, '1.0.10' < '1.0.9'.
  it('1.0.10 é POSTERIOR a 1.0.9', () => {
    expect(compararVersoes('1.0.10', '1.0.9')).toBe(1);
    expect(compararVersoes('1.0.9', '1.0.10')).toBe(-1);
  });

  it('1.0.0 é anterior a 1.0.10', () => {
    expect(compararVersoes('1.0.0', '1.0.10')).toBe(-1);
  });

  it('versões iguais dão 0', () => {
    expect(compararVersoes('1.0.10', '1.0.10')).toBe(0);
  });

  it('segmento ausente vale zero: 1.0 == 1.0.0', () => {
    expect(compararVersoes('1.0', '1.0.0')).toBe(0);
    expect(compararVersoes('1', '1.0.0')).toBe(0);
  });

  it('compara o major antes do minor', () => {
    expect(compararVersoes('2.0.0', '1.99.99')).toBe(1);
  });

  // Não publicamos pré-lançamento nas lojas; tratar como igual evita inventar
  // uma ordenação que ninguém usa.
  it('sufixo não numérico é ignorado no segmento', () => {
    expect(compararVersoes('1.0.0-beta', '1.0.0')).toBe(0);
  });

  it('lixo vira zero em vez de NaN', () => {
    expect(compararVersoes('abc', '0.0.0')).toBe(0);
  });
});

describe('versaoValida', () => {
  it.each(['1.0.0', '1', '0.0.1'])('aceita %p', (v) => {
    expect(versaoValida(v)).toBe(true);
  });

  it.each([null, undefined, '', '   ', 'sem numero'])('recusa %p', (v) => {
    expect(versaoValida(v as string | null | undefined)).toBe(false);
  });
});

describe('precisaAtualizar', () => {
  it('bloqueia a 1.0.0 quando o mínimo é 1.0.10', () => {
    expect(precisaAtualizar('1.0.0', '1.0.10')).toBe(true);
  });

  it('não bloqueia quem está exatamente no mínimo', () => {
    expect(precisaAtualizar('1.0.10', '1.0.10')).toBe(false);
  });

  it('não bloqueia quem está à frente', () => {
    expect(precisaAtualizar('1.1.0', '1.0.10')).toBe(false);
  });

  // FALHA PARA O LADO ABERTO. Um cliente que não sabe a própria versão não pode
  // se auto-emparedar: quem tem dentes é o trigger da 0081, no servidor.
  it.each([null, undefined, ''])('não bloqueia com versão atual %p', (v) => {
    expect(precisaAtualizar(v as string | null | undefined, '1.0.10')).toBe(false);
  });

  it.each([null, undefined, '', 'qualquer'])('não bloqueia com mínimo ilegível %p', (v) => {
    expect(precisaAtualizar('1.0.0', v as string | null | undefined)).toBe(false);
  });
});

describe('lerConfigTrava normaliza jsonb torto', () => {
  it('objeto vazio vira a trava desligada', () => {
    expect(lerConfigTrava({})).toEqual(TRAVA_DESLIGADA);
  });

  it.each([null, undefined, 42, 'texto'])('entrada %p vira a trava desligada', (v) => {
    const c = lerConfigTrava(v);
    expect(c.min).toBe('0.0.0');
    expect(c.enforceServer).toBe(false);
  });

  // O padrão '0.0.0' nunca bloqueia ninguém — é o estado inerte.
  it('a trava desligada não bloqueia nem a 1.0.0', () => {
    expect(precisaAtualizar('1.0.0', TRAVA_DESLIGADA.min)).toBe(false);
  });

  it('lê os campos quando vêm certos', () => {
    const c = lerConfigTrava({
      min: '1.0.10',
      enforceServer: true,
      store: { android: 'a', ios: 'i' },
      message: { pt: { titulo: 't', corpo: 'c', botao: 'b' } },
    });
    expect(c.min).toBe('1.0.10');
    expect(c.enforceServer).toBe(true);
    expect(c.store).toEqual({ android: 'a', ios: 'i' });
  });

  // `enforceServer` só liga com o booleano true. String 'true' vinda de um
  // jsonb mal digitado NÃO pode ligar a recusa no servidor por acidente.
  it.each(['true', 1, 'sim', {}])('enforceServer não liga com %p', (v) => {
    expect(lerConfigTrava({ enforceServer: v }).enforceServer).toBe(false);
  });

  it('URL de loja vazia cai no padrão em vez de virar link quebrado', () => {
    const c = lerConfigTrava({ store: { android: '', ios: null } });
    expect(c.store.android).toBe(TRAVA_DESLIGADA.store.android);
    expect(c.store.ios).toBe(TRAVA_DESLIGADA.store.ios);
  });
});

describe('textoDaTrava', () => {
  const cfg = lerConfigTrava({
    message: {
      en: { titulo: 'Update required', corpo: 'Please update.', botao: 'Update' },
      pt: { titulo: 'Atualize', corpo: 'Atualize o app.', botao: 'Atualizar' },
    },
  });

  it('usa o idioma pedido', () => {
    expect(textoDaTrava(cfg, 'pt', RESERVA).titulo).toBe('Atualize');
  });

  // Espanhol não foi preenchido na config: cai no inglês, que é o padrão
  // oficial do app (i18n/index.tsx), não no reserva embutido.
  it('cai no inglês quando o idioma não foi preenchido', () => {
    expect(textoDaTrava(cfg, 'es', RESERVA).titulo).toBe('Update required');
  });

  it('cai no reserva quando a config não tem texto nenhum', () => {
    expect(textoDaTrava(TRAVA_DESLIGADA, 'pt', RESERVA)).toEqual(RESERVA);
  });

  it('campo em branco na config não apaga o reserva', () => {
    const vazio = lerConfigTrava({ message: { pt: { titulo: '  ', corpo: '', botao: 'Ir' } } });
    const t = textoDaTrava(vazio, 'pt', RESERVA);
    expect(t.titulo).toBe(RESERVA.titulo);
    expect(t.corpo).toBe(RESERVA.corpo);
    expect(t.botao).toBe('Ir');
  });
});
