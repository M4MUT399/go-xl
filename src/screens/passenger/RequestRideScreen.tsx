import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  TextInput, ScrollView, Alert, ActivityIndicator, Modal, Platform,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList, Location } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { useLocation } from '../../hooks/useLocation';
import { useAuth } from '../../hooks/useAuth';
import { usePassengerRide, estimatePrice, estimateDuration, SurgeInfo } from '../../hooks/useRide';
import { getSurgeInfo } from '../../lib/surge';
import { formatCurrency, formatDistance } from '../../lib/format';
import { useDebounce } from '../../hooks/useDebounce';
import { useRoute } from '../../hooks/useRoute';
import { searchAddresses, reverseGeocode, GeocodeResult } from '../../lib/geocoding';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RequestRide'>;
  route: RouteProp<RootStackParamList, 'RequestRide'>;
};

export function RequestRideScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { location } = useLocation();
  const { requestRide, scheduleRide } = usePassengerRide(profile?.id);

  const [destinationText, setDestinationText] = useState('');
  const [selectedDest, setSelectedDest] = useState<Location | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [originAddress, setOriginAddress] = useState('Sua localização atual');
  const [loading, setLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date>(() => new Date(Date.now() + 30 * 60 * 1000));
  const [surgeInfo, setSurgeInfo] = useState<SurgeInfo>({ multiplier: 1.0, label: null });

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

  useEffect(() => {
    if (!selectedDest) return;
    getSurgeInfo().then(setSurgeInfo);
  }, [selectedDest]);

  async function handleRequest() {
    if (!selectedDest || !location) {
      Alert.alert('Atenção', 'Selecione o destino.');
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
      route ? { distanceKm: route.distanceKm, durationMin: route.durationMin } : undefined
    );
    setLoading(false);
    if (ride) {
      navigation.replace('FindingDriver', { ride });
    } else {
      Alert.alert('Erro', 'Não foi possível solicitar a corrida. Tente novamente.');
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
        'Corrida agendada!',
        `Agendada para ${scheduledDate.toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}.`,
        [{ text: 'Ver agendadas', onPress: () => navigation.replace('ScheduledRides') }]
      );
    } else {
      Alert.alert('Erro', 'Não foi possível agendar. Tente novamente.');
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Para onde?</Text>
      </View>

      {location && selectedDest ? (
        <MapView
          style={styles.miniMap}
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
            strokeColor={Colors.accent}
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
              placeholderTextColor={Colors.gray[400]}
              autoFocus
            />
          </View>
        </View>

        <ScrollView style={styles.suggestionList} keyboardShouldPersistTaps="handled">
          {searching && (
            <View style={styles.searchingRow}>
              <ActivityIndicator color={Colors.accent} size="small" />
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
                <Text style={styles.suggestionText} numberOfLines={1}>{d.shortName}</Text>
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

      {selectedDest && estimatedPrice && (
        <View style={styles.estimateCard}>
          <View style={styles.categoryRow}>
            <View style={styles.categoryIcon}>
              <Text style={{ fontSize: 24 }}>🚗</Text>
            </View>
            <View style={styles.categoryInfo}>
              <Text style={styles.categoryName}>Executive XL</Text>
              <Text style={styles.categoryDesc}>
                {formatDistance(distanceKm)} • {estimatedMin} min
              </Text>
            </View>
            <Text style={styles.price}>{formatCurrency(estimatedPrice)}</Text>
          </View>

          {surgeInfo.label && (
            <View style={styles.surgeBadge}>
              <Text style={styles.surgeText}>{surgeInfo.label}</Text>
            </View>
          )}

          <Button
            title="Solicitar Executive XL"
            onPress={handleRequest}
            loading={loading}
          />
          <TouchableOpacity style={styles.scheduleBtn} onPress={openScheduler}>
            <Text style={styles.scheduleBtnText}>🗓️  Agendar para depois</Text>
          </TouchableOpacity>
        </View>
      )}

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  back: { marginRight: 16, padding: 4 },
  backText: { fontSize: 24, color: Colors.primary },
  title: { fontSize: 20, fontWeight: '700', color: Colors.primary },
  miniMap: { height: 180 },
  searchSection: { flex: 1, paddingHorizontal: 16, paddingTop: 16 },
  routeRow: { flexDirection: 'row', marginBottom: 16 },
  routeIcon: { width: 20, alignItems: 'center', paddingTop: 16, marginRight: 12 },
  dotOrigin: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.accent },
  routeLine: { flex: 1, width: 2, backgroundColor: Colors.gray[300], marginVertical: 4 },
  dotDest: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary },
  routeInputs: { flex: 1 },
  originBox: {
    height: 44,
    backgroundColor: Colors.gray[100],
    borderRadius: 10,
    justifyContent: 'center',
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  originLabel: { color: Colors.gray[500], fontSize: 14 },
  destInput: {
    height: 44,
    backgroundColor: Colors.gray[100],
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    color: Colors.black,
    borderWidth: 1.5,
    borderColor: Colors.accent,
  },
  suggestionList: { flex: 1 },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.gray[100],
  },
  scheduleBtn: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  scheduleBtnText: { color: Colors.primary, fontSize: 15, fontWeight: '700' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 36,
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: Colors.primary, textAlign: 'center' },
  modalSub: { fontSize: 14, color: Colors.gray[500], textAlign: 'center', marginTop: 4, marginBottom: 8 },
  pickerWrap: { alignItems: 'center', marginBottom: 12 },
  modalCancel: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  modalCancelText: { color: Colors.gray[500], fontSize: 15, fontWeight: '600' },
  suggestionIcon: { fontSize: 18, marginRight: 12 },
  suggestionTextWrap: { flex: 1 },
  suggestionText: { fontSize: 14, color: Colors.gray[800], fontWeight: '500' },
  suggestionSub: { fontSize: 12, color: Colors.gray[400], marginTop: 2 },
  searchingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, gap: 10 },
  searchingText: { fontSize: 14, color: Colors.gray[500] },
  noResults: { fontSize: 14, color: Colors.gray[500], textAlign: 'center', paddingVertical: 24 },
  hint: { fontSize: 13, color: Colors.gray[400], textAlign: 'center', paddingVertical: 24 },
  estimateCard: {
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: Colors.gray[200],
    gap: 16,
  },
  categoryRow: { flexDirection: 'row', alignItems: 'center' },
  categoryIcon: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  categoryInfo: { flex: 1 },
  categoryName: { fontSize: 16, fontWeight: '700', color: Colors.primary },
  categoryDesc: { fontSize: 13, color: Colors.gray[500], marginTop: 2 },
  price: { fontSize: 20, fontWeight: '800', color: Colors.primary },
  markerOrigin: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.white,
  },
  markerDest: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: Colors.primary,
    borderWidth: 2,
    borderColor: Colors.white,
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
