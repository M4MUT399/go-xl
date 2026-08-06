import { Asset } from 'expo-asset';

/**
 * Pré-carrega a logo GoXL usada em `CarMarker` (marcador de motorista no mapa).
 *
 * Por quê: o `<Marker>` do react-native-maps "fotografa" (rasteriza) seu
 * conteúdo customizado nativamente. Se a `<Image>` da logo ainda não tiver
 * sido decodificada quando o marcador é fotografado (janela de
 * `tracksViewChanges`, ver HomeScreen/DriverHomeScreen/ActiveRideScreen),
 * o marcador fica "congelado" mostrando o ícone padrão do mapa (um carrinho
 * genérico) em vez do círculo dourado com a logo — foi o que o usuário
 * relatou ver em produção. Chamando isso o quanto antes (no `App.tsx`, antes
 * de qualquer mapa montar), a imagem já está em cache/decodificada quando o
 * primeiro marcador aparece, eliminando essa corrida.
 */
export function preloadDriverMarkerAssets() {
  Asset.loadAsync(require('../../assets/icon.png')).catch(() => {
    // Best-effort: se falhar, o marcador ainda funciona — só corre o risco
    // de precisar de mais uma janela de tracksViewChanges para pegar a imagem.
  });
}
