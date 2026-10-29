import { execFileSync } from 'child_process';
import path from 'path';
import { PISO_MS, TETO_MS } from '../../src/lib/splashTimeline';

/**
 * O OTA NÃO PODE SEGURAR A INICIALIZAÇÃO.
 *
 * ── O QUE ESTE TESTE PROTEGE ───────────────────────────────────────────────
 *
 * `expo-updates` sabe bloquear o cold start esperando baixar um bundle novo: é
 * o que `updates.fallbackToCacheTimeout` faz quando é maior que zero. Numa
 * conexão ruim, esse tempo entra POR BAIXO do orçamento da abertura de marca
 * (src/lib/splashTimeline.ts), e o motorista vê a marca parada esperando rede
 * — pior no estacionamento do MCO, sinal fraco, que é onde ele mais abre o app.
 *
 * O valor 0 é o default da biblioteca, e é justamente por isso que ele precisa
 * de teste: um default não avisa quando alguém o sobrescreve. A auditoria de
 * 03/09/2026 apontou que o comentário em app.config.js chamava esses valores de
 * "requisito" sem nada trancando — comentário não é trava.
 *
 * ── NÃO É CIRCULAR ─────────────────────────────────────────────────────────
 *
 * Não lê o literal do app.config.js. Roda `expo config --type public`, que é o
 * mesmo pipeline que produz a configuração usada na build, e afirma sobre o
 * resultado RESOLVIDO.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

function configResolvida(): Record<string, any> {
  const saida = execFileSync('npx', ['expo', 'config', '--type', 'public', '--json'], {
    cwd: RAIZ,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(saida);
}

describe('a atualização por OTA não entra no orçamento da abertura', () => {
  let config: Record<string, any>;
  beforeAll(() => { config = configResolvida(); }, 120_000);

  it('a config resolvida é mesmo a deste app', () => {
    // Sanidade: sem isto, as asserções seguintes poderiam passar por vacuidade.
    expect(config.slug).toBe('go-xl');
  });

  it('o OTA está ligado — senão não há o que proteger, nem o que entregar', () => {
    expect(config.updates?.enabled).toBe(true);
    expect(String(config.updates?.url ?? '')).toContain('u.expo.dev');
  });

  // ESTE é o número que importa. Qualquer valor acima de zero faz o app esperar
  // a rede antes de desenhar o primeiro quadro.
  it('fallbackToCacheTimeout é ZERO: o app nunca espera a rede para abrir', () => {
    expect(config.updates?.fallbackToCacheTimeout).toBe(0);
  });

  it('o orçamento da abertura continua sendo o que este teste supõe', () => {
    // Asserção sobre o VALOR, não sobre o sinal. `toBeGreaterThan(0)` deixaria
    // o piso cair de 3450 para 1 e continuaria verde — exatamente o que este
    // comentário promete impedir. Se alguém mudar estes números, o risco de um
    // download bloqueante muda de tamanho e este teste precisa ser RELIDO, não
    // só continuar passando.
    expect(PISO_MS).toBe(3450);
    expect(TETO_MS).toBe(8000);
  });

  it('o runtimeVersion é por fingerprint, como fingerprint.config.js documenta', () => {
    expect(config.runtimeVersion).toEqual({ policy: 'fingerprint' });
  });
});
