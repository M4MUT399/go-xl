import React, { useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Alert } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { startCheckout } from '../../lib/payments';
import { formatCurrency } from '../../lib/format';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Payment'> };

const TEST_AMOUNT = 15.0;

export function PaymentScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(false);
  const [paid, setPaid] = useState(false);

  async function handleTestPayment() {
    setLoading(true);
    const result = await startCheckout(TEST_AMOUNT, 'Pagamento de teste — Go XL');
    setLoading(false);

    if (result.status === 'error') {
      Alert.alert('Erro no pagamento', result.error ?? 'Tente novamente.');
    } else if (result.status === 'completed') {
      setPaid(true);
    }
  }

  // Tela de sucesso estilizada no padrão da abertura do app
  if (paid) {
    return (
      <SafeAreaView style={styles.successContainer}>
        <View style={styles.successHero}>
          <View style={styles.checkCircle}>
            <Text style={styles.checkMark}>✓</Text>
          </View>
          <Text style={styles.successTitle}>Pagamento{'\n'}concluído!</Text>
          <Text style={styles.successAmount}>{formatCurrency(TEST_AMOUNT)}</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>✦ Executive XL</Text>
          </View>
          <Text style={styles.successSub}>
            Seu pagamento de teste foi processado com sucesso pela Stripe.
          </Text>
        </View>
        <View style={styles.successFooter}>
          <Button title="Concluir" onPress={() => navigation.goBack()} style={styles.fullBtn} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Voltar</Text>
      </TouchableOpacity>

      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Text style={{ fontSize: 40 }}>💳</Text>
        </View>
        <Text style={styles.title}>Pagamento</Text>
        <Text style={styles.badgeLight}>Modo de teste</Text>
        <Text style={styles.text}>
          Pagamentos em dólar (US$) via Stripe. Use um cartão de teste do Stripe, como
          4242 4242 4242 4242, qualquer data futura e qualquer CVC.
        </Text>

        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>Pagamento de teste</Text>
          <Text style={styles.amountValue}>{formatCurrency(TEST_AMOUNT)}</Text>
        </View>

        <Button
          title="Pagar com Stripe (teste)"
          onPress={handleTestPayment}
          loading={loading}
          style={styles.payBtn}
        />
        <Text style={styles.note}>
          O pagamento abre em uma página segura do Stripe. Ao concluir, feche o navegador
          para voltar ao app.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white, padding: 24 },
  back: { alignSelf: 'flex-start' },
  backText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 24, fontWeight: '800', color: Colors.primary, marginBottom: 8 },
  badgeLight: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 16,
  },
  text: { fontSize: 14, color: Colors.gray[500], textAlign: 'center', lineHeight: 21, marginBottom: 24 },
  amountCard: {
    width: '100%',
    backgroundColor: Colors.offWhite,
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
  },
  amountLabel: { fontSize: 13, color: Colors.gray[500] },
  amountValue: { fontSize: 32, fontWeight: '900', color: Colors.primary, marginTop: 4 },
  payBtn: { width: '100%' },
  note: { fontSize: 12, color: Colors.gray[400], textAlign: 'center', marginTop: 16, lineHeight: 18 },

  // Tela de sucesso (padrão da abertura)
  successContainer: { flex: 1, backgroundColor: Colors.primary },
  successHero: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  checkCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 32,
  },
  checkMark: { fontSize: 64, fontWeight: '900', color: Colors.primary, lineHeight: 70 },
  successTitle: {
    fontSize: 48,
    fontWeight: '900',
    color: Colors.white,
    textAlign: 'center',
    letterSpacing: -1,
    lineHeight: 54,
    marginBottom: 12,
  },
  successAmount: { fontSize: 40, fontWeight: '900', color: Colors.accent, letterSpacing: -1, marginBottom: 20 },
  badge: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginBottom: 24,
  },
  badgeText: { color: Colors.accent, fontSize: 13, fontWeight: '600', letterSpacing: 1 },
  successSub: {
    fontSize: 16,
    color: Colors.gray[300],
    textAlign: 'center',
    lineHeight: 24,
  },
  successFooter: { paddingHorizontal: 24, paddingBottom: 32 },
  fullBtn: { width: '100%' },
});
