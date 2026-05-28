import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  TextInput, ScrollView, Alert,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList, Location } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { useLocation } from '../../hooks/useLocation';
import { useAuth } from '../../hooks/useAuth';
import { usePassengerRide, estimatePrice, estimateDuration } from '../../hooks/useRide';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'RequestRide'>;
  route: RouteProp<RootStackParamList, 'RequestRide'>;
};

const MOCK_DESTINATIONS: Location[] = [
  { address: 'Aeroporto Internacional de Florianópolis', lat: -27.6697, lng: -48.5487 },
  { address: 'Shopping Iguatemi Florianópolis', lat: -27.5791, lng: -48.5145 },
  { address: 'Centro de Florianópolis', lat: -27.5969, lng: -48.5495 },
  { address: 'Costão do Santinho Resort', lat: -27.4611, lng: -48.3847 },
  { address: 'Jurerê Internacional', lat: -27.4333, lng: -48.5167 },
];

export function RequestRideScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { location } = useLocation();
  const { requestRide } = usePassengerRide(profile?.id);

  const [destinationText, setDestinationText] = useState('');
  const [selectedDest, setSelectedDest] = useState<Location | null>(null);
  const [loading, setLoading] = useState(false);

  const filtered = destinationText.length > 1
    ? MOCK_DESTINATIONS.filter(d =>
        d.address.toLowerCase().includes(destinationText.toLowerCase())
      )
    : MOCK_DESTINATIONS;

  const distanceKm = selectedDest && location
    ? haversine(location, { lat: selectedDest.lat, lng: selectedDest.lng })
    : null;

  const estimatedPrice = distanceKm ? estimatePrice(distanceKm) : null;
  const estimatedMin = distanceKm ? estimateDuration(distanceKm) : null;

  async function handleRequest() {
    if (!selectedDest || !location) {
      Alert.alert('Atenção', 'Selecione o destino.');
      return;
    }
    setLoading(true);
    const origin: Location = {
      lat: location.lat,
      lng: location.lng,
      address: 'Sua localização atual',
    };
    const ride = await requestRide(origin, selectedDest);
    setLoading(false);
    if (ride) {
      navigation.replace('FindingDriver', { ride });
    } else {
      Alert.alert('Erro', 'Não foi possível solicitar a corrida. Tente novamente.');
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
            coordinates={[
              { latitude: location.lat, longitude: location.lng },
              { latitude: selectedDest.lat, longitude: selectedDest.lng },
            ]}
            strokeColor={Colors.accent}
            strokeWidth={2.5}
            lineDashPattern={[8, 4]}
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
              <Text style={styles.originLabel}>Sua localização</Text>
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
          {!selectedDest && filtered.map((d, i) => (
            <TouchableOpacity
              key={i}
              style={styles.suggestionItem}
              onPress={() => { setSelectedDest(d); setDestinationText(d.address); }}
            >
              <Text style={styles.suggestionIcon}>📍</Text>
              <Text style={styles.suggestionText}>{d.address}</Text>
            </TouchableOpacity>
          ))}
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
                {distanceKm?.toFixed(1)} km • {estimatedMin} min
              </Text>
            </View>
            <Text style={styles.price}>R$ {estimatedPrice.toFixed(2)}</Text>
          </View>

          <Button
            title="Solicitar Executive XL"
            onPress={handleRequest}
            loading={loading}
          />
        </View>
      )}
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
  suggestionIcon: { fontSize: 18, marginRight: 12 },
  suggestionText: { flex: 1, fontSize: 14, color: Colors.gray[800] },
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
});
