import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  TextInput, ScrollView, Alert, ActivityIndicator, Modal, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
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

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RequestRide'>;
  route: RouteProp<RootStackParamList, 'RequestRide'>;
};

export function RequestRideScreen({ navigation, route: screenRoute }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { location } = useLocation();
  const { requestRide, scheduleRide } = usePassengerRide(profile?.id);

  const styles = makeStyles(colors);

  const lockedDriverId   = screenRoute.params?.lockedDriverId;
  const lockedDriverName = screenRoute.params?.lockedDriverName;

  const [destinationText, setDestinationText] = useState('');
  const [selectedDest, setSelectedDest] = useState<Location | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [originAddress, setOriginAddress] = useState('Sua localização atual');
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date>(() => new Date(Date.now() + 30 * 60 * 1000));
  const [surgeInfo, setSurgeInfo] = useState<SurgeInfo>({ multiplier: 1.0, label: null });
  const [tollAmount, setTollAmount] = useState<number>(0);
  const [venueFee, setVenueFee] = useState<number>(0);

  const debouncedQuery = useDebounce(destinationText, 450);

  useEffect(() => {
    if (location) {
      reverseGeocode(location.lat, location.lng).then((addr) => {
        if (addr) setOriginAddress(addr);
      });
    }
  }, [location]);

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
  }, [debouncedQuery, selectedDest, location]);

  const { route } = useRoute(
    location ? { lat: location.lat, lng: location.lng } : null,
    selectedDest ? { lat: selectedDest.lat, lng: selectedDest.lng } : null
  );

  const distanceKm = route?.distanceKm
    ?? (selectedDest && location ? haversine(location, { lat: selectedDest.lat, lng: selectedDest.lng }) : null);

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
    if (!selectedDest || !location || !distanceKm) {
      setTollAmount(0);
      return;
    }
    let cancelled = false;
    estimateTollAmount({
      origin: { lat: location.lat, lng: location.lng },
      destination: { lat: selectedDest.lat, lng: selectedDest.lng },
      distanceKm,
    }).then((q) => {
      if (!cancelled) setTollAmount(q.amount);
    });
    return () => { cancelled = true; };
  }, [selectedDest, location, distanceKm]);

  // Taxa de aeroporto/porto (P6): estima por geofence. Sem zonas → 0, sem UI.
  useEffect(() => {
    if (!selectedDest || !location) {
      setVenueFee(0);
      return;
    }
    let cancelled = false;
    estimateAirportFees(
      { lat: location.lat, lng: location.lng },
      { lat: selectedDest.lat, lng: selectedDest.lng },
    ).then((r) => {
      if (!cancelled) setVenueFee(r.total);
    });
    return () => { cancelled = true; };
  }, [selectedDest, location]);

  async function handleRequest() {
    if (!selectedDest) {
      Alert.alert('Atenção', 'Selecione o destino.');
      return;
    }
    if (!location) {
      Alert.alert(
        'Localização não disponível',
        'Aguardando seu GPS. Tente novamente em alguns segundos ou verifique se a permissão de localização está ativada.',
      );
      return;
    }
    setLoading(true);
    const origin: Location = {
      lat: location.lat,
      lng: location.lng,
      address: originAddress,
    };
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
      Alert.alert('Erro ao solicitar', 'Verifique o terminal (Metro) para ver o erro detalhado.\n\npassengerId: ' + (profile?.id ?? 'NULL'));
    }
  }

  function openScheduler() {
    setScheduledDate(new Date(Date.now() + 30 * 60 * 1000));
    setShowPicker(true);
  }

  async function confirmSchedule() {
    if (!selectedDest || !location) return;
    if (scheduledDate.getTime() < Date.now() + 5 * 60 * 1000) {
      Alert.alert('Atenção', 'Escolha um horário pelo menos 5 minutos no futuro.');
      return;
    }
    setLoading(true);
    const origin: Location = { lat: location.lat, lng: location.lng, address: originAddress };
    const ride = await scheduleRide(
      origin,
      selectedDest,
      scheduledDate,
      route ? { distanceKm: route.distanceKm, durationMin: route.durationMin } : undefined
    );
    setLoading(false);
    setShowPicker(false);
    if (ride) {
      Alert.alert(
        'Pedido enviado!',
        `Seu agendamento para ${scheduledDate.toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} foi registrado.\n\nVocê receberá uma notificação assim que um motorista confirmar.`,
        [{ text: 'Ver agendamentos', onPress: () => navigation.replace('ScheduledRides') }]
      );
    } else {
      Alert.alert('Erro', 'Não foi possível agendar. Tente novamente.');
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
          <Text style={styles.title}>Para onde?</Text>
        </View>

        {/* Banner: motorista pré-selecionado via QR code */}
        {lockedDriverId && (
          <View style={styles.lockedBanner}>
            <Text style={styles.lockedIcon}>🔒</Text>
            <View style={styles.lockedInfo}>
              <Text style={styles.lockedLabel}>Motorista via QR Code</Text>
              <Text style={styles.lockedName}>{lockedDriverName ?? 'Executive XL'}</Text>
            </View>
            <View style={styles.lockedBadge}>
              <Text style={styles.lockedBadgeText}>Reservado</Text>
            </View>
          </View>
        )}

        {location && selectedDest ? (
          <MapView
            style={[styles.miniMap, selectedDest && { height: 130 }]}
            provider={undefined}
            initialRegion={{
              latitude: (location.lat + selectedDest.lat) / 2,
              longitude: (location.lng + selectedDest.lng) / 2,
              latitudeDelta: Math.abs(location.lat - selectedDest.lat) * 2 + 0.02,
              longitudeDelta: Math.abs(location.lng - selectedDest.lng) * 2 + 0.02,
            }}
          >
            <Marker coordinate={{ latitude: location.lat, longitude: location.lng }}>
              <View style={styles.markerOrigin} />
            </Marker>
            <Marker coordinate={{ latitude: selectedDest.lat, longitude: selectedDest.lng }}>
              <View style={styles.markerDest} />
            </Marker>
            <Polyline
              coordinates={
                route?.coordinates ?? [
                  { latitude: location.lat, longitude: location.lng },
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
              <View style={styles.originBox}>
                <Text style={styles.originLabel} numberOfLines={1}>{originAddress}</Text>
              </View>
              <TextInput
                style={styles.destInput}
                value={destinationText}
                onChangeText={(t) => { setDestinationText(t); setSelectedDest(null); }}
                placeholder="Digite o destino..."
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
                      {formatDistance(distanceKm)}{estimatedMin ? ` • ${estimatedMin} min` : ''}
                    </Text>
                  ) : (
                    <ActivityIndicator size="small" color={colors.accent} style={{ alignSelf: 'flex-start', marginTop: 2 }} />
                  )}
                </View>
                {displayTotal ? (
                  <Text style={styles.price}>
                    {formatCurrency(displayTotal)}
                    {!estimatedPrice && <Text style={styles.priceMin}> mín.</Text>}
                  </Text>
                ) : (
                  <ActivityIndicator size="small" color={colors.accent} />
                )}
              </View>

              {tollAmount > 0 && displayPrice != null && (
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>Pedágio incluído</Text>
                  <Text style={styles.breakdownValue}>{formatCurrency(tollAmount)}</Text>
                </View>
              )}

              {venueFee > 0 && displayPrice != null && (
                <View style={styles.breakdownRow}>
                  <Text style={styles.breakdownLabel}>Taxa de aeroporto/porto</Text>
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
                  <Text style={styles.scheduleBtnInlineLabel}>Agendar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.requestBtnInline, (loading || !displayPrice) && { opacity: 0.6 }]}
                  onPress={handleRequest}
                  disabled={loading || !displayPrice}
                >
                  {loading
                    ? <ActivityIndicator color={colors.primary} size="small" />
                    : <Text style={styles.requestBtnText}>Solicitar agora</Text>
                  }
                </TouchableOpacity>
              </View>
            </View>
          )}

          <ScrollView style={styles.suggestionList} keyboardShouldPersistTaps="handled">
            {searching && (
              <View style={styles.searchingRow}>
                <ActivityIndicator color={colors.accent} size="small" />
                <Text style={styles.searchingText}>Buscando endereços...</Text>
              </View>
            )}
            {!selectedDest && !searching && results.map((d, i) => (
              <TouchableOpacity
                key={`${d.lat}-${d.lng}-${i}`}
                style={styles.suggestionItem}
                onPress={() => { setSelectedDest(d); setDestinationText(d.shortName); }}
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
              <Text style={styles.noResults}>Nenhum endereço encontrado</Text>
            )}
            {!selectedDest && !searching && destinationText.trim().length < 3 && (
              <Text style={styles.hint}>Digite ao menos 3 letras para buscar o destino</Text>
            )}
          </ScrollView>
        </View>

        <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalSheet}>
              <Text style={styles.modalTitle}>Agendar corrida</Text>
              <Text style={styles.modalSub}>Escolha data e hora</Text>

              <View style={styles.pickerWrap}>
                <DateTimePicker
                  value={scheduledDate}
                  mode={Platform.OS === 'ios' ? 'datetime' : 'date'}
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  minimumDate={new Date()}
                  onChange={(_e, d) => d && setScheduledDate(d)}
                  themeVariant="light"
                />
              </View>

              <Button title="Confirmar agendamento" onPress={confirmSchedule} loading={loading} />
              <TouchableOpacity style={styles.modalCancel} onPress={() => setShowPicker(false)}>
                <Text style={styles.modalCancelText}>Cancelar</Text>
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
    originBox: {
      height: 44,
      backgroundColor: colors.gray[100],
      borderRadius: 10,
      justifyContent: 'center',
      paddingHorizontal: 12,
      marginBottom: 8,
    },
    originLabel: { color: colors.gray[500], fontSize: 14 },
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
