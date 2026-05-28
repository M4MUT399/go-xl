import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Payment'> };

export function PaymentScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Voltar</Text>
      </TouchableOpacity>

      <View style={styles.center}>
        <View style={styles.iconCircle}>
          <Text style={{ fontSize: 40 }}>💳</Text>
        </View>
        <Text style={styles.title}>Pagamento</Text>
        <Text style={styles.badge}>Em breve</Text>
        <Text style={styles.text}>
          O pagamento com cartão de crédito em dólar (US$) estará disponível em breve.
          Por enquanto, os valores das corridas são apenas exibidos para referência.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white, padding: 24 },
  back: { alignSelf: 'flex-start' },
  backText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: { fontSize: 24, fontWeight: '800', color: Colors.primary, marginBottom: 10 },
  badge: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 20,
  },
  text: { fontSize: 15, color: Colors.gray[500], textAlign: 'center', lineHeight: 22 },
});
