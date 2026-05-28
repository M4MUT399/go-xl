import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  TextInput, Platform, Dimensions,
} from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList, Location } from '../../types';
import { Colors } from '../../constants/colors';
import { useLocation } from '../../hooks/useLocation';
import { useAuth } from '../../hooks/useAuth';

const { height } = Dimensions.get('window');

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'PassengerTabs'> };

export function HomeScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { location } = useLocation();
  const mapRef = useRef<MapView>(null);
  const [destination, setDestination] = useState('');

  const firstName = profile?.full_name?.split(' ')[0] ?? 'Olá';

  function handleSearchFocus() {
    navigation.navigate('RequestRide', {
      destination: { lat: 0, lng: 0, address: destination },
    });
  }

  return (
    <View style={styles.container}>
      {location ? (
        <MapView
          ref={mapRef}
          style={styles.map}
          provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
          initialRegion={{
            latitude: location.lat,
            longitude: location.lng,
            latitudeDelta: 0.01,
            longitudeDelta: 0.01,
          }}
          showsUserLocation
          showsMyLocationButton={false}
          customMapStyle={darkMapStyle}
        >
          <Marker
            coordinate={{ latitude: location.lat, longitude: location.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={styles.userMarker}>
              <View style={styles.userMarkerDot} />
            </View>
          </Marker>
        </MapView>
      ) : (
        <View style={[styles.map, styles.mapPlaceholder]}>
          <Text style={styles.mapPlaceholderText}>Carregando mapa...</Text>
        </View>
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <View style={styles.greeting}>
            <Text style={styles.greetingText}>Olá, {firstName}</Text>
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryText}>✦ Executive XL</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.avatar}>
            <Text style={styles.avatarText}>{firstName[0]}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.searchContainer}>
          <TouchableOpacity style={styles.searchBox} onPress={handleSearchFocus} activeOpacity={0.9}>
            <View style={styles.originDot} />
            <Text style={styles.searchPlaceholder}>Para onde você vai?</Text>
            <View style={styles.searchArrow}>
              <Text style={styles.searchArrowText}>→</Text>
            </View>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a3646' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#16213e' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#0f3460' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#0f3460' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1b2a' }] },
];

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  mapPlaceholder: {
    backgroundColor: Colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapPlaceholderText: { color: Colors.gray[400] },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  greeting: {},
  greetingText: { fontSize: 20, fontWeight: '700', color: Colors.white },
  categoryBadge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(201,168,76,0.2)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 2,
  },
  categoryText: { color: Colors.accent, fontSize: 11, fontWeight: '600' },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontSize: 18, fontWeight: '800' },
  searchContainer: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: 16,
    paddingHorizontal: 16,
    height: 58,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  originDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.accent,
    marginRight: 12,
  },
  searchPlaceholder: { flex: 1, fontSize: 16, color: Colors.gray[400] },
  searchArrow: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchArrowText: { color: Colors.primary, fontSize: 16, fontWeight: '700' },
  userMarker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(201,168,76,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  userMarkerDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.accent,
  },
});
