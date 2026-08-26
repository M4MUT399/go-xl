// Espelho Deno da regra de elegibilidade de oferta de corrida.
//
// FONTE ÚNICA: o código vive em `src/lib/rideDispatch.ts` (canônico, coberto
// pelos testes e usado pelo app do motorista no caminho realtime). Este arquivo
// apenas RE-EXPORTA aquele módulo para o runtime Deno, do mesmo jeito que
// `_shared/dispatchEngine.ts` — e pelo mesmo motivo: a regra não pode existir em
// duas cópias que divirjam, senão o push e o card do motorista discordam sobre
// quem podia receber a corrida.
export * from '../../../src/lib/rideDispatch.ts';
