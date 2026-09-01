// nav/openExternalNav — a camada SUJA da navegação externa: fala com o sistema
// operacional. Toda a montagem de URL fica em nav/externalNav.ts (pura).
//
// A sequência é sempre a mesma: pergunta se o esquema do app abre; se abre,
// abre; senão, cai para o https. O fallback não é decoração — é o que salva o
// caso em que o iOS mente por falta de declaração no Info.plist (ver
// LSApplicationQueriesSchemes em app.config.js): `canOpenURL('waze://')`
// devolve false COM O WAZE INSTALADO, e o https://waze.com/ul ainda é
// capturado pelo app via universal link. Sem o fallback, uma build sem a
// declaração deixaria o motorista sem nenhum dos dois caminhos. No Android
// 11+ a armadilha é a mesma com outro nome — `<queries>` no AndroidManifest
// (ver plugins/externalNavQueries.js).

import { Linking, Platform } from 'react-native';
import {
  buildExternalNavLinks,
  type ExternalNavApp,
  type ExternalNavPlatform,
  type ExternalNavPoint,
} from './externalNav';

/**
 * Em que plataforma o esquema vai ser aberto.
 *
 * Existe porque Google Maps de iOS e de Android não atendem pelo mesmo
 * esquema (ver o comentário de `appUrl` em externalNav.ts). Fica aqui, e não
 * no módulo puro, para `externalNav.ts` continuar sem nenhum import de
 * react-native. O `web` cai em 'ios' de propósito: no navegador nenhum
 * esquema abre, `canOpenURL` responde false e o https assume — qualquer um
 * dos dois daria no mesmo, e não vale um terceiro ramo.
 */
export function currentNavPlatform(): ExternalNavPlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

/**
 * O pedaço do `Linking` que interessa aqui. Existe para o teste poder passar
 * um dublê e exercitar os quatro desfechos sem simulador nem apps instalados.
 */
export interface UrlOpener {
  canOpenURL(url: string): Promise<boolean>;
  openURL(url: string): Promise<unknown>;
}

export type ExternalNavOutcome =
  | 'app' // abriu pelo esquema (app instalado e consultável)
  | 'web' // abriu pelo https (universal link ou navegador)
  | 'invalid' // coordenada imprestável — nada foi aberto
  | 'failed'; // nem o https abriu

/**
 * Abre a navegação até `point` no app escolhido. Nunca lança: o desfecho volta
 * no retorno para quem chamou decidir se avisa o motorista.
 *
 * `platform` é parâmetro (e não leitura direta de `Platform.OS` lá dentro)
 * para o teste exercitar o ramo Android com um literal, sem mockar módulo
 * nativo — o jest deste repo roda tudo como iOS.
 */
export async function openExternalNav(
  app: ExternalNavApp,
  point: ExternalNavPoint | null | undefined,
  opener: UrlOpener = Linking,
  platform: ExternalNavPlatform = currentNavPlatform(),
): Promise<ExternalNavOutcome> {
  const links = buildExternalNavLinks(app, point);
  if (!links) return 'invalid';

  const appUrl = links.appUrl[platform];

  try {
    if (await opener.canOpenURL(appUrl)) {
      await opener.openURL(appUrl);
      return 'app';
    }
  } catch {
    // O esquema não pôde ser consultado ou recusou abrir. Não é motivo para
    // desistir — o https abaixo cobre exatamente esse caso.
  }

  try {
    await opener.openURL(links.webUrl);
    return 'web';
  } catch {
    return 'failed';
  }
}
