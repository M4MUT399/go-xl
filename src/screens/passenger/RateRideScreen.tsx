import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, TextInput,
  Keyboard, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { useTranslation } from '../../i18n';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { SAFETY_INCIDENT_CATEGORIES, type SafetyIncidentCategory } from '../../lib/safetyIncidents';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RateRide'>;
  route: RouteProp<RootStackParamList, 'RateRide'>;
};

const TIP_PRESETS = [5, 10, 15]; // em dólares

export function RateRideScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [rating, setRating]     = useState(5);
  const [comment, setComment]   = useState('');
  const [loading, setLoading]   = useState(false);

  const styles = makeStyles(colors);

  // Gorjeta
  const [tipDollars, setTipDollars]     = useState<number>(0);   // 0 = sem gorjeta
  const [isCustom, setIsCustom]         = useState(false);
  const [customTip, setCustomTip]       = useState('');
  const [tipLoading, setTipLoading]     = useState(false);

  // Bloco 4 (compliance TNC F.S. 627.748): denúncia de segurança contra o
  // motorista. Ação INDEPENDENTE da avaliação/gorjeta -- o passageiro pode
  // denunciar mesmo sem dar nota. Gravação direta em driver_safety_reports
  // (RLS já permite reporter_id = auth.uid()); o trigger de suspensão
  // automática de tolerância zero roda no servidor (migration 0060),
  // independente da flag abaixo, que só controla a VISIBILIDADE desta UI.
  const safetyReportsEnabled = useFeatureFlag('safety_reports_v1_enabled', profile?.jurisdiction ?? 'global');
  const [showReportForm, setShowReportForm]     = useState(false);
  const [reportCategory, setReportCategory]     = useState<SafetyIncidentCategory | null>(null);
  const [reportDescription, setReportDescription] = useState('');
  const [reporting, setReporting]               = useState(false);
  const [reportSubmitted, setReportSubmitted]   = useState(false);

  const farePrice = Number(ride.price) || 0;
  // Detalhamento do recibo: pedágio e taxa de aeroporto/porto já ficam
  // armazenados separadamente em `rides`; a tarifa base é o restante do total
  // (mesma composição usada em requestRide/tipRide — ver useRide.ts).
  const tollAmount = Number(ride.toll_amount) || 0;
  const airportFee = Number(ride.airport_port_fee) || 0;
  const baseFare = Math.max(farePrice - tollAmount - airportFee, 0);
  const hasFeeBreakdown = tollAmount > 0 || airportFee > 0;

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
          t('rate.tipErrorTitle'),
          result.error ?? t('rate.tipErrorMessage'),
          [
            { text: t('rate.tipErrorRetry'), onPress: () => setLoading(false) },
            {
              text: t('rate.tipErrorContinueWithout'),
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

  // Bloco 4: envia a denúncia -- confirma antes por ser uma ação sensível
  // (pode disparar suspensão IMEDIATA do motorista se a categoria for de
  // tolerância zero, ver src/lib/safetyIncidents.ts).
  function handleSubmitReport() {
    if (!reportCategory) return;
    Alert.alert(
      t('rate.reportConfirmTitle'),
      t('rate.reportConfirmMsg'),
      [
        { text: t('rate.reportCancel'), style: 'cancel' },
        {
          text: t('rate.reportConfirmSend'),
          style: 'destructive',
          onPress: async () => {
            setReporting(true);
            const { error } = await supabase.from('driver_safety_reports').insert({
              driver_id:   ride.driver_id,
              reporter_id: profile?.id,
              ride_id:     ride.id,
              category:    reportCategory,
              description: reportDescription.trim() || null,
            });
            setReporting(false);
            if (error) {
              Alert.alert(t('rate.reportErrorTitle'), t('rate.reportErrorMsg'));
              return;
            }
            setReportSubmitted(true);
            setShowReportForm(false);
          },
        },
      ]
    );
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

        <Text style={styles.title}>{t('rate.title')}</Text>
        <Text style={styles.subtitle}>{t('rate.subtitle')}</Text>

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
            {rating === 5 ? t('rate.ratingExcellent') : rating === 4 ? t('rate.ratingVeryGood') : rating === 3 ? t('rate.ratingRegular') : rating === 2 ? t('rate.ratingBad') : t('rate.ratingTerrible')}
          </Text>
        </View>

        {/* ── Gorjeta ── */}
        <View style={styles.tipCard}>
          <View style={styles.tipHeader}>
            <Text style={styles.tipTitle}>💰 {t('rate.tipTitle')}</Text>
            <Text style={styles.tipSub}>{t('rate.tipSub')}</Text>
          </View>

          {/* Botão "Sem gorjeta" */}
          <View style={styles.tipRow}>
            <TouchableOpacity
              style={[styles.tipBtn, isPresetActive(0) && styles.tipBtnActive]}
              onPress={selectNoTip}
            >
              <Text style={[styles.tipBtnText, isPresetActive(0) && styles.tipBtnTextActive]}>
                {t('rate.noTip')}
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
                {t('rate.customTip')}
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
                ✓ {t('rate.tipPreview').replace('{amount}', formatCurrency(finalTip))}
              </Text>
            </View>
          )}
        </View>

        {/* ── Comentário ── */}
        <TextInput
          style={styles.commentInput}
          value={comment}
          onChangeText={setComment}
          placeholder={t('rate.commentPlaceholder')}
          placeholderTextColor={colors.gray[400]}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />

        {/* ── Denúncia de segurança (Bloco 4, compliance TNC F.S. 627.748) ── */}
        {safetyReportsEnabled && (
          <View style={styles.reportSection}>
            {reportSubmitted ? (
              <Text style={styles.reportSubmittedText}>✓ {t('rate.reportSubmitted')}</Text>
            ) : !showReportForm ? (
              <TouchableOpacity onPress={() => setShowReportForm(true)}>
                <Text style={styles.reportToggleText}>⚠️ {t('rate.reportToggle')}</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.reportForm}>
                <Text style={styles.reportFormTitle}>{t('rate.reportFormTitle')}</Text>
                <View style={styles.reportChips}>
                  {SAFETY_INCIDENT_CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.reportChip, reportCategory === cat && styles.reportChipActive]}
                      onPress={() => setReportCategory(cat)}
                    >
                      <Text style={[styles.reportChipText, reportCategory === cat && styles.reportChipTextActive]}>
                        {t(`rate.category.${cat}`)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput
                  style={styles.reportDescInput}
                  value={reportDescription}
                  onChangeText={setReportDescription}
                  placeholder={t('rate.reportDescPlaceholder')}
                  placeholderTextColor={colors.gray[400]}
                  multiline
                  numberOfLines={3}
                  textAlignVertical="top"
                />
                <View style={styles.reportFormBtns}>
                  <TouchableOpacity
                    onPress={() => { setShowReportForm(false); setReportCategory(null); setReportDescription(''); }}
                  >
                    <Text style={styles.reportCancelText}>{t('rate.reportCancel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reportSubmitBtn, !reportCategory && styles.reportSubmitBtnDisabled]}
                    onPress={handleSubmitReport}
                    disabled={!reportCategory || reporting}
                  >
                    {reporting
                      ? <ActivityIndicator color={colors.white} size="small" />
                      : <Text style={styles.reportSubmitBtnText}>{t('rate.reportSend')}</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        )}

        {/* ── Resumo da corrida ── */}
        <View style={styles.tripSummary}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{t('rate.summaryDistance')}</Text>
            <Text style={styles.summaryValue}>{formatDistance(ride.distance_km)}</Text>
          </View>
          {hasFeeBreakdown && (
            <>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('rate.summaryFare')}</Text>
                <Text style={styles.splitPlatform}>{formatCurrency(baseFare)}</Text>
              </View>
              {tollAmount > 0 && (
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('requestRide.tollIncluded')}</Text>
                  <Text style={styles.splitPlatform}>{formatCurrency(tollAmount)}</Text>
                </View>
              )}
              {airportFee > 0 && (
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('requestRide.airportPortFee')}</Text>
                  <Text style={styles.splitPlatform}>{formatCurrency(airportFee)}</Text>
                </View>
              )}
            </>
          )}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{t('rate.summaryTotal')}</Text>
            <Text style={styles.summaryValue}>{formatCurrency(farePrice)}</Text>
          </View>
          {finalTip >= 0.5 && (
            <>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('rate.summaryTip')}</Text>
                <Text style={styles.splitDriver}>{formatCurrency(finalTip)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('rate.summaryTotalWithTip')}</Text>
                <Text style={styles.summaryValue}>{formatCurrency(farePrice + finalTip)}</Text>
              </View>
            </>
          )}
          <View style={[styles.summaryRow, styles.payRow]}>
            <Text style={styles.summaryLabel}>{t('rate.summaryPayment')}</Text>
            <Text style={styles.paidText}>✓ {t('rate.summaryPaid')}</Text>
          </View>
        </View>

        {/* ── Botões ── */}
        <View style={[styles.footer, Platform.OS === 'android' && { paddingBottom: 8 + insets.bottom }]}>
          {tipLoading ? (
            <View style={styles.tipLoadingBox}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.tipLoadingText}>{t('rate.processingTip')}</Text>
            </View>
          ) : (
            <Button
              title={t('rate.submit')}
              onPress={handleSubmit}
              loading={loading}
            />
          )}
          <Button title={t('rate.skip')} onPress={handleSkip} variant="ghost" />
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

    // Denúncia de segurança (Bloco 4)
    reportSection: { width: '100%', marginBottom: 20 },
    reportToggleText: { fontSize: 13, fontWeight: '700', color: colors.gray[500], textAlign: 'center' },
    reportSubmittedText: { fontSize: 13, fontWeight: '700', color: colors.success, textAlign: 'center' },
    reportForm: {
      width: '100%',
      backgroundColor: colors.gray[100],
      borderRadius: 14,
      padding: 16,
      borderWidth: 1.5,
      borderColor: colors.gray[200],
    },
    reportFormTitle: { fontSize: 14, fontWeight: '800', color: colors.text, marginBottom: 12 },
    reportChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
    reportChip: {
      borderWidth: 1.5,
      borderColor: colors.gray[300],
      borderRadius: 20,
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    reportChipActive: { backgroundColor: colors.error, borderColor: colors.error },
    reportChipText: { fontSize: 12, fontWeight: '600', color: colors.gray[600] },
    reportChipTextActive: { color: colors.white },
    reportDescInput: {
      width: '100%',
      backgroundColor: colors.white,
      borderRadius: 10,
      padding: 12,
      fontSize: 14,
      color: colors.text,
      borderWidth: 1.5,
      borderColor: colors.gray[200],
      minHeight: 64,
      marginBottom: 12,
      textAlignVertical: 'top',
    },
    reportFormBtns: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 16 },
    reportCancelText: { fontSize: 13, fontWeight: '700', color: colors.gray[500] },
    reportSubmitBtn: {
      backgroundColor: colors.error,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 18,
    },
    reportSubmitBtnDisabled: { opacity: 0.5 },
    reportSubmitBtnText: { color: colors.white, fontSize: 13, fontWeight: '700' },

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
