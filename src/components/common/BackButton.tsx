import React from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';

/**
 * BackButton — o "← Voltar" das telas de perfil.
 *
 * ── POR QUE VIROU COMPONENTE ───────────────────────────────────────────────
 *
 * Cinco telas de perfil repetiam o MESMO par de estilos copiado
 * (`back` + `backText`), e já tinham começado a divergir: a PaymentScreen
 * seguiu outro caminho e ficou com alvo de 40×40 enquanto as demais não
 * tinham padding nenhum. Estilo copiado cinco vezes só fica igual até a
 * primeira vez que alguém mexe em quatro.
 *
 * ── O DEFEITO QUE ISTO CONSERTA ────────────────────────────────────────────
 *
 * O botão antigo era `{ marginBottom: 20, alignSelf: 'flex-start' }` com texto
 * de 15 px — e mais nada. Sem padding, a área tocável era EXATAMENTE o
 * desenho do texto: uma faixa de ~18 px de altura. O dedo erra isso com
 * facilidade, principalmente com o celular na mão dentro do carro.
 *
 * Agora o texto tem 23 px (50% maior, como pedido) e o alvo cresce por
 * padding de verdade, não pela fonte: são ~47 px de altura tocável, acima do
 * mínimo de 44 pt que a Apple recomenda e dos 48 dp do Material.
 *
 * `hitSlop` vai junto porque padding empurra o layout vizinho e hitSlop não —
 * ele estende a área sensível para fora do desenho, de graça.
 */

/** 15 px × 1,5. O pedido foi "50% maior". */
const TAMANHO_TEXTO = 23;

type Props = {
  onPress: () => void;
  /** Identificador para teste; o padrão serve às telas de perfil. */
  testID?: string;
};

export function BackButton({ onPress, testID = 'backButton' }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={styles.botao}
      hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
      accessibilityRole="button"
      accessibilityLabel={t('common.back')}
    >
      <Text style={[styles.texto, { color: colors.primary }]}>← {t('common.back')}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  botao: {
    alignSelf: 'flex-start',
    // `marginTop` é o "um pouco mais para baixo" do pedido: as telas põem o
    // botão como PRIMEIRO filho de um ScrollView com padding 24, colado no
    // topo da área segura. Em aparelho com recorte de câmera isso fica perto
    // demais da borda.
    marginTop: 8,
    marginBottom: 20,
    // O alvo vem daqui, não do tamanho da fonte: 12 + ~23 + 12 ≈ 47 px.
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  texto: {
    fontSize: TAMANHO_TEXTO,
    fontWeight: '600',
  },
});
