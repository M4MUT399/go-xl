// Espelho Deno do núcleo puro do motor de dispatch.
//
// FONTE ÚNICA: o código vive em `src/lib/dispatchEngine.ts` (canônico, coberto
// pelos testes). Este arquivo apenas RE-EXPORTA aquele módulo para o runtime
// Deno das Edge Functions. Como `dispatchEngine.ts` é 100% puro (sem imports de
// React/Supabase/RN), o bundler do Supabase CLI o resolve sem problema.
//
// `supabase/functions` está fora do `include` do tsconfig do app, então esta
// ponte não afeta o typecheck/bundle do cliente — e o motor não fica duplicado.
export * from '../../../src/lib/dispatchEngine.ts';
