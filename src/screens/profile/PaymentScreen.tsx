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

  async function handleTestPayment() {
    setLoading(true);
    const result = await startCheckout(TEST_AMOUNT, 'Pagamento de teste — Go XL');
    setLoading(false);

    if (result.status === 'error') {
      Alert.alert('Erro no pagamento', result.error ?? 'Tente novamente.');
    } else if (result.status === 'completed') {
      Alert.alert('Pronto!', 'Pagamento de teste processado. Confira no painel do Stripe (modo teste).');
    }
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
        <Text style={styles.badge}>Modo de teste</Text>
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
  badge: {
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
});
