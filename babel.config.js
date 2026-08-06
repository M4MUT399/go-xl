// babel-preset-expo já é o preset padrão aplicado pelo Metro no Expo SDK 54;
// declará-lo explicitamente aqui é um no-op para o bundle do app, mas é o que
// permite o Jest (jest-expo) transformar TS/JSX nos testes.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
