import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, TextInput, ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Keyboard } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { formatCurrency, formatDistance } from '../../lib/format';
import { startCheckout } from '../../lib/payments';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RateRide'>;
  route: RouteProp<RootStackParamList, 'RateRide'>;
};

type PaymentStatus = 'pending' | 'processing' | 'paid';

export function RateRideScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { profile } = useAuth();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [payment, setPayment] = useState<PaymentStatus>('pending');
  const autoCharged = useRef(false);

  const fare = Number(ride.price) || 0;

  async function charge() {
    setPayment('processing');
    const result = await startCheckout(fare, 'Corrida Go XL — Executive XL', ride.id);
    if (result.status === 'completed') {
      setPayment('paid');
      // marca a corrida como paga (best-effort; ignora se a coluna não existir)
      supabase.from('rides').update({ paid: true }).eq('id', ride.id).then(() => {});
    } else {
      setPayment('pending');
      if (result.status === 'error') {
        Alert.alert('Erro no pagamento', result.error ?? 'Tente novamente.');
      }
    }
  }

  // Cobra automaticamente ao concluir a corrida
  useEffect(() => {
    if (!autoCharged.current && fare > 0) {
      autoCharged.current = true;
      charge();
    }
  }, []);

  async function handleSubmit() {
    setLoading(true);
    await supabase.from('ratings').insert({
      ride_id: ride.id,
      from_user: profile?.id,
      to_user: ride.driver_id,
      score: rating,
      comment: comment.trim() || null,
    });
    setLoading(false);
    navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
  }

  function handleSkip() {
    navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.successIcon}>
          <Text style={styles.successEmoji}>✓</Text>
        </View>

        <Text style={styles.title}>Chegou!{'\n'}Boa viagem?</Text>
        <Text style={styles.subtitle}>Avalie sua experiência Executive XL</Text>

        <View style={styles.stars}>
          {[1, 2, 3, 4, 5].map((s) => (
            <TouchableOpacity key={s} onPress={() => setRating(s)}>
              <Text style={[styles.star, s <= rating && styles.starActive]}>★</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.ratingLabel}>
          <Text style={styles.ratingLabelText}>
            {rating === 5 ? 'Excelente!' : rating === 4 ? 'Muito bom' : rating === 3 ? 'Regular' : rating === 2 ? 'Ruim' : 'Péssimo'}
          </Text>
        </View>

        <TextInput
          style={styles.commentInput}
          value={comment}
          onChangeText={setComment}
          placeholder="Deixe um comentário (opcional)..."
          placeholderTextColor={Colors.gray[400]}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        <View style={styles.tripSummary}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Distância</Text>
            <Text style={styles.summaryValue}>{formatDistance(ride.distance_km)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Valor</Text>
            <Text style={styles.summaryValue}>{formatCurrency(ride.price)}</Text>
          </View>
          <View style={[styles.summaryRow, styles.payRow]}>
            <Text style={styles.summaryLabel}>Pagamento</Text>
            {payment === 'paid' ? (
              <Text style={styles.paidText}>✓ Pago</Text>
            ) : payment === 'processing' ? (
              <View style={styles.processingRow}>
                <ActivityIndicator size="small" color={Colors.accent} />
                <Text style={styles.processingText}>Processando...</Text>
              </View>
            ) : (
              <Text style={styles.pendingText}>Pendente</Text>
            )}
          </View>
        </View>

        <View style={styles.footer}>
          {payment !== 'paid' && (
            <Button
              title={`Pagar ${formatCurrency(fare)}`}
              onPress={charge}
              loading={payment === 'processing'}
            />
          )}
          <Button
            title="Enviar avaliação"
            onPress={() => { Keyboard.dismiss(); handleSubmit(); }}
            loading={loading}
            variant={payment === 'paid' ? 'primary' : 'outline'}
          />
          <Button title="Pular" onPress={handleSkip} variant="ghost" />
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 24 },
  successIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  successEmoji: { color: Colors.white, fontSize: 36, fontWeight: '900' },
  title: { fontSize: 30, fontWeight: '800', color: Colors.primary, textAlign: 'center', lineHeight: 38, marginBottom: 8 },
  subtitle: { fontSize: 15, color: Colors.gray[500], marginBottom: 32, textAlign: 'center' },
  stars: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  star: { fontSize: 44, color: Colors.gray[300] },
  starActive: { color: Colors.accent },
  ratingLabel: { marginBottom: 24 },
  ratingLabelText: { fontSize: 16, fontWeight: '600', color: Colors.gray[600] },
  commentInput: {
    width: '100%',
    backgroundColor: Colors.gray[100],
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: Colors.black,
    borderWidth: 1.5,
    borderColor: Colors.gray[200],
    minHeight: 80,
    marginBottom: 24,
  },
  tripSummary: {
    width: '100%',
    backgroundColor: Colors.gray[100],
    borderRadius: 14,
    padding: 16,
    gap: 10,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { color: Colors.gray[500], fontSize: 14 },
  summaryValue: { color: Colors.primary, fontSize: 14, fontWeight: '700' },
  payRow: { borderTopWidth: 1, borderTopColor: Colors.gray[200], paddingTop: 10, marginTop: 2 },
  paidText: { color: Colors.success, fontSize: 14, fontWeight: '800' },
  pendingText: { color: Colors.error, fontSize: 14, fontWeight: '700' },
  processingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  processingText: { color: Colors.gray[600], fontSize: 13, fontWeight: '600' },
  footer: { width: '100%', paddingTop: 24, paddingBottom: 8, gap: 8 },
});
