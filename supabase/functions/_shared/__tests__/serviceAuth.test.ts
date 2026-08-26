// Testes da autorização de service_role (_shared/serviceAuth.ts).
//
// O que se prova aqui: dado um header `Authorization` e uma chave, a função
// decide certo — inclusive nos casos que ABRIAM a porta antes (JWT forjado com
// `{"role":"service_role"}` no payload, que o `atob` da versão anterior aceitava
// sem conferir assinatura nenhuma).
//
// O que NÃO se prova aqui: que a função de fato roda com `--no-verify-jwt`
// desligado, que o gateway do Supabase se comporta como descrito, ou que o
// `timingSafeEqual` é resistente a um ataque de tempo de verdade — isso exige
// medição, e medir tempo em Jest produz número, não prova. O que o teste cobre
// da comparação é a CORREÇÃO (aceita igual, recusa diferente), não a constância.
//
// Não-circularidade: as entradas são strings literais escritas à mão e as
// asserções são booleanos literais. Nada aqui chama a função para conferir o
// retorno dela mesma.

import { bearerToken, isServiceRoleCaller, timingSafeEqual } from '../serviceAuth';

describe('timingSafeEqual — igualdade correta antes de constante', () => {
  test('strings idênticas casam', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  test('diferença em qualquer posição recusa', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'zbc')).toBe(false);
  });

  test('comprimentos diferentes recusam, inclusive prefixo', () => {
    // O prefixo é o caso perigoso: uma comparação ingênua que percorre só o
    // menor dos dois aceitaria 'abc' como 'abcdef'.
    expect(timingSafeEqual('abc', 'abcdef')).toBe(false);
    expect(timingSafeEqual('abcdef', 'abc')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  test('não estoura com string longa contra vazia', () => {
    expect(timingSafeEqual('x'.repeat(500), '')).toBe(false);
  });
});

describe('bearerToken — extração do header', () => {
  test('remove o prefixo Bearer em qualquer caixa', () => {
    expect(bearerToken('Bearer tok')).toBe('tok');
    expect(bearerToken('bearer tok')).toBe('tok');
    expect(bearerToken('BEARER tok')).toBe('tok');
  });

  test('header sem prefixo devolve o valor cru', () => {
    expect(bearerToken('tok')).toBe('tok');
  });

  test('ausência de header vira string vazia, não exceção', () => {
    expect(bearerToken(null)).toBe('');
    expect(bearerToken(undefined)).toBe('');
    expect(bearerToken('   ')).toBe('');
  });
});

describe('isServiceRoleCaller — o buraco que o atob deixava', () => {
  const KEY = 'sk_service_role_valor_secreto_de_teste';

  test('a chave de serviço correta entra', () => {
    expect(isServiceRoleCaller(`Bearer ${KEY}`, KEY)).toBe(true);
  });

  test('JWT FORJADO com role service_role no payload é RECUSADO', () => {
    // Este é o ataque literal: três segmentos, o do meio decodificando para
    // `{"role":"service_role"}`, assinatura lixo. A versão anterior fazia
    // `atob` do payload, lia `role` e deixava passar — até 100 estornos não
    // autenticados por POST.
    const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64');
    const forjado = `x.${payload}.x`;

    expect(isServiceRoleCaller(`Bearer ${forjado}`, KEY)).toBe(false);
  });

  test('JWT legítimo de um usuário comum também é recusado', () => {
    // Um passageiro autenticado tem um JWT válido. Ele não é service_role.
    const payload = Buffer.from(
      JSON.stringify({ role: 'authenticated', sub: 'algum-uuid' }),
    ).toString('base64');
    expect(isServiceRoleCaller(`Bearer x.${payload}.x`, KEY)).toBe(false);
  });

  test('chave de serviço AUSENTE no ambiente nega TODO mundo', () => {
    // Falha fechada. Se a variável não subiu, ninguém entra — nem quem manda
    // string vazia, que é o que a comparação veria do outro lado.
    expect(isServiceRoleCaller('Bearer qualquer', '')).toBe(false);
    expect(isServiceRoleCaller('Bearer qualquer', null)).toBe(false);
    expect(isServiceRoleCaller('Bearer qualquer', undefined)).toBe(false);
    expect(isServiceRoleCaller('Bearer ', '')).toBe(false);
    expect(isServiceRoleCaller(null, null)).toBe(false);
  });

  test('sem header não entra', () => {
    expect(isServiceRoleCaller(null, KEY)).toBe(false);
    expect(isServiceRoleCaller(undefined, KEY)).toBe(false);
    expect(isServiceRoleCaller('', KEY)).toBe(false);
    expect(isServiceRoleCaller('Bearer    ', KEY)).toBe(false);
  });

  test('chave quase certa não entra', () => {
    expect(isServiceRoleCaller(`Bearer ${KEY}x`, KEY)).toBe(false);
    expect(isServiceRoleCaller(`Bearer ${KEY.slice(0, -1)}`, KEY)).toBe(false);
    expect(isServiceRoleCaller(`Bearer ${KEY.toUpperCase()}`, KEY)).toBe(false);
  });

  test('espaço em volta da chave do ambiente não quebra a comparação', () => {
    // `Deno.env.get` já trouxe valor com \n em produção mais de uma vez.
    expect(isServiceRoleCaller(`Bearer ${KEY}`, `  ${KEY}\n`)).toBe(true);
  });
});
