import { decideStatusRevert, type StatusWriteOutcome } from '../driverOnlineStatus';

const base: StatusWriteOutcome = {
  requested: true,
  returned: true,
  failed: false,
  userInitiated: true,
};

describe('decideStatusRevert', () => {
  it('escrita aceita e confirmada: não mexe em nada', () => {
    expect(decideStatusRevert(base)).toEqual({
      revertTo: null,
      syncFailed: false,
      reason: 'ok',
    });
  });

  // ── Defeito 1: a recusa silenciosa do trigger da 0038 ────────────────────
  // O trigger faz `new.is_online := false` e o upsert retorna SUCESSO. Quem
  // olhar só `error` conclui que deu certo. Este é o caso real do motorista
  // sem Stripe Connect aprovado que ficava "Online" sem receber corrida.
  it('servidor devolve false para um pedido de true: reverte e denuncia', () => {
    const d = decideStatusRevert({ ...base, requested: true, returned: false });
    expect(d.revertTo).toBe(false);
    expect(d.syncFailed).toBe(true);
    expect(d.reason).toBe('refused');
  });

  it('a recusa é detectada mesmo SEM erro — é o ponto todo', () => {
    const d = decideStatusRevert({ ...base, requested: true, returned: false, failed: false });
    expect(d.reason).toBe('refused');
  });

  it('a recusa vale também no heartbeat, não só no toque', () => {
    // O valor do servidor é a verdade venha de onde vier: se o banco diz
    // offline, mostrar "Online" é mentira independentemente de quem escreveu.
    const d = decideStatusRevert({
      ...base,
      requested: true,
      returned: false,
      userInitiated: false,
    });
    expect(d.revertTo).toBe(false);
    expect(d.reason).toBe('refused');
  });

  // ── Defeito 2: reversão no heartbeat de abertura ─────────────────────────
  it('falha de rede NO TOQUE: reverte a chave, porque o toque não valeu', () => {
    const d = decideStatusRevert({ ...base, requested: true, returned: null, failed: true });
    expect(d.revertTo).toBe(false);
    expect(d.syncFailed).toBe(true);
    expect(d.reason).toBe('transport');
  });

  it('falha de rede NO HEARTBEAT: NÃO inverte a chave', () => {
    // O bug concreto: motorista OFFLINE abre o app sem rede. O heartbeat grava
    // `false`, falha, e a versão anterior fazia `setIsOnline(!false)` = true,
    // persistindo "Online" entre sessões sem ninguém ter tocado na chave.
    const d = decideStatusRevert({
      requested: false,
      returned: null,
      failed: true,
      userInitiated: false,
    });
    expect(d.revertTo).toBeNull();
    expect(d.syncFailed).toBe(true);
  });

  it('falha no heartbeat estando ONLINE: avisa, mas não desliga sozinho', () => {
    const d = decideStatusRevert({
      requested: true,
      returned: null,
      failed: true,
      userInitiated: false,
    });
    expect(d.revertTo).toBeNull();
    // O aviso importa: o motorista acha que está recebendo corridas e o
    // servidor pode não saber que ele está online.
    expect(d.syncFailed).toBe(true);
  });

  it('escrita ok mas sem leitura de volta: não inventa falha', () => {
    const d = decideStatusRevert({ ...base, returned: null, failed: false });
    expect(d).toEqual({ revertTo: null, syncFailed: false, reason: 'unknown' });
  });

  it('nunca reverte para o mesmo valor que foi pedido', () => {
    // Invariante: uma reversão que devolve o valor pedido não corrige nada e
    // ainda re-dispara o efeito de escrita — era assim que nascia o loop.
    for (const requested of [false, true]) {
      for (const returned of [false, true, null]) {
        for (const failed of [false, true]) {
          for (const userInitiated of [false, true]) {
            const d = decideStatusRevert({ requested, returned, failed, userInitiated });
            if (d.revertTo !== null) expect(d.revertTo).not.toBe(requested);
          }
        }
      }
    }
  });

  it('syncFailed implica que algo de fato deu errado', () => {
    for (const requested of [false, true]) {
      for (const returned of [false, true, null]) {
        for (const userInitiated of [false, true]) {
          const d = decideStatusRevert({ requested, returned, failed: false, userInitiated });
          // Sem erro de transporte, só a divergência de valor justifica o aviso.
          if (d.syncFailed) expect(returned).toBe(!requested);
        }
      }
    }
  });
});
