import {
  DRIVER_CODE_ALPHABET,
  DRIVER_CODE_RE,
  MAX_CODE_ATTEMPTS,
  codeFromId,
  normalizeDriverCode,
  resolveDriverCode,
} from '../driverCode';

// ESCOPO DESTE ARQUIVO: só a parte PURA de driverCode.ts (normalização e
// formato). `resolveDriverCode` fala com a Edge Function e com o Postgres —
// nada aqui prova comportamento de RLS, de rate limit ou da revogação de
// `anon` em `profiles_public`. Isso só se prova contra um banco real; os
// comandos estão no rodapé de supabase/migrations/0067.

describe('DRIVER_CODE_ALPHABET', () => {
  it('tem 32 símbolos e não contém I, O, 0 nem 1', () => {
    expect(DRIVER_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(DRIVER_CODE_ALPHABET).size).toBe(32);
    for (const ambiguous of ['I', 'O', '0', '1']) {
      expect(DRIVER_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('todo símbolo do alfabeto é aceito pelo regex canônico', () => {
    for (const ch of DRIVER_CODE_ALPHABET) {
      expect(DRIVER_CODE_RE.test(ch.repeat(6))).toBe(true);
    }
  });
});

describe('normalizeDriverCode', () => {
  it('aceita um código já canônico', () => {
    expect(normalizeDriverCode('ABC234')).toBe('ABC234');
  });

  it('normaliza caixa e espaços em volta', () => {
    expect(normalizeDriverCode('  abc234 ')).toBe('ABC234');
    expect(normalizeDriverCode('AbC234')).toBe('ABC234');
  });

  it('rejeita comprimento errado', () => {
    expect(normalizeDriverCode('ABC23')).toBeNull();
    expect(normalizeDriverCode('ABC2345')).toBeNull();
    expect(normalizeDriverCode('')).toBeNull();
  });

  it('rejeita os caracteres ambíguos fora do alfabeto (I, O, 0, 1)', () => {
    expect(normalizeDriverCode('ABCI23')).toBeNull();
    expect(normalizeDriverCode('ABCO23')).toBeNull();
    expect(normalizeDriverCode('ABC023')).toBeNull();
    expect(normalizeDriverCode('ABC123')).toBeNull();
  });

  it('rejeita nulo, indefinido e não-string', () => {
    expect(normalizeDriverCode(null)).toBeNull();
    expect(normalizeDriverCode(undefined)).toBeNull();
  });

  it('rejeita payload que tenta carregar mais do que um código', () => {
    // Nada aqui vira query — o lookup é por igualdade e roda com service_role
    // dentro da Edge Function — mas recusar cedo mantém a entrada minúscula e
    // previsível, e é o que impede lixo de consumir bucket de rate limit.
    expect(normalizeDriverCode("ABC234' or '1'='1")).toBeNull();
    expect(normalizeDriverCode('ABC234%')).toBeNull();
    expect(normalizeDriverCode('*')).toBeNull();
    expect(normalizeDriverCode('ABC 34')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// codeFromId — o lado ESCRITOR, que até a iteração 4 não tinha teste NENHUM
// ═══════════════════════════════════════════════════════════════════════════
//
// Esta é a única função que produz o valor gravado em `profiles.driver_code`.
// Ela ganhou um parâmetro (`attempt`) e mudou de arquivo por causa do índice
// único da migration 0069, e as duas afirmações que sustentam essa mudança
// nunca foram exercitadas:
//
//   (1) `attempt = 0` devolve EXATAMENTE o código de antes — ou seja, todo QR
//       já impresso continua resolvendo;
//   (2) tentativas diferentes produzem códigos diferentes, senão o laço de
//       retentativa de QRCodeScreen gira à toa contra o mesmo 23505.
//
// O QUE ESTES TESTES NÃO PROVAM: que o índice único existe, que o `update`
// devolve 23505, ou que o laço da tela reage certo — isso é Postgres e React,
// e nada disso executou aqui.

describe('codeFromId — compatibilidade com os QR já impressos', () => {
  // VETORES LEGADOS. Não foram calculados chamando `codeFromId`: saíram de uma
  // execução da versão ORIGINAL da função, transcrita literalmente de
  // `git show HEAD:src/screens/driver/QRCodeScreen.tsx` (que não tem parâmetro
  // `attempt` e usa sempre os bytes 0..5 com `byte % 32`). São literais aqui de
  // propósito — se fossem recalculados a partir do código sob teste, o teste
  // afirmaria a si mesmo e passaria mesmo que o algoritmo mudasse.
  const LEGACY: Array<[uuid: string, code: string]> = [
    ['00000000-0000-0000-0000-000000000000', 'AAAAAA'],
    ['ffffffff-ffff-ffff-ffff-ffffffffffff', '999999'],
    ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', '9FEARK'],
    ['c9bf9e57-1685-4c89-bafb-ff5af830be8a', 'K98ZYF'],
    ['1b4e28ba-2fa1-11d2-883f-0016d3cca427', '5QJ4RB'],
  ];

  it('attempt = 0 reproduz o código da versão anterior, caractere a caractere', () => {
    for (const [uuid, expected] of LEGACY) {
      expect(codeFromId(uuid)).toBe(expected);
      expect(codeFromId(uuid, 0)).toBe(expected);
    }
  });

  it('o padrão de attempt é 0 (um chamador sem o argumento não muda de código)', () => {
    // QRCodeScreen chama `codeFromId(driverId)` sem `attempt` no primeiro
    // caminho; se o padrão deixasse de ser 0, todo QR impresso deixaria de
    // resolver sem que nada mais quebrasse.
    const uuid = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';
    expect(codeFromId(uuid)).toBe(codeFromId(uuid, 0));
  });

  it('é determinístico e insensível aos hífens do UUID', () => {
    const withDashes = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(codeFromId(withDashes)).toBe(codeFromId(withDashes.replace(/-/g, '')));
    expect(codeFromId(withDashes)).toBe(codeFromId(withDashes));
  });
});

describe('codeFromId — o sal das retentativas', () => {
  // Amostra determinística (sem `Math.random`), para que uma falha seja
  // reproduzível. Um xorshift32 semeado pelo índice enche os 16 bytes — a
  // primeira versão deste helper multiplicava o índice por uma constante de 64
  // bits e zerava os 8 bytes MAIS ALTOS, que são justamente os que
  // `codeFromId(uuid, 0)` lê: os 500 UUIDs davam o mesmo código e o teste de
  // dispersão pegou isso.
  const SAMPLE = Array.from({ length: 500 }, (_, n) => {
    let state = (n + 1) * 0x9e3779b1 >>> 0;
    const next = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;  state >>>= 0;
      return state;
    };
    let hex = '';
    for (let i = 0; i < 4; i++) hex += next().toString(16).padStart(8, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });

  it('a amostra é bem-formada: 500 UUIDs distintos de 32 dígitos hex', () => {
    // Guarda contra o defeito que este helper já teve uma vez: se o gerador
    // degenerar, os testes abaixo passam a exercitar quase nada e ninguém vê.
    expect(SAMPLE).toHaveLength(500);
    expect(new Set(SAMPLE).size).toBe(500);
    for (const uuid of SAMPLE) expect(uuid.replace(/-/g, '')).toMatch(/^[0-9a-f]{32}$/);
    // Os 6 primeiros bytes são os que `attempt = 0` lê: precisam variar.
    expect(new Set(SAMPLE.map((u) => u.replace(/-/g, '').slice(0, 12))).size).toBe(500);
  });

  it('produz sempre 6 caracteres DO ALFABETO CANÔNICO, em toda tentativa', () => {
    // Esta é a propriedade que amarra o escritor ao servidor: se `codeFromId`
    // emitisse um símbolo fora do alfabeto, `SERVER_DRIVER_CODE_RE` recusaria o
    // código na Edge Function e o QR desse motorista nunca resolveria.
    for (const uuid of SAMPLE) {
      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        const code = codeFromId(uuid, attempt);
        expect(code).toHaveLength(6);
        expect(DRIVER_CODE_RE.test(code)).toBe(true);
        for (const ch of code) expect(DRIVER_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('as 8 tentativas de um mesmo UUID são distintas nesta amostra', () => {
    // HONESTIDADE SOBRE O QUE ISTO É: uma AMOSTRA de 500 UUIDs, não uma prova.
    // `codeFromId` tem 32^6 saídas, então duas tentativas colidirem é
    // improvável (~1 em 1,07 bilhão por par), não impossível — não existe nada
    // na construção que impeça. Se colidirem, o custo é uma tentativa gasta à
    // toa: o `update` bate no mesmo 23505 e o laço de QRCodeScreen segue para a
    // próxima. Ou seja, este teste protege a EFICIÊNCIA da retentativa, não uma
    // garantia de correção.
    for (const uuid of SAMPLE) {
      const codes = new Set(
        Array.from({ length: MAX_CODE_ATTEMPTS }, (_, a) => codeFromId(uuid, a)),
      );
      expect(codes.size).toBe(MAX_CODE_ATTEMPTS);
    }
  });

  it('UUIDs diferentes com o mesmo attempt tendem a códigos diferentes', () => {
    // NÃO é unicidade — a função descarta ~98 bits e colidir é inevitável em
    // escala (é literalmente o motivo do índice único da 0069). O que se afirma
    // aqui é só que a amostra não degenera num código constante.
    const codes = new Set(SAMPLE.map((uuid) => codeFromId(uuid, 0)));
    expect(codes.size).toBeGreaterThan(SAMPLE.length * 0.9);
  });

  it('MAX_CODE_ATTEMPTS é 8 e é o mesmo valor que a tela usa', () => {
    // A constante saiu de QRCodeScreen para cá justamente para que o laço da
    // tela e o teste do sal não pudessem discordar.
    expect(MAX_CODE_ATTEMPTS).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveDriverCode — a DECISÃO, não a rede
// ─────────────────────────────────────────────────────────────────────────────
//
// O que se prova aqui é o mapeamento resposta → `DriverCodeLookup`, que é o que
// decide se a tela tem direito de dizer "código inválido". Continua valendo o
// escopo do topo: nada aqui prova RLS, rate limit real ou a Edge Function.
//
// A chamada entra INJETADA (`PublicEdgeCaller`), e não por `jest.mock`. Não é
// preferência: `jest.mock('../edgeFunction')` não resolve nada aqui, porque o
// que quebra é o `await import()` do próprio `driverCode.ts` — dentro do
// jest-expo ele lança "A dynamic import callback was invoked without
// --experimental-vm-modules" ANTES de olhar para qualquer mock. Com mock, os
// quatro casos abaixo caíam todos no `catch` e o arquivo "passava" afirmando
// `unavailable` para tudo, inclusive para o caminho feliz. Descoberto tentando
// escrever exatamente estes testes.

type Lookup = { status: string; driver?: unknown };
type Caller = <T>(name: string, body: Record<string, unknown>) => Promise<T>;

/** Caller que devolve sempre a mesma resposta e registra o que recebeu. */
function callerReturning(json: unknown) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const call = (async (name: string, body: Record<string, unknown>) => {
    calls.push({ name, body });
    return json;
  }) as Caller;
  return { call, calls };
}

describe('resolveDriverCode', () => {
  it('código malformado nem chega a chamar a função', async () => {
    const { call, calls } = callerReturning({ driver: { id: 'u1', full_name: 'Ana' } });
    await expect(resolveDriverCode('abc', call) as Promise<Lookup>).resolves.toEqual({
      status: 'not_found',
    });
    expect(calls).toHaveLength(0);
  });

  it('200 com driver resolve para ok e manda o código já normalizado', async () => {
    const { call, calls } = callerReturning({ driver: { id: 'u1', full_name: 'Ana' } });
    await expect(resolveDriverCode('  abc234 ', call) as Promise<Lookup>).resolves.toEqual({
      status: 'ok',
      driver: { id: 'u1', full_name: 'Ana' },
    });
    expect(calls).toEqual([{ name: 'resolve-driver-code', body: { driver_code: 'ABC234' } }]);
  });

  it('200 com driver:null é not_found — é o veredito do servidor', async () => {
    const { call } = callerReturning({ driver: null });
    await expect(resolveDriverCode('ABC234', call) as Promise<Lookup>).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('resposta com driver sem id é not_found', async () => {
    const { call } = callerReturning({ driver: { full_name: 'Ana' } });
    await expect(resolveDriverCode('ABC234', call) as Promise<Lookup>).resolves.toEqual({
      status: 'not_found',
    });
  });

  it('driver sem full_name resolve para ok com nome vazio', async () => {
    const { call } = callerReturning({ driver: { id: 'u1' } });
    await expect(resolveDriverCode('ABC234', call) as Promise<Lookup>).resolves.toEqual({
      status: 'ok',
      driver: { id: 'u1', full_name: '' },
    });
  });

  it('429, 503, 5xx e falha de rede são unavailable, NUNCA not_found', async () => {
    // Este é o teste que impede a volta do defeito: qualquer um destes fazia a
    // tela do Cadastro Expresso dizer "Código inválido — peça um novo ao
    // motorista" para um QR perfeito, na frente do motorista.
    const failures = [
      Object.assign(new Error('Too many requests'), { status: 429, code: 'RATE_LIMITED' }),
      Object.assign(new Error('Service unavailable'), { status: 503, code: 'RATE_LIMIT_UNAVAILABLE' }),
      Object.assign(new Error('boom'), { status: 500 }),
      new Error('Network request failed'),
    ];
    for (const failure of failures) {
      const call = (async () => { throw failure; }) as Caller;
      await expect(resolveDriverCode('ABC234', call) as Promise<Lookup>).resolves.toEqual({
        status: 'unavailable',
      });
    }
  });
});
