// `serviceAuth.test.ts` prova que `isServiceRoleCaller` está CORRETO. Este
// arquivo prova outra coisa, que nenhum teste de unidade consegue provar: que
// as Edge Functions REALMENTE o usam.
//
// A distinção importa porque o buraco original não era um bug na função de
// autorização — era o `atob` do claim `role` escrito inline em cada função. Um
// helper impecável que ninguém importa não fecha buraco nenhum. Então aqui a
// asserção é sobre o CÓDIGO-FONTE das funções, no mesmo espírito de
// src/lib/__tests__/dispatchCronGate.test.ts (que lê a migration em vez de
// transcrever o SQL à mão).
//
// A PENDÊNCIA FOI FECHADA EM 06/09/2026, e o mecanismo funcionou como escrito.
// `run-weekly-payouts` era a última função a decodificar o claim; ao trocá-la
// por `isServiceRoleCaller`, a lista encolheu e ESTE teste ficou vermelho
// sozinho, pedindo para ser atualizado — que é metade do desenho:
//   • alguém adiciona um `atob` de claim novo   → a lista cresce, falha;
//   • alguém conserta a última pendência        → a lista encolhe, falha
//                                                 pedindo pra tirar daqui.
//
// A lista está VAZIA e é assim que ela deve permanecer. Não volte a preenchê-la
// para "destravar" um teste: cada nome aqui é uma função em que qualquer pessoa
// dispara a operação sem credencial nenhuma quando `verify_jwt = false` — no
// caso do run-weekly-payouts, o REPASSE SEMANAL INTEIRO, que era o estado em
// produção até esta data.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const FUNCTIONS_DIR = join(__dirname, '..', '..');

/** Funções que AINDA autorizam lendo o claim `role` do JWT sem verificar
 *  assinatura. Meta atingida em 06/09/2026: lista vazia. */
const PENDENCIAS_CONHECIDAS: string[] = [];

function edgeFunctionDirs(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .filter((name) => existsSync(join(FUNCTIONS_DIR, name, 'index.ts')))
    .sort();
}

function fonte(fn: string): string {
  return readFileSync(join(FUNCTIONS_DIR, fn, 'index.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
}

describe('adoção de _shared/serviceAuth nas Edge Functions', () => {
  it('encontra as Edge Functions no disco (o teste não está vazio à toa)', () => {
    expect(edgeFunctionDirs().length).toBeGreaterThan(10);
  });

  it('nenhuma função nova autoriza decodificando o claim `role` do JWT', () => {
    const comClaimDecodificado = edgeFunctionDirs().filter((fn) =>
      /role\s*===\s*['"]service_role['"]/.test(fonte(fn)),
    );
    expect(comClaimDecodificado.sort()).toEqual([...PENDENCIAS_CONHECIDAS].sort());
  });

  it('admin-telematics-export autoriza a via cron pela chave, não pelo claim', () => {
    const src = fonte('admin-telematics-export');
    expect(src).toContain("from '../_shared/serviceAuth.ts'");
    expect(src).toMatch(/isServiceRoleCaller\(\s*authHeader\s*,\s*SUPABASE_SERVICE_KEY\s*\)/);
    expect(src).not.toContain('atob(');
  });

  it('quem importa isServiceRoleCaller passa a CHAVE, não o token decodificado', () => {
    // Um `isServiceRoleCaller(header, header)` compilaria e passaria sempre.
    // O segundo argumento tem que ser a chave lida do ambiente.
    const usuarios = edgeFunctionDirs().filter((fn) => fonte(fn).includes('isServiceRoleCaller('));
    expect(usuarios.length).toBeGreaterThan(0);

    for (const fn of usuarios) {
      // Um nível de parênteses aninhado é necessário: a chamada real passa
      // `req.headers.get('Authorization')` como primeiro argumento, e um
      // `[^)]*` pararia no `)` do `get(...)`, lendo só metade dos argumentos.
      const chamadas = [...fonte(fn).matchAll(/isServiceRoleCaller\(((?:[^()]|\([^()]*\))*)\)/g)];
      expect(chamadas.length).toBeGreaterThan(0);
      for (const [, args] of chamadas) {
        expect(args).toMatch(/SERVICE_(ROLE_)?KEY/);
      }
    }
  });
});
