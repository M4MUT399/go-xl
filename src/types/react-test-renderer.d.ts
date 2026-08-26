/**
 * `react-test-renderer` chega aqui como dependência TRANSITIVA de `jest-expo`
 * (não está em `package.json`) e não traz tipos próprios. `@types/react-test-
 * renderer` também não está instalado — e não vale instalar: os tipos
 * publicados descrevem a API do React 18, enquanto o repo roda React 19.1.
 *
 * Declarado aqui só o que os testes de fato usam, de propósito. Uma declaração
 * `declare module 'react-test-renderer';` seca tornaria o módulo `any` e
 * apagaria a checagem justamente nos arquivos que existem para provar timing de
 * render — que é onde um `any` custa mais caro.
 *
 * Se um bump do Expo remover a dependência transitiva, os testes param de
 * resolver; o conserto é adicioná-la explicitamente a devDependencies, não
 * apagar os testes nem alargar esta declaração.
 */
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  /**
   * `props` fica em `unknown` de propósito: os props de um nó qualquer da
   * árvore são dinâmicos mesmo, e tipá-los como `any` deixaria `onPress()`
   * passar num nó que NÃO tem `onPress` — que é justamente o engano capaz de
   * fazer um teste de tela dar verde sem ter tocado em nada. Quem chama
   * precisa estreitar, e o erro aparece na compilação.
   */
  export interface ReactTestInstance {
    props: Record<string, unknown>;
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
    findAllByType(type: unknown): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    unmount(): void;
    update(element: ReactElement): void;
    toJSON(): unknown;
  }

  export function create(element: ReactElement): ReactTestRenderer;

  export function act(callback: () => Promise<void>): Promise<void>;
  export function act(callback: () => void): void;
}
