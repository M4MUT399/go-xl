import {
  SERVER_DRIVER_CODE_ALPHABET,
  SERVER_DRIVER_CODE_RE,
  SHARED_FALLBACK_ALERT_RATIO,
  SHARED_FALLBACK_BUCKET,
  TRUSTED_PROXY_HOPS,
  bucketSourceFromHeaders,
  createBucketKindTelemetry,
  normalizeServerDriverCode,
  trustSingleValueHeadersFromEnv,
} from '../guard';
import { DRIVER_CODE_ALPHABET, codeFromId } from '../../../../src/lib/driverCode';

// ESCOPO: só a parte PURA da fronteira de `resolve-driver-code`. Nada aqui
// prova que o rate limit conta, que a RLS fecha, nem o que o gateway faz com
// `X-Forwarded-For` — isso exigiria Postgres e a função implantada, e os
// comandos estão no rodapé de index.ts. Nenhum teste abaixo mocka o código sob
// teste: todos chamam as funções de verdade.
//
// O que os testes de `src/lib/__tests__/driverCode.test.ts` cobrem é o regex do
// CLIENT. Um atacante nunca passa pelo client, então o regex do SERVIDOR
// precisava dos seus próprios testes — é o buraco que este arquivo fecha.

describe('SERVER_DRIVER_CODE_RE — o servidor não pode ser mais frouxo que o client', () => {
  it('usa o MESMO alfabeto canônico que o client (a duplicação não pode divergir)', () => {
    expect(SERVER_DRIVER_CODE_ALPHABET).toBe(DRIVER_CODE_ALPHABET);
    expect(SERVER_DRIVER_CODE_ALPHABET).toHaveLength(32);
  });

  it('aceita TODO código que o ESCRITOR real produz, em toda tentativa', () => {
    // O buraco da iteração 3: este arquivo comparava guard.ts com
    // driverCode.ts, e nenhum dos dois com `codeFromId` — a função que de fato
    // GRAVA `profiles.driver_code`. Ela tinha a própria cópia do alfabeto, numa
    // tela que o Jest não conseguia importar. Se essa cópia divergisse, o
    // servidor passaria a recusar códigos reais e o QR do motorista pararia de
    // resolver, sem nenhum teste vermelho.
    //
    // `codeFromId` agora mora em `src/lib/driverCode.ts` e usa a MESMA
    // constante que o client. Esta asserção fecha o triângulo: escritor →
    // regex do servidor.
    const uuids = [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'c9bf9e57-1685-4c89-bafb-ff5af830be8a',
      '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    ];
    for (const uuid of uuids) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const written = codeFromId(uuid, attempt);
        expect(SERVER_DRIVER_CODE_RE.test(written)).toBe(true);
        expect(normalizeServerDriverCode(written)).toBe(written);
      }
    }
  });

  it('aceita todo símbolo do alfabeto canônico', () => {
    for (const ch of SERVER_DRIVER_CODE_ALPHABET) {
      expect(SERVER_DRIVER_CODE_RE.test(ch.repeat(6))).toBe(true);
    }
  });

  it('REJEITA I, O, 0 e 1 — que o regex antigo `^[A-Z0-9]{6}$` aceitava', () => {
    // Este é o defeito nomeado. Os quatro caracteres não existem em
    // `codeFromId`, logo nenhum código real os contém: aceitá-los só dava a um
    // enumerador 36^6 = 2,18 bi de tentativas em vez de 32^6 = 1,07 bi, e cada
    // uma delas custava um SELECT.
    expect(normalizeServerDriverCode('ABCI23')).toBeNull();
    expect(normalizeServerDriverCode('ABCO23')).toBeNull();
    expect(normalizeServerDriverCode('ABC023')).toBeNull();
    expect(normalizeServerDriverCode('ABC123')).toBeNull();
    // Prova explícita de que o regex ANTIGO teria deixado passar:
    expect(/^[A-Z0-9]{6}$/.test('ABCI23')).toBe(true);
  });
});

describe('normalizeServerDriverCode', () => {
  it('aceita e normaliza caixa e espaços', () => {
    expect(normalizeServerDriverCode('ABC234')).toBe('ABC234');
    expect(normalizeServerDriverCode('  abc234 ')).toBe('ABC234');
  });

  it('rejeita comprimento errado', () => {
    expect(normalizeServerDriverCode('ABC23')).toBeNull();
    expect(normalizeServerDriverCode('ABC2345')).toBeNull();
    expect(normalizeServerDriverCode('')).toBeNull();
  });

  it('rejeita tipo não-string sem estourar', () => {
    // O corpo é JSON de origem não confiável: `driver_code` pode chegar como
    // objeto, array ou número. A versão anterior fazia `typeof === 'string'`
    // fora daqui; concentrar a checagem no módulo é o que o torna a fronteira.
    expect(normalizeServerDriverCode(undefined)).toBeNull();
    expect(normalizeServerDriverCode(null)).toBeNull();
    expect(normalizeServerDriverCode(123456)).toBeNull();
    expect(normalizeServerDriverCode({ toUpperCase: () => 'ABC234' })).toBeNull();
    expect(normalizeServerDriverCode(['ABC234'])).toBeNull();
  });

  it('rejeita payload que tenta carregar mais do que um código', () => {
    expect(normalizeServerDriverCode("ABC234' or '1'='1")).toBeNull();
    expect(normalizeServerDriverCode('ABC234%')).toBeNull();
    expect(normalizeServerDriverCode('ABC 34')).toBeNull();
  });
});

/** Helper: monta o `getHeader` do módulo a partir de um objeto simples. */
function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return (name: string) => lower[name.toLowerCase()] ?? null;
}

describe('bucketSourceFromHeaders — a chave do rate limit não pode ser escolhida pelo chamador', () => {
  it('IGNORA o elemento mais à esquerda de X-Forwarded-For (o defeito P0)', () => {
    // Cenário do ataque: o atacante manda um XFF aleatório por requisição; o
    // gateway apenda o IP real dele à DIREITA. Lendo da esquerda, cada
    // requisição virava um bucket novo e o limite nunca disparava.
    const a = bucketSourceFromHeaders(headers({ 'x-forwarded-for': '203.0.113.1, 198.51.100.7' }));
    const b = bucketSourceFromHeaders(headers({ 'x-forwarded-for': '203.0.113.2, 198.51.100.7' }));
    const c = bucketSourceFromHeaders(headers({ 'x-forwarded-for': '10.0.0.9, 198.51.100.7' }));

    // Valor literal — não recalculado a partir do código sob teste.
    expect(a.value).toBe('198.51.100.7');
    expect(a.value).toBe(b.value);
    expect(b.value).toBe(c.value);
    expect(a.kind).toBe('xff-trusted-hop');
  });

  it('acerta também quando o gateway SOBRESCREVE o header (lista de 1)', () => {
    const s = bucketSourceFromHeaders(headers({ 'x-forwarded-for': '198.51.100.7' }));
    expect(s.value).toBe('198.51.100.7');
    expect(s.kind).toBe('xff-trusted-hop');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // O DEFEITO DA ITERAÇÃO 3, e o teste que o defendia
  //
  // A versão anterior consultava `cf-connecting-ip` / `x-real-ip` ANTES do XFF
  // e confiava neles se apenas SE PARECESSEM com um IP. Isso não fechava o P0,
  // mudava ele de header: os dois são texto que o chamador escreve, igual ao
  // elemento mais à esquerda do XFF. `-H 'X-Real-IP: 198.51.100.<n>'` dava um
  // bucket novo por requisição e anulava `:short` (8/min) e `:long` (60/h).
  //
  // Havia um teste chamado "prefere um header de valor único quando ele
  // existe", que fixava essa precedência como comportamento DESEJADO — a suíte
  // defendia o defeito. Ele foi substituído pelos três abaixo.
  // ───────────────────────────────────────────────────────────────────────────

  it('IGNORA x-real-ip por padrão, mesmo sendo um IP válido', () => {
    const s = bucketSourceFromHeaders(headers({ 'x-real-ip': '198.51.100.7' }));
    expect(s.kind).toBe('shared-fallback');
    expect(s.value).toBe(SHARED_FALLBACK_BUCKET);
  });

  it('x-real-ip forjado por requisição NÃO produz buckets distintos (o ataque)', () => {
    // Exatamente o `curl` do relatório: um X-Real-IP aleatório por requisição.
    // Antes, três valores → três buckets → limite nulo. Agora, um só balde.
    const a = bucketSourceFromHeaders(headers({ 'x-real-ip': '198.51.100.1' }));
    const b = bucketSourceFromHeaders(headers({ 'x-real-ip': '198.51.100.2' }));
    const c = bucketSourceFromHeaders(headers({ 'cf-connecting-ip': '198.51.100.3' }));
    expect(a.value).toBe(b.value);
    expect(b.value).toBe(c.value);
    expect(a.value).toBe(SHARED_FALLBACK_BUCKET);
  });

  it('o XFF ancorado à direita tem PRECEDÊNCIA sobre os headers de valor único', () => {
    // Mesmo com o caminho religado, o header de valor único é o ÚLTIMO recurso.
    // Antes era o primeiro, e o curto-circuito passava por cima de toda a
    // ancoragem à direita — 40 linhas de dúvida sobre o XFF, descartadas por um
    // header que o código não questionava.
    const s = bucketSourceFromHeaders(
      headers({ 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '198.51.100.7' }),
      { trustSingleValueHeaders: true },
    );
    expect(s.value).toBe('198.51.100.7');
    expect(s.kind).toBe('xff-trusted-hop');
  });

  it('religado por opção explícita, o header de valor único vale — mas só aí', () => {
    const off = bucketSourceFromHeaders(headers({ 'cf-connecting-ip': '198.51.100.7' }));
    expect(off.kind).toBe('shared-fallback');

    const on = bucketSourceFromHeaders(
      headers({ 'cf-connecting-ip': '198.51.100.7' }),
      { trustSingleValueHeaders: true },
    );
    expect(on.value).toBe('198.51.100.7');
    expect(on.kind).toBe('single-header');
    expect(on.header).toBe('cf-connecting-ip');
  });

  it('mesmo religado, lixo no header de valor único não vira bucket próprio', () => {
    const s = bucketSourceFromHeaders(
      headers({ 'cf-connecting-ip': 'bucket-' + 'x'.repeat(20) }),
      { trustSingleValueHeaders: true },
    );
    expect(s.value).toBe(SHARED_FALLBACK_BUCKET);
    expect(s.kind).toBe('shared-fallback');
  });

  it('degrada para o bucket COMPARTILHADO (mais estrito) sem header nenhum', () => {
    const s = bucketSourceFromHeaders(headers({}));
    expect(s.value).toBe(SHARED_FALLBACK_BUCKET);
    expect(s.kind).toBe('shared-fallback');
    expect(s.header).toBeNull();
  });

  it('degrada para o compartilhado quando o elemento confiável não é um IP', () => {
    // `X-Forwarded-For: unknown` é legal e comum. Criar um bucket com o texto
    // "unknown" seria inofensivo; criar um com texto ARBITRÁRIO do atacante
    // não. A regra é a mesma nos dois casos: sem IP, bucket compartilhado.
    expect(bucketSourceFromHeaders(headers({ 'x-forwarded-for': 'unknown' })).kind)
      .toBe('shared-fallback');
    expect(bucketSourceFromHeaders(headers({ 'x-forwarded-for': 'a, b, evil-bucket-key' })).kind)
      .toBe('shared-fallback');
  });

  it('com 2 saltos confiáveis, lê o penúltimo e descarta o resto', () => {
    const s = bucketSourceFromHeaders(
      headers({ 'x-forwarded-for': '203.0.113.1, 198.51.100.7, 192.0.2.5' }),
      { trustedHops: 2 },
    );
    expect(s.value).toBe('198.51.100.7');
  });

  it('lista mais CURTA que os saltos supostos → compartilhado, nunca o primeiro', () => {
    // Se a lista não tem os saltos que supomos, o header não passou por eles.
    // A resposta segura é limitar em conjunto, não confiar no que sobrou.
    const s = bucketSourceFromHeaders(
      headers({ 'x-forwarded-for': '203.0.113.1' }),
      { trustedHops: 2 },
    );
    expect(s.value).toBe(SHARED_FALLBACK_BUCKET);
  });

  it('normaliza porta e colchetes para o mesmo bucket', () => {
    expect(bucketSourceFromHeaders(headers({ 'x-forwarded-for': '198.51.100.7:44321' })).value)
      .toBe('198.51.100.7');
    expect(bucketSourceFromHeaders(headers({ 'x-forwarded-for': '[2001:db8::1]:443' })).value)
      .toBe('2001:db8::1');
  });

  it('o padrão de saltos confiáveis é 1', () => {
    expect(TRUSTED_PROXY_HOPS).toBe(1);
  });
});

describe('trustSingleValueHeadersFromEnv — o padrão é DESLIGADO', () => {
  it('sem variável de ambiente, não confia', () => {
    // O caso que importa: uma função implantada sem ninguém configurar nada
    // NÃO pode acabar confiando num header forjável. Ausente = desligado.
    expect(trustSingleValueHeadersFromEnv(undefined)).toBe(false);
    expect(trustSingleValueHeadersFromEnv(null)).toBe(false);
    expect(trustSingleValueHeadersFromEnv('')).toBe(false);
    expect(trustSingleValueHeadersFromEnv('   ')).toBe(false);
  });

  it('só "1" e "true" ligam', () => {
    expect(trustSingleValueHeadersFromEnv('1')).toBe(true);
    expect(trustSingleValueHeadersFromEnv('true')).toBe(true);
    expect(trustSingleValueHeadersFromEnv('TRUE')).toBe(true);
    expect(trustSingleValueHeadersFromEnv(' true ')).toBe(true);
  });

  it('valor ambíguo NÃO liga — um erro de digitação não afrouxa o controle', () => {
    for (const raw of ['0', 'false', 'no', 'yes', 'on', 'sim', 'null', '2', 'maybe']) {
      expect(trustSingleValueHeadersFromEnv(raw)).toBe(false);
    }
  });
});

describe('createBucketKindTelemetry — a fração que MEDE a suposição de headers', () => {
  it('não emite nada antes de fechar a amostra', () => {
    const t = createBucketKindTelemetry(4);
    expect(t.record('xff-trusted-hop')).toBeNull();
    expect(t.record('xff-trusted-hop')).toBeNull();
    expect(t.record('xff-trusted-hop')).toBeNull();
    expect(t.record('xff-trusted-hop')).not.toBeNull();
  });

  it('conta por tipo e calcula a fração de shared-fallback', () => {
    const t = createBucketKindTelemetry(4);
    t.record('xff-trusted-hop');
    t.record('xff-trusted-hop');
    t.record('shared-fallback');
    const report = t.record('shared-fallback');

    expect(report).not.toBeNull();
    expect(report!.sample).toBe(4);
    expect(report!.counts['xff-trusted-hop']).toBe(2);
    expect(report!.counts['shared-fallback']).toBe(2);
    expect(report!.counts['single-header']).toBe(0);
    expect(report!.sharedFallbackRatio).toBe(0.5);
  });

  it('alerta quando o fallback domina — que é o sinal de "a suposição está errada"', () => {
    // Se metade ou mais do tráfego não tem origem identificável, as janelas por
    // origem não estão limitando ninguém em particular, e `TRUSTED_PROXY_HOPS`
    // está descrevendo um gateway que não é o real.
    const t = createBucketKindTelemetry(4);
    t.record('shared-fallback');
    t.record('shared-fallback');
    t.record('xff-trusted-hop');
    expect(t.record('xff-trusted-hop')!.alert).toBe(true);

    const quiet = createBucketKindTelemetry(4);
    quiet.record('shared-fallback');
    quiet.record('xff-trusted-hop');
    quiet.record('xff-trusted-hop');
    expect(quiet.record('xff-trusted-hop')!.alert).toBe(false);
  });

  it('o limiar de alerta é 0,5 e a amostra reinicia depois de cada relatório', () => {
    expect(SHARED_FALLBACK_ALERT_RATIO).toBe(0.5);

    const t = createBucketKindTelemetry(2);
    t.record('shared-fallback');
    expect(t.record('shared-fallback')!.sharedFallbackRatio).toBe(1);
    // Sem reinício, o segundo relatório herdaria a contagem do primeiro e a
    // fração ficaria travada em 1 para sempre.
    t.record('xff-trusted-hop');
    const second = t.record('xff-trusted-hop')!;
    expect(second.sample).toBe(2);
    expect(second.sharedFallbackRatio).toBe(0);
    expect(second.alert).toBe(false);
  });
});
