// Configuração de testes do Go XL (jest-expo). Foco inicial: testes unitários
// de lógica pura (config dinâmica, auditoria de ofertas, pricing). O preset
// jest-expo cuida da transformação de RN/Expo; os testes de lib mockam o
// Supabase para não carregar módulos nativos.
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  clearMocks: true,
};
