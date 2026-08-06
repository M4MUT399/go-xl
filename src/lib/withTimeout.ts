/**
 * Envolve qualquer Promise (fetch, chamada do Supabase, etc.) com um timeout.
 *
 * Por quê: o fetch do React Native NÃO tem timeout nativo, e o client do
 * Supabase (auth, storage, query builder) também pode ficar pendurado
 * indefinidamente em rede ruim ou instável — isso já causou telas de
 * "carregando" travadas para sempre (ver AddCardOnboardingScreen.tsx).
 * Este helper generaliza aquele padrão para qualquer chamada assíncrona.
 *
 * Se o timeout estourar, rejeita com um erro tratável (para o chamador cair
 * em `catch`/`finally` e liberar o loading) em vez de deixar a Promise presa.
 */
export function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  timeoutMessage = 'Tempo esgotado. Verifique sua conexão e tente novamente.'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
