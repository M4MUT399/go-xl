import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Platform, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { CarMarker } from '../../components/common/CarMarker';
import { CrosshairIcon } from '../../components/common/CrosshairIcon';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList, Location } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useLocation } from '../../hooks/useLocation';
import { useAuth } from '../../hooks/useAuth';
import { useNearbyDrivers } from '../../hooks/useNearbyDrivers';
import { useUnreadMessages } from '../../hooks/useUnreadMessages';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'PassengerTabs'> };

export function HomeScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { location, status, retry } = useLocation();
  const { drivers } = useNearbyDrivers(true);
  const { chatRides, totalUnread, refresh } = useUnreadMessages(profile?.id);

  const styles = makeStyles(colors);

  // Recarrega o badge de mensagens toda vez que a tela entra em foco
  // (ex.: usuário volta do chat → AsyncStorage já atualizado → badge some)
  useFocusEffect(
    React.useCallback(() => { refresh(); }, [refresh])
  );
  const mapRef = useRef<MapView>(null);
  const [destination, setDestination] = useState('');

  const firstName = profile?.full_name?.split(' ')[0] ?? 'Olá';

  function handleOpenChat() {
    const target = chatRides.find(r => r.unread > 0) ?? chatRides[0];
    if (target) {
      navigation.navigate('Chat', { rideId: target.rideId, title: target.title });
    }
  }

  function handleSearchFocus() {
    navigation.navigate('RequestRide', {
      destination: { lat: 0, lng: 0, address: destination },
    });
  }

  function recenter() {
    if (location && mapRef.current) {
      mapRef.current.animateToRegion({
        latitude: location.lat,
        longitude: location.lng,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      });
    }
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
          // O estilo escuro (navy/gold) do Google Maps SDK no Android renderiza
          // como "modo noturno" mesmo de dia — visualmente diferente do MapKit
          // (iOS), que aplica o mesmo customMapStyle de forma mais suave. Por
          // isso, no Android usamos o estilo padrão (claro) do Maps.
          customMapStyle={Platform.OS === 'android' ? [] : darkMapStyle}
        >
          <Marker
            coordinate={{ latitude: location.lat, longitude: location.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={styles.userMarker}>
              <View style={styles.userMarkerDot} />
            </View>
          </Marker>

          {drivers.map((d) => (
            <Marker
              key={d.driver_id}
              coordinate={{ latitude: d.lat, longitude: d.lng }}
              anchor={{ x: 0.5, y: 0.5 }}
              rotation={d.heading ?? 0}
              tracksViewChanges={false}
            >
              <CarMarker />
            </Marker>
          ))}
        </MapView>
      ) : (
        <View style={[styles.map, styles.mapPlaceholder]}>
          {status === 'loading' ? (
            <Text style={styles.mapPlaceholderText}>Carregando mapa...</Text>
          ) : (
            <View style={styles.mapError}>
              <Text style={styles.mapErrorEmoji}>📍</Text>
              <Text style={styles.mapErrorTitle}>
                {status === 'denied' ? 'Localização desativada' : 'Sem localização'}
              </Text>
              <Text style={styles.mapErrorText}>
                {status === 'denied'
                  ? 'O Go XL precisa da sua localização para encontrar motoristas e definir o embarque.'
                  : 'Não foi possível obter sua localização. Verifique se o GPS está ligado.'}
              </Text>
              <TouchableOpacity
                style={styles.mapErrorBtn}
                onPress={() => (status === 'denied' ? Linking.openSettings() : retry())}
              >
                <Text style={styles.mapErrorBtnText}>
                  {status === 'denied' ? 'Abrir ajustes' : 'Tentar novamente'}
                </Text>
              </TouchableOpacity>
            </View>
          )}
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
          <View style={styles.topActions}>
            <TouchableOpacity style={styles.scheduleIcon} onPress={() => navigation.navigate('ScheduledRides')}>
              <Text style={styles.scheduleIconText}>🗓️</Text>
            </TouchableOpacity>
            {chatRides.length > 0 && (
              <TouchableOpacity style={styles.chatIcon} onPress={handleOpenChat}>
                <Text style={styles.chatIconText}>💬</Text>
                {totalUnread > 0 && (
                  <View style={styles.chatBadge}>
                    <Text style={styles.chatBadgeText}>
                      {totalUnread > 9 ? '9+' : String(totalUnread)}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.avatar}>
              <Text style={styles.avatarText}>{firstName[0]}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.bottomArea} pointerEvents="box-none">
          <View style={styles.bottomRow} pointerEvents="box-none">
            <View style={styles.driversStatus}>
              <View style={[styles.statusDot, drivers.length > 0 ? styles.statusOnline : styles.statusOffline]} />
              <Text style={styles.driversStatusText}>
                {drivers.length > 0
                  ? `${drivers.length} ${drivers.length === 1 ? 'motorista' : 'motoristas'} por perto`
                  : 'Procurando motoristas...'}
              </Text>
            </View>
            <TouchableOpacity style={styles.recenterBtn} onPress={recenter}>
              <CrosshairIcon size={27.5} color={colors.primary} />
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

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1 },
    map: { flex: 1 },
    mapPlaceholder: {
      backgroundColor: colors.primaryLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    mapPlaceholderText: { color: colors.gray[400] },
    mapError: { alignItems: 'center', paddingHorizontal: 40 },
    mapErrorEmoji: { fontSize: 40, marginBottom: 12 },
    mapErrorTitle: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 8 },
    mapErrorText: { color: colors.gray[400], fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
    mapErrorBtn: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    mapErrorBtnText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
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
      paddingBottom: 14,
      // Navy 50% translúcido — mantém nome, calendário e ícones legíveis
      // sobre o mapa em qualquer condição de navegação.
      backgroundColor: 'rgba(26,26,46,0.5)',
    },
    greeting: {},
    greetingText: { fontSize: 20, fontWeight: '700', color: colors.white },
    categoryBadge: {
      alignSelf: 'flex-start',
      backgroundColor: 'rgba(201,168,76,0.2)',
      borderRadius: 12,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginTop: 2,
    },
    categoryText: { color: colors.accent, fontSize: 11, fontWeight: '600' },
    topActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    scheduleIcon: {
      width: 79,
      height: 79,
      borderRadius: 39.5,
      backgroundColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    scheduleIconText: { fontSize: 34 },
    chatIcon: {
      width: 79,
      height: 79,
      borderRadius: 39.5,
      backgroundColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    chatIconText: { fontSize: 34 },
    chatBadge: {
      position: 'absolute',
      top: 2,
      right: 2,
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: '#ef4444',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
      borderWidth: 1.5,
      borderColor: 'rgba(26,26,46,0.9)',
    },
    chatBadgeText: { color: colors.white, fontSize: 10, fontWeight: '800' },
    avatar: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.primary, fontSize: 18, fontWeight: '800' },
    bottomArea: {},
    bottomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      marginBottom: 12,
    },
    driversStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(15,15,30,0.85)',
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
    statusOnline: { backgroundColor: '#22C55E' },
    statusOffline: { backgroundColor: colors.gray[400] },
    driversStatusText: { color: colors.white, fontSize: 13, fontWeight: '600' },
    recenterBtn: {
      // 25% maior que o botão original (44 → 55) e com visual de mira.
      width: 55,
      height: 55,
      borderRadius: 27.5,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 5,
    },

    searchContainer: {
      paddingHorizontal: 16,
      paddingBottom: 32,
    },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
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
      backgroundColor: colors.accent,
      marginRight: 12,
    },
    searchPlaceholder: { flex: 1, fontSize: 16, color: colors.gray[400] },
    searchArrow: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchArrowText: { color: colors.primary, fontSize: 16, fontWeight: '700' },
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
      backgroundColor: colors.accent,
    },
  });
}
