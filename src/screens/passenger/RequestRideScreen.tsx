import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  TextInput, ScrollView, Alert, ActivityIndicator, Modal, Platform,
  KeyboardAvoidingView, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList, Location } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { Button } from '../../components/common/Button';
import { useLocation } from '../../hooks/useLocation';
import { useAuth } from '../../hooks/useAuth';
import { usePassengerRide, estimatePrice, estimateDuration, SurgeInfo } from '../../hooks/useRide';
import { getSurgeInfo } from '../../lib/surge';
import { estimateTollAmount } from '../../lib/tolls';
import { estimateAirportFees } from '../../lib/airportFees';
import { formatCurrency, formatDistance } from '../../lib/format';
import { useDebounce } from '../../hooks/useDebounce';
import { useRoute } from '../../hooks/useRoute';
import { searchAddresses, reverseGeocode, GeocodeResult } from '../../lib/geocoding';
import { hasPaymentCard, isProfileComplete } from '../../lib/onboarding';
import { useTranslation } from '../../i18n';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RequestRide'>;
  route: RouteProp<RootStackParamList, 'RequestRide'>;
};

export function RequestRideScreen({ navigation, route: screenRoute }: Props) {
  const { t } = useTranslation();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { location } = useLocation();
  const { requestRide, scheduleRide } = usePassengerRide(profile?.id, profile?.jurisdiction);

  const styles = makeStyles(colors);

  const lockedDriverId   = screenRoute.params?.lockedDriverId;
  const lockedDriverName = screenRoute.params?.lockedDriverName;
  // 1ª corrida expressa (via QR): liberada só com cartão, sem cadastro completo.
  const isExpressFirstRide = screenRoute.params?.express === true;

  const [destinationText, setDestinationText] = useState('');
  const [selectedDest, setSelectedDest] = useState<Location | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Endereço da localização GPS atual (reverse geocode). É o embarque padrão,
  // mas o passageiro pode sobrepor escolhendo outro ponto (selectedOrigin).
  const [originAddress, setOriginAddress] = useState(t('requestRide.currentLocation'));
  const [originText, setOriginText] = useState('');
  const [selectedOrigin, setSelectedOrigin] = useState<Location | null>(null);
  const [originResults, setOriginResults] = useState<GeocodeResult[]>([]);
  const [originSearching, setOriginSearching] = useState(false);
  // Qual campo está sendo editado agora — controla qual lista de sugestões
  // aparece embaixo. Começa em 'destination' pra manter o fluxo atual (o
  // passageiro já cai digitando o destino).
  const [activeField, setActiveField] = useState<'origin' | 'destination'>('destination');
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date>(() => new Date(Date.now() + 30 * 60 * 1000));
  // Android não suporta mode='datetime' — usamos diálogos nativos em duas
  // etapas (data → hora). Este estado controla qual diálogo está aberto.
  const [androidPickerMode, setAndroidPickerMode] = useState<'date' | 'time' | null>(null);
  const [surgeInfo, setSurgeInfo] = useState<SurgeInfo>({ multiplier: 1.0, label: null });
  const [tollAmount, setTollAmount] = useState<number>(0);
  const [venueFee, setVenueFee] = useState<number>(0);

  const debouncedQuery = useDebounce(destinationText, 450);
  const debouncedOriginQuery = useDebounce(originText, 450);

  useEffect(() => {
    if (location) {
      reverseGeocode(location.lat, location.lng).then((addr) => {
        if (addr) setOriginAddress(addr);
      });
    }
  }, [location?.lat, location?.lng]);

  useEffect(() => {
    if (selectedDest || debouncedQuery.trim().length < 3) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    searchAddresses(debouncedQuery, location ?? undefined).then((res) => {
      if (!cancelled) {
        setResults(res);
        setSearching(false);
      }
    });
    return () => { cancelled = true; };
  }, [debouncedQuery, selectedDest, location?.lat, location?.lng]);

  // Busca de endereços pro campo de embarque — mesmo padrão do destino.
  useEffect(() => {
    if (selectedOrigin || debouncedOriginQuery.trim().length < 3) {
      setOriginResults([]);
      return;
    }
    let cancelled = false;
    setOriginSearching(true);
    searchAddresses(debouncedOriginQuery, location ?? undefined).then((res) => {
      if (!cancelled) {
        setOriginResults(res);
        setOriginSearching(false);
      }
    });
    return () => { cancelled = true; };
  }, [debouncedOriginQuery, selectedOrigin, location?.lat, location?.lng]);

  // Embarque efetivo: usa o ponto escolhido manualmente pelo passageiro
  // (selectedOrigin) ou, por padrão, a localização GPS atual.
  const effectiveOrigin: Location | null = selectedOrigin
    ?? (location ? { lat: location.lat, lng: location.lng, address: originAddress } : null);

  const { route } = useRoute(
    effectiveOrigin ? { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng } : null,
    selectedDest ? { lat: selectedDest.lat, lng: selectedDest.lng } : null
  );

  const distanceKm = route?.distanceKm
    ?? (selectedDest && effectiveOrigin ? haversine(effectiveOrigin, { lat: selectedDest.lat, lng: selectedDest.lng }) : null);

  const estimatedPrice = distanceKm ? estimatePrice(distanceKm, surgeInfo.multiplier) : null;
  const estimatedMin = route?.durationMin ?? (distanceKm ? estimateDuration(distanceKm) : null);

  // Preço exibível: usa o calculado ou o mínimo como fallback (evita botão preso)
  const MIN_PRICE_FALLBACK = 15.0;
  const displayPrice = estimatedPrice ?? (selectedDest ? MIN_PRICE_FALLBACK : null);
  // Total mostrado ao passageiro inclui pedágio (P5) e taxa de aeroporto/porto
  // (P6). Sem taxas → total = tarifa (comportamento atual).
  const displayTotal = displayPrice != null
    ? Math.round((displayPrice + tollAmount + venueFee) * 100) / 100
    : null;

  useEffect(() => {
    if (!selectedDest) return;
    getSurgeInfo().then(setSurgeInfo);
  }, [selectedDest]);

  // Pedágio (P5): estima quando há destino + distância. Desligado → 0, sem UI.
  useEffect(() => {
    if (!selectedDest || !effectiveOrigin || !distanceKm) {
      setTollAmount(0);
      return;
    }
    let cancelled = false;
    estimateTollAmount({
      origin: { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng },
      destination: { lat: selectedDest.lat, lng: selectedDest.lng },
      distanceKm,
    }).then((q) => {
      if (!cancelled) setTollAmount(q.amount);
    });
    return () => { cancelled = true; };
  }, [selectedDest, selectedOrigin, location?.lat, location?.lng, distanceKm]);

  // Taxa de aeroporto/porto (P6): estima por geofence. Sem zonas → 0, sem UI.
  useEffect(() => {
    if (!selectedDest || !effectiveOrigin) {
      setVenueFee(0);
      return;
    }
    let cancelled = false;
    estimateAirportFees(
      { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng },
      { lat: selectedDest.lat, lng: selectedDest.lng },
    ).then((r) => {
      if (!cancelled) setVenueFee(r.total);
    });
    return () => { cancelled = true; };
  }, [selectedDest, selectedOrigin, location?.lat, location?.lng]);

  async function handleRequest() {
    if (!selectedDest) {
      Alert.alert(t('requestRide.attentionTitle'), t('requestRide.selectDestination'));
      return;
    }
    if (!effectiveOrigin) {
      Alert.alert(
        t('requestRide.locationUnavailableTitle'),
        t('requestRide.locationUnavailableMessage'),
      );
      return;
    }
    // Gate de cartão: toda corrida precisa de um cartão salvo. Envia para a
    // tela de adicionar cartão e volta; o passageiro toca "Solicitar" de novo.
    if (!hasPaymentCard(profile)) {
      navigation.navigate('AddCardOnboarding');
      return;
    }
    // Gate de cadastro: conta expressa (via QR) completa o cadastro na 2ª
    // viagem. Só a 1ª corrida expressa imediata é liberada sem cadastro completo.
    if (!isProfileComplete(profile) && !isExpressFirstRide) {
      navigation.navigate('CompleteRegistration');
      return;
    }
    setLoading(true);
    const origin: Location = effectiveOrigin;
    const ride = await requestRide(
      origin,
      selectedDest,
      route ? { distanceKm: route.distanceKm, durationMin: route.durationMin } : undefined,
      lockedDriverId ? { lockedDriverId } : undefined
    );
    setLoading(false);
    if (ride) {
      navigation.replace('FindingDriver', { ride });
    } else {
      // Pega o erro do log para debug — remove em produção
      Alert.alert(t('requestRide.requestErrorTitle'), t('requestRide.requestErrorMessage').replace('{passengerId}', profile?.id ?? 'NULL'));
    }
  }

  function openScheduler() {
    setScheduledDate(new Date(Date.now() + 30 * 60 * 1000));
    setShowPicker(true);
  }

  // Fluxo Android: abre o diálogo de data; ao confirmar, encadeia o de hora.
  function onAndroidPickerChange(event: DateTimePickerEvent, selected?: Date) {
    if (event.type === 'dismissed' || !selected) {
      setAndroidPickerMode(null);
      return;
    }
    if (androidPickerMode === 'date') {
      // Preserva a hora atual e troca só o dia; em seguida pede a hora.
      const next = new Date(scheduledDate);
      next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
      setScheduledDate(next);
      setAndroidPickerMode('time');
    } else if (androidPickerMode === 'time') {
      const next = new Date(scheduledDate);
      next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
      setScheduledDate(next);
      setAndroidPickerMode(null);
    }
  }

  async function confirmSchedule() {
    if (!selectedDest || !effectiveOrigin) return;
    if (scheduledDate.getTime() < Date.now() + 30 * 60 * 1000) {
      Alert.alert(t('requestRide.attentionTitle'), t('requestRide.scheduleMinAdvance'));
      return;
    }
    // Agendar exige cartão E cadastro completo — inclusive em conta expressa
    // (agendamento é o gatilho para o passageiro completar o cadastro).
    if (!hasPaymentCard(profile)) {
      setShowPicker(false);
      navigation.navigate('AddCardOnboarding');
      return;
    }
    if (!isProfileComplete(profile)) {
      setShowPicker(false);
      navigation.navigate('CompleteRegistration');
      return;
    }
    setLoading(true);
    const origin: Location = effectiveOrigin;
    const ride = await scheduleRide(
      origin,
      selectedDest,
      scheduledDate,
      route ? { distanceKm: route.distanceKm, durationMin: route.durationMin } : undefined,
      lockedDriverId ? { lockedDriverId } : undefined
    );
    setLoading(false);
    setShowPicker(false);
    if (ride) {
      Alert.alert(
        t('requestRide.scheduleSuccessTitle'),
        t('requestRide.scheduleSuccessMessage').replace('{datetime}', scheduledDate.toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })),
        [{ text: t('requestRide.viewScheduled'), onPress: () => navigation.replace('ScheduledRides') }]
      );
    } else {
      Alert.alert(t('requestRide.errorTitle'), t('requestRide.scheduleErrorMessage'));
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
            <Text style={styles.backText}>←</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{t('requestRide.title')}</Text>
        </View>

        {/* Banner: motorista pré-selecionado via QR code */}
        {lockedDriverId && (
          <View style={styles.lockedBanner}>
            <Text style={styles.lockedIcon}>🔒</Text>
            <View style={styles.lockedInfo}>
              <Text style={styles.lockedLabel}>{t('requestRide.driverViaQr')}</Text>
              <Text style={styles.lockedName}>{lockedDriverName ?? 'Executive XL'}</Text>
            </View>
            <View style={styles.lockedBadge}>
              <Text style={styles.lockedBadgeText}>{t('requestRide.reserved')}</Text>
            </View>
          </View>
        )}

        {effectiveOrigin && selectedDest ? (
          <MapView
            style={[styles.miniMap, selectedDest && { height: 130 }]}
            provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
            // Força o mapa CLARO em ambas as plataformas. No iOS, sem
            // `userInterfaceStyle`, o Apple Maps segue o modo escuro do
            // sistema (comportamento "automatic") — não é claro por padrão
            // como o comentário antigo assumia.
            customMapStyle={Platform.OS === 'android' ? [] : undefined}
            userInterfaceStyle="light"
            initialRegion={{
              latitude: (effectiveOrigin.lat + selectedDest.lat) / 2,
              longitude: (effectiveOrigin.lng + selectedDest.lng) / 2,
              latitudeDelta: Math.abs(effectiveOrigin.lat - selectedDest.lat) * 2 + 0.02,
              longitudeDelta: Math.abs(effectiveOrigin.lng - selectedDest.lng) * 2 + 0.02,
            }}
          >
            <Marker coordinate={{ latitude: effectiveOrigin.lat, longitude: effectiveOrigin.lng }}>
              <View style={styles.markerOrigin} />
            </Marker>
            <Marker coordinate={{ latitude: selectedDest.lat, longitude: selectedDest.lng }}>
              <View style={styles.markerDest} />
            </Marker>
            <Polyline
              coordinates={
                route?.coordinates ?? [
                  { latitude: effectiveOrigin.lat, longitude: effectiveOrigin.lng },
                  { latitude: selectedDest.lat, longitude: selectedDest.lng },
                ]
              }
              strokeColor={colors.accent}
              strokeWidth={route ? 4 : 2.5}
              lineDashPattern={route ? undefined : [8, 4]}
            />
          </MapView>
        ) : null}

        <View style={styles.searchSection}>
          <View style={styles.routeRow}>
            <View style={styles.routeIcon}>
              <View style={styles.dotOrigin} />
              <View style={styles.routeLine} />
              <View style={styles.dotDest} />
            </View>
            <View style={styles.routeInputs}>
              <View style={styles.originInputWrap}>
                <TextInput
                  style={[styles.originInput, activeField === 'origin' && styles.routeInputActive]}
                  value={originText}
                  onChangeText={(t) => { setOriginText(t); setSelectedOrigin(null); }}
                  onFocus={() => setActiveField('origin')}
                  placeholder={originAddress || t('requestRide.currentLocation')}
                  placeholderTextColor={colors.gray[400]}
                  numberOfLines={1}
                />
                {selectedOrigin && (
                  <TouchableOpacity
                    style={styles.clearOriginBtn}
                    onPress={() => { setSelectedOrigin(null); setOriginText(''); }}
                  >
                    <Text style={styles.clearOriginText}>✕</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={[styles.destInput, activeField === 'destination' && styles.routeInputActive]}
                value={destinationText}
                onChangeText={(t) => { setDestinationText(t); setSelectedDest(null); }}
                onFocus={() => setActiveField('destination')}
                placeholder={t('requestRide.destinationPlaceholder')}
                placeholderTextColor={colors.gray[400]}
                autoFocus
              />
            </View>
          </View>

          {selectedDest && (
            <View style={styles.estimateCard}>
              {/* Linha de preço / loading */}
              <View style={styles.categoryRow}>
                <View style={styles.categoryIcon}>
                  <Text style={{ fontSize: 22 }}>🚗</Text>
                </View>
                <View style={styles.categoryInfo}>
                  <Text style={styles.categoryName}>Executive XL</Text>
                  {distanceKm ? (
                    <Text style={styles.categoryDesc}>
                      {formatDistance(distanceKm)}{estimatedMin ? ` • ${estimatedMin} ${t('requestRide.minutesUnit')}` : ''}
                    </Text>
                  ) : (
                    <ActivityIndicator size="small" color={colors.accent} style={{ alignSelf: 'flex-start', marginTop: 2 }} />
                  )}
                </View>
                {displayTotal ? (
                  <Text style={styles.price}>
                    {formatCurrency(displayTotal)}
                    {!estimatedPrice && <Text style={styles.priceMin}> {t('requestRide.priceMin')}</Text>}
                  </Text>
                ) : (
                  <ActivityIndicator size="small" color={colors.accent} />
                )}
              </View>

              {tollAmount > 0 && displayPrice != null && (
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>{t('requestRide.tollIncluded')}</Text>
                  <Text style={styles.breakdownValue}>{formatCurrency(tollAmount)}</Text>
                </View>
              )}

              {venueFee > 0 && displayPrice != null && (
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>{t('requestRide.airportPortFee')}</Text>
                  <Text style={styles.breakdownValue}>{formatCurrency(venueFee)}</Text>
                </View>
              )}

              {surgeInfo.label && (
                <View style={styles.surgeBadge}>
                  <Text style={styles.surgeText}>{surgeInfo.label}</Text>
                </View>
              )}

              {/* Botões lado a lado */}
              <View style={styles.actionRow}>
                <TouchableOpacity style={styles.scheduleBtnInline} onPress={openScheduler}>
                  <Text style={styles.scheduleBtnInlineText}>🗓️</Text>
                  <Text style={styles.scheduleBtnInlineLabel}>{t('requestRide.schedule')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.requestBtnInline, (loading || !displayPrice) && { opacity: 0.6 }]}
                  onPress={handleRequest}
                  disabled={loading || !displayPrice}
                >
                  {loading
                    ? <ActivityIndicator color={colors.primary} size="small" />
                    : <Text style={styles.requestBtnText}>{t('requestRide.requestNow')}</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          )}

          <ScrollView style={styles.suggestionList} keyboardShouldPersistTaps="handled">
            {activeField === 'origin' ? (
              <>
                {!selectedOrigin && (
                  <TouchableOpacity
                    style={styles.suggestionItem}
                    onPress={() => { setSelectedOrigin(null); setOriginText(''); setOriginResults([]); }}
                  >
                    <Text style={styles.suggestionIcon}>📍</Text>
                    <View style={styles.suggestionTextWrap}>
                      <Text style={styles.suggestionText}>{t('requestRide.useMyLocation')}</Text>
                      {originAddress ? (
                        <Text style={styles.suggestionSub} numberOfLines={1}>{originAddress}</Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                )}
                {originSearching && (
                  <View style={styles.searchingRow}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={styles.searchingText}>{t('requestRide.searchingAddresses')}</Text>
                  </View>
                )}
                {!selectedOrigin && !originSearching && originResults.map((d, i) => (
                  <TouchableOpacity
                    key={`o-${d.lat}-${d.lng}-${i}`}
                    style={styles.suggestionItem}
                    onPress={() => { setSelectedOrigin(d); setOriginText(d.shortName); setActiveField('destination'); }}
                  >
                    <Text style={styles.suggestionIcon}>📍</Text>
                    <View style={styles.suggestionTextWrap}>
                      <Text style={styles.suggestionText} numberOfLines={1}>
                        {d.shortName}
                        {d.category ? <Text style={styles.suggestionTag}>{`  ·  ${d.category}`}</Text> : null}
                      </Text>
                      <Text style={styles.suggestionSub} numberOfLines={1}>{d.address}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                {!selectedOrigin && !originSearching && debouncedOriginQuery.trim().length >= 3 && originResults.length === 0 && (
                  <Text style={styles.noResults}>{t('requestRide.noAddressFound')}</Text>
                )}
              </>
            ) : (
              <>
                {searching && (
                  <View style={styles.searchingRow}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={styles.searchingText}>{t('requestRide.searchingAddresses')}</Text>
                  </View>
                )}
                {!selectedDest && !searching && results.map((d, i) => (
                  <TouchableOpacity
                    key={`${d.lat}-${d.lng}-${i}`}
                    style={styles.suggestionItem}
                    onPress={() => { setSelectedDest(d); setDestinationText(d.shortName); Keyboard.dismiss(); }}
                  >
                    <Text style={styles.suggestionIcon}>📍</Text>
                    <View style={styles.suggestionTextWrap}>
                      <Text style={styles.suggestionText} numberOfLines={1}>
                        {d.shortName}
                        {d.category ? <Text style={styles.suggestionTag}>{`  ·  ${d.category}`}</Text> : null}
                      </Text>
                      <Text style={styles.suggestionSub} numberOfLines={1}>{d.address}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
                {!selectedDest && !searching && debouncedQuery.trim().length >= 3 && results.length === 0 && (
                  <Text style={styles.noResults}>{t('requestRide.noAddressFound')}</Text>
                )}
                {!selectedDest && !searching && destinationText.trim().length < 3 && (
                  <Text style={styles.hint}>{t('requestRide.typeAtLeast3')}</Text>
                )}
              </>
            )}
          </ScrollView>
        </View>

        <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalSheet, Platform.OS === 'android' && { paddingBottom: 36 + insets.bottom }]}>
              <Text style={styles.modalTitle}>{t('requestRide.scheduleModalTitle')}</Text>
              <Text style={styles.modalSub}>{t('requestRide.scheduleModalSub')}</Text>

              {Platform.OS === 'ios' ? (
                <View style={styles.pickerWrap}>
                  <DateTimePicker
                    value={scheduledDate}
                    mode="datetime"
                    display="spinner"
                    minimumDate={new Date()}
                    onChange={(_e, d) => d && setScheduledDate(d)}
                    themeVariant="light"
                  />
                </View>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.androidDateRow}
                    activeOpacity={0.7}
                    onPress={() => setAndroidPickerMode('date')}
                  >
                    <Text style={styles.androidDateValue}>
                      {scheduledDate.toLocaleString('pt-BR', {
                        weekday: 'short', day: '2-digit', month: 'short',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </Text>
                    <Text style={styles.androidDateHint}>{t('requestRide.tapToChangeDateTime')}</Text>
                  </TouchableOpacity>
                  {androidPickerMode && (
                    <DateTimePicker
                      value={scheduledDate}
                      mode={androidPickerMode}
                      display="default"
                      is24Hour
                      minimumDate={androidPickerMode === 'date' ? new Date() : undefined}
                      onChange={onAndroidPickerChange}
                      themeVariant="light"
                    />
                  )}
                </>
              )}

              <Button title={t('requestRide.confirmSchedule')} onPress={confirmSchedule} loading={loading} />
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowPicker(false)}>
                <Text style={styles.modalCancelText}>{t('requestRide.cancel')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
    // Banner motorista QR
    lockedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.primary,
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    lockedIcon: { fontSize: 20 },
    lockedInfo: { flex: 1 },
    lockedLabel: { fontSize: 10, color: colors.accent, fontWeight: '700', letterSpacing: 1 },
    lockedName: { fontSize: 15, color: colors.white, fontWeight: '800' },
    lockedBadge: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    lockedBadgeText: { fontSize: 11, fontWeight: '800', color: colors.primary },
    back: { marginRight: 16, padding: 4 },
    backText: { fontSize: 24, color: colors.text },
    title: { fontSize: 20, fontWeight: '700', color: colors.text },
    miniMap: { height: 180 },
    searchSection: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
    routeRow: { flexDirection: 'row', marginBottom: 16 },
    routeIcon: { width: 20, alignItems: 'center', paddingTop: 16, marginRight: 12 },
    dotOrigin: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
    routeLine: { flex: 1, width: 2, backgroundColor: colors.gray[300], marginVertical: 4 },
    dotDest: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
    routeInputs: { flex: 1 },
    originInputWrap: { position: 'relative', marginBottom: 8 },
    originInput: {
      height: 44,
      backgroundColor: colors.gray[100],
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingRight: 36,
      fontSize: 14,
      color: colors.text,
      borderWidth: 1.5,
      borderColor: 'transparent',
    },
    routeInputActive: {
      borderColor: colors.accent,
    },
    clearOriginBtn: {
      position: 'absolute',
      right: 4,
      top: 4,
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    clearOriginText: { color: colors.gray[500], fontSize: 15, fontWeight: '700' },
    destInput: {
      height: 44,
      backgroundColor: colors.gray[100],
      borderRadius: 10,
      paddingHorizontal: 12,
      fontSize: 15,
      color: colors.text,
      borderWidth: 1.5,
      borderColor: colors.accent,
    },
    suggestionList: { flex: 1 },
    suggestionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.gray[100],
    },
    // Botões de ação lado a lado
    actionRow: {
      flexDirection: 'row',
      gap: 10,
    },
    scheduleBtnInline: {
      flex: 1,
      height: 50,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.gray[300],
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    scheduleBtnInlineText: {
      fontSize: 18,
      lineHeight: 22,
    },
    scheduleBtnInlineLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.gray[600],
    },
    requestBtnInline: {
      flex: 2,
      height: 50,
      borderRadius: 12,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    requestBtnText: {
      fontSize: 15,
      fontWeight: '800',
      color: colors.primary,
    },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    modalSheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: 24,
      paddingBottom: 36,
    },
    modalTitle: { fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center' },
    modalSub: { fontSize: 14, color: colors.gray[500], textAlign: 'center', marginTop: 4, marginBottom: 8 },
    pickerWrap: { alignItems: 'center', marginBottom: 12 },
    androidDateRow: {
      backgroundColor: colors.gray[100],
      borderRadius: 14,
      paddingVertical: 16,
      paddingHorizontal: 18,
      alignItems: 'center',
      marginBottom: 12,
    },
    androidDateValue: { fontSize: 18, fontWeight: '700', color: colors.text, textTransform: 'capitalize' },
    androidDateHint: { fontSize: 12, color: colors.gray[500], marginTop: 4 },
    modalCancel: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
    modalCancelText: { color: colors.gray[500], fontSize: 15, fontWeight: '600' },
    suggestionIcon: { fontSize: 18, marginRight: 12 },
    suggestionTextWrap: { flex: 1 },
    suggestionText: { fontSize: 14, color: colors.gray[800], fontWeight: '500' },
    suggestionSub: { fontSize: 12, color: colors.gray[400], marginTop: 2 },
    suggestionTag: { fontSize: 12, color: colors.accent, fontWeight: '600' },
    searchingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, gap: 10 },
    searchingText: { fontSize: 14, color: colors.gray[500] },
    noResults: { fontSize: 14, color: colors.gray[500], textAlign: 'center', paddingVertical: 24 },
    hint: { fontSize: 13, color: colors.gray[400], textAlign: 'center', paddingVertical: 24 },
    estimateCard: {
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: colors.gray[200],
      gap: 12,
      marginTop: 4,
    },
    categoryRow: { flexDirection: 'row', alignItems: 'center' },
    categoryIcon: {
      width: 44,
      height: 44,
      borderRadius: 10,
      backgroundColor: colors.gray[100],
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    categoryInfo: { flex: 1 },
    categoryName: { fontSize: 15, fontWeight: '700', color: colors.text },
    categoryDesc: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    price: { fontSize: 20, fontWeight: '800', color: colors.text },
    priceMin: { fontSize: 12, fontWeight: '500', color: colors.gray[500] },
    breakdownRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: colors.gray[100],
    },
    breakdownLabel: { fontSize: 12, color: colors.gray[500] },
    breakdownValue: { fontSize: 12, fontWeight: '700', color: colors.text },
    markerOrigin: {
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.white,
    },
    markerDest: {
      width: 12,
      height: 12,
      borderRadius: 2,
      backgroundColor: colors.primary,
      borderWidth: 2,
      borderColor: colors.white,
    },
    surgeBadge: {
      backgroundColor: '#FFF3CD',
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: '#FFCA2C',
      alignItems: 'center',
    },
    surgeText: {
      color: '#7B5800',
      fontSize: 13,
      fontWeight: '700',
    },
  });
}
