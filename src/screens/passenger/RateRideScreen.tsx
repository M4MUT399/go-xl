import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, TextInput,
  Keyboard, Alert, ActivityIndicator,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { Button } from '../../components/common/Button';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { tipRide } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { calculateSplit, DRIVER_SHARE } from '../../lib/split';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RateRide'>;
  route: RouteProp<RootStackParamList, 'RateRide'>;
};

const TIP_PRESETS = [5, 10, 15]; // em dólares

export function RateRideScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { profile } = useAuth();
  const { colors } = useTheme();
  const [rating, setRating]     = useState(5);
  const [comment, setComment]   = useState('');
  const [loading, setLoading]   = useState(false);

  const styles = makeStyles(colors);

  // Gorjeta
  const [tipDollars, setTipDollars]     = useState<number>(0);   // 0 = sem gorjeta
  const [isCustom, setIsCustom]         = useState(false);
  const [customTip, setCustomTip]       = useState('');
  const [tipLoading, setTipLoading]     = useState(false);

  const fare = Number(ride.price) || 0;
  const split = calculateSplit(fare);

  function selectPreset(amount: number) {
    setTipDollars(amount);
    setIsCustom(false);
    setCustomTip('');
  }

  function selectNoTip() {
    setTipDollars(0);
    setIsCustom(false);
    setCustomTip('');
  }

  function selectCustom() {
    setIsCustom(true);
    setTipDollars(0);
    setCustomTip('');
  }

  /** Valor final da gorjeta em dólares (0 = sem gorjeta). */
  function getFinalTip(): number {
    if (isCustom) {
      const parsed = parseFloat(customTip.replace(',', '.'));
      return isNaN(parsed) ? 0 : parsed;
    }
    return tipDollars;
  }

  async function handleSubmit() {
    Keyboard.dismiss();
    setLoading(true);

    const finalTip = getFinalTip();

    // 1. Cobra gorjeta se aplicável
    if (finalTip >= 0.5) {
      setTipLoading(true);
      const result = await tipRide(ride.id, Math.round(finalTip * 100));
      setTipLoading(false);
      if (!result.ok) {
        setLoading(false);
        Alert.alert(
          'Erro na gorjeta',
          result.error ?? 'Não foi possível processar a gorjeta. Deseja continuar sem ela?',
          [
            { text: 'Tentar novamente', onPress: () => setLoading(false) },
            {
              text: 'Continuar sem gorjeta',
              onPress: async () => {
                setLoading(true);
                await submitRating();
              },
            },
          ]
        );
        return;
      }
    }

    await submitRating();
  }

  async function submitRating() {
    await supabase.from('ratings').insert({
      ride_id:   ride.id,
      from_user: profile?.id,
      to_user:   ride.driver_id,
      score:     rating,
      comment:   comment.trim() || null,
    });
    setLoading(false);
    navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
  }

  function handleSkip() {
    navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
  }

  const finalTip = getFinalTip();
  const isPresetActive = (v: number) => !isCustom && tipDollars === v;

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        enableOnAndroid
        extraScrollHeight={20}
      >
        {/* ── Ícone de sucesso ── */}
        <View style={styles.successIcon}>
          <Text style={styles.successEmoji}>✓</Text>
        </View>

        <Text style={styles.title}>Chegou!{'\n'}Boa viagem?</Text>
        <Text style={styles.subtitle}>Avalie sua experiência Executive XL</Text>

        {/* ── Stars ── */}
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

        {/* ── Gorjeta ── */}
        <View style={styles.tipCard}>
          <View style={styles.tipHeader}>
            <Text style={styles.tipTitle}>💰 Gorjeta para o motorista</Text>
            <Text style={styles.tipSub}>Opcional · debitado automaticamente do cartão</Text>
          </View>

          {/* Botão "Sem gorjeta" */}
          <View style={styles.tipRow}>
            <TouchableOpacity
              style={[styles.tipBtn, isPresetActive(0) && styles.tipBtnActive]}
              onPress={selectNoTip}
            >
              <Text style={[styles.tipBtnText, isPresetActive(0) && styles.tipBtnTextActive]}>
                Sem gorjeta
              </Text>
            </TouchableOpacity>
          </View>

          {/* Presets + Outro */}
          <View style={styles.tipPresets}>
            {TIP_PRESETS.map((v) => (
              <TouchableOpacity
                key={v}
                style={[styles.tipBtn, styles.tipBtnPreset, isPresetActive(v) && styles.tipBtnActive]}
                onPress={() => selectPreset(v)}
              >
                <Text style={[styles.tipBtnText, isPresetActive(v) && styles.tipBtnTextActive]}>
                  ${v}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.tipBtn, styles.tipBtnPreset, isCustom && styles.tipBtnActive]}
              onPress={selectCustom}
            >
              <Text style={[styles.tipBtnText, isCustom && styles.tipBtnTextActive]}>
                Outro valor
              </Text>
            </TouchableOpacity>
          </View>

          {/* Input personalizado */}
          {isCustom && (
            <View style={styles.customRow}>
              <Text style={styles.customSymbol}>$</Text>
              <TextInput
                style={styles.customInput}
                value={customTip}
                onChangeText={setCustomTip}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={colors.gray[400]}
                autoFocus
              />
            </View>
          )}

          {/* Preview do valor */}
          {finalTip >= 0.5 && (
            <View style={styles.tipPreview}>
              <Text style={styles.tipPreviewText}>
                ✓ Gorjeta de {formatCurrency(finalTip)} será cobrada no seu cartão
              </Text>
            </View>
          )}
        </View>

        {/* ── Comentário ── */}
        <TextInput
          style={styles.commentInput}
          value={comment}
          onChangeText={setComment}
          placeholder="Deixe um comentário (opcional)..."
          placeholderTextColor={colors.gray[400]}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        {/* ── Resumo da corrida ── */}
        <View style={styles.tripSummary}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Distância</Text>
            <Text style={styles.summaryValue}>{formatDistance(ride.distance_km)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total da corrida</Text>
            <Text style={styles.summaryValue}>{formatCurrency(ride.price)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>  Motorista ({Math.round(DRIVER_SHARE * 100)}%)</Text>
            <Text style={styles.splitDriver}>{formatCurrency(split.driverAmount)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>  Taxa Go XL ({Math.round((1 - DRIVER_SHARE) * 100)}%)</Text>
            <Text style={styles.splitPlatform}>{formatCurrency(split.platformFee)}</Text>
          </View>
          {finalTip >= 0.5 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>  Gorjeta</Text>
              <Text style={styles.splitDriver}>{formatCurrency(finalTip)}</Text>
            </View>
          )}
          <View style={[styles.summaryRow, styles.payRow]}>
            <Text style={styles.summaryLabel}>Pagamento</Text>
            <Text style={styles.paidText}>✓ Cobrado ao aceitar</Text>
          </View>
        </View>

        {/* ── Botões ── */}
        <View style={styles.footer}>
          {tipLoading ? (
            <View style={styles.tipLoadingBox}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.tipLoadingText}>Processando gorjeta...</Text>
            </View>
          ) : (
            <Button
              title="Enviar avaliação"
              onPress={handleSubmit}
              loading={loading}
            />
          )}
          <Button title="Pular" onPress={handleSkip} variant="ghost" />
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content:   { flexGrow: 1, alignItems: 'center', paddingHorizontal: 28, paddingVertical: 24 },

    // Success
    successIcon: {
      width: 80, height: 80, borderRadius: 40,
      backgroundColor: colors.success,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 20,
    },
    successEmoji: { color: colors.white, fontSize: 36, fontWeight: '900' },
    title: {
      fontSize: 30, fontWeight: '800', color: colors.text,
      textAlign: 'center', lineHeight: 38, marginBottom: 8,
    },
    subtitle: { fontSize: 15, color: colors.gray[500], marginBottom: 24, textAlign: 'center' },

    // Stars
    stars: { flexDirection: 'row', gap: 8, marginBottom: 10 },
    star:  { fontSize: 44, color: colors.gray[300] },
    starActive: { color: colors.accent },
    ratingLabel: { marginBottom: 24 },
    ratingLabelText: { fontSize: 16, fontWeight: '600', color: colors.gray[600] },

    // Gorjeta card
    tipCard: {
      width: '100%',
      backgroundColor: colors.primary,
      borderRadius: 18,
      padding: 18,
      marginBottom: 20,
    },
    tipHeader: { marginBottom: 14 },
    tipTitle:  { fontSize: 16, fontWeight: '800', color: colors.white, marginBottom: 4 },
    tipSub:    { fontSize: 12, color: colors.gray[400] },

    tipRow: { marginBottom: 10 },
    tipPresets: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },

    tipBtn: {
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.18)',
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tipBtnPreset: { flex: 1, minWidth: 56 },
    tipBtnActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    tipBtnText: { fontSize: 14, fontWeight: '700', color: 'rgba(255,255,255,0.65)' },
    tipBtnTextActive: { color: colors.primary },

    // Custom input
    customRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 12,
      backgroundColor: 'rgba(255,255,255,0.08)',
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 4,
      borderWidth: 1.5,
      borderColor: colors.accent,
    },
    customSymbol: { fontSize: 22, color: colors.accent, fontWeight: '800', marginRight: 6 },
    customInput: {
      flex: 1,
      fontSize: 22,
      fontWeight: '700',
      color: colors.white,
      paddingVertical: 10,
    },

    // Preview
    tipPreview: {
      marginTop: 12,
      backgroundColor: 'rgba(201,168,76,0.15)',
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    tipPreviewText: { fontSize: 13, color: colors.accent, fontWeight: '700', textAlign: 'center' },

    // Comment
    commentInput: {
      width: '100%',
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      padding: 14,
      fontSize: 15,
      color: colors.text,
      borderWidth: 1.5,
      borderColor: colors.gray[200],
      minHeight: 80,
      marginBottom: 20,
      textAlignVertical: 'top',
    },

    // Trip summary
    tripSummary: {
      width: '100%',
      backgroundColor: colors.gray[100],
      borderRadius: 14,
      padding: 16,
      gap: 10,
      marginBottom: 4,
    },
    summaryRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    summaryLabel:   { color: colors.gray[500], fontSize: 14 },
    summaryValue:   { color: colors.text, fontSize: 14, fontWeight: '700' },
    payRow:         { borderTopWidth: 1, borderTopColor: colors.gray[200], paddingTop: 10, marginTop: 2 },
    splitDriver:    { color: colors.success, fontSize: 13, fontWeight: '700' },
    splitPlatform:  { color: colors.gray[500], fontSize: 13, fontWeight: '600' },
    paidText:       { color: colors.success, fontSize: 14, fontWeight: '800' },

    // Footer
    footer: { width: '100%', paddingTop: 20, paddingBottom: 8, gap: 8 },
    tipLoadingBox: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingVertical: 18,
      backgroundColor: colors.primary,
      borderRadius: 14,
    },
    tipLoadingText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  });
}
