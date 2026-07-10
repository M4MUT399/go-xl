import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  Animated, Alert, Platform, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { Button } from '../../components/common/Button';
import { useAuth } from '../../hooks/useAuth';
import { usePassengerRide } from '../../hooks/useRide';
import { formatCurrency } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../i18n';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'FindingDriver'>;
  route: RouteProp<RootStackParamList, 'FindingDriver'>;
};

export function FindingDriverScreen({ navigation, route }: Props) {
  const { ride: initialRide } = route.params;
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { cancelRide } = usePassengerRide(profile?.id);
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);

  const styles = makeStyles(colors);

  // Controla quando a navegação para fora desta tela pode prosseguir sem o
  // aviso de "cancelar corrida" (aceite do motorista, cancelamento do lado do
  // motorista/servidor). Toda outra tentativa de sair — botão "Cancelar
  // corrida", botão físico/gesto de voltar do Android/iOS — passa pelo mesmo
  // fluxo de confirmação em `beforeRemove` abaixo.
  const allowLeaveRef = useRef(false);

  const pulse1 = useRef(new Animated.Value(1)).current;
  const pulse2 = useRef(new Animated.Value(1)).current;
  const pulse3 = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const timer = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    function animatePulse(anim: Animated.Value, delay: number) {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 2.2, duration: 1200, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    }
    animatePulse(pulse1, 0);
    animatePulse(pulse2, 400);
    animatePulse(pulse3, 800);
  }, []);

  useEffect(() => {
    let done = false;
    const goActive = (ride: typeof initialRide) => {
      if (done) return;
      done = true;
      // Notifica o passageiro que a cobrança foi realizada ao aceitar, já com o
      // tempo estimado até o embarque (calculado pelo motorista no momento do aceite).
      const price = ride.price ? formatCurrency(ride.price) : '';
      const etaPhrase = ride.driver_eta_min
        ? ' ' + t('finding.etaArriving').replace('{min}', String(ride.driver_eta_min))
        : ' ' + t('finding.etaOnTheWay');
      Alert.alert(
        t('finding.chargeTitle'),
        price
          ? `${t('finding.chargeDebited').replace('{price}', price)}${etaPhrase}`
          : `${t('finding.chargeProcessed')}${etaPhrase}`,
        [{
          text: 'OK',
          onPress: () => {
            allowLeaveRef.current = true;
            navigation.replace('ActiveRide', { ride });
          },
        }],
      );
    };

    // 1) postgres_changes UPDATE (precisa de REPLICA IDENTITY FULL)
    const channel = supabase
      .channel(`ride-${initialRide.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${initialRide.id}` },
        (payload) => {
          const updated = payload.new as typeof initialRide;
          if (updated.status === 'accepted' || updated.status === 'driver_en_route') {
            goActive(updated);
          } else if (updated.status === 'cancelled') {
            allowLeaveRef.current = true;
            Alert.alert(t('finding.rideCancelledTitle'), t('finding.noDriverAvailable'));
            navigation.goBack();
          }
        }
      )
      .subscribe();

    // 2) Broadcast direto do motorista (não depende de WAL/RLS) — mais confiável no Expo Go
    const paxChannel = profile?.id
      ? supabase
          .channel(`pax-notify-${profile.id}`)
          .on('broadcast', { event: 'ride_accepted' }, ({ payload }) => {
            const ride = payload?.ride as typeof initialRide | undefined;
            if (ride && ride.id === initialRide.id) goActive(ride);
          })
          .subscribe()
      : null;

    // 3) Polling fallback (a cada 4s) — garante a confirmação mesmo se os canais falharem
    const interval = setInterval(async () => {
      const { data } = await supabase
        .from('rides')
        .select('*')
        .eq('id', initialRide.id)
        .maybeSingle();
      const updated = data as typeof initialRide | null;
      if (!updated) return;
      if (updated.status === 'accepted' || updated.status === 'driver_en_route') {
        goActive(updated);
      } else if (updated.status === 'cancelled') {
        allowLeaveRef.current = true;
        clearInterval(interval);
        Alert.alert(t('finding.rideCancelledTitle'), t('finding.noDriverAvailable'));
        navigation.goBack();
      }
    }, 4000);

    return () => {
      supabase.removeChannel(channel);
      if (paxChannel) supabase.removeChannel(paxChannel);
      clearInterval(interval);
    };
  }, [initialRide.id, profile?.id]);

  // Intercepta QUALQUER tentativa de sair desta tela — botão "Cancelar
  // corrida", botão físico de voltar do Android e o gesto de voltar do
  // iOS/Android incluídos, já que todos disparam o mesmo evento
  // `beforeRemove` do React Navigation. Antes, só o botão na tela cancelava
  // a corrida; voltar pelo gesto/botão físico apenas saía da tela sem
  // cancelar no servidor, deixando a corrida "requesting" órfã no banco.
  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e) => {
      if (allowLeaveRef.current) return; // aceite do motorista ou cancelamento já veio do servidor

      e.preventDefault();
      Alert.alert(
        t('finding.cancelRideTitle'),
        t('finding.cancelRideMessage'),
        [
          { text: t('finding.keepSearching'), style: 'cancel' },
          {
            text: t('finding.yesCancel'),
            style: 'destructive',
            onPress: async () => {
              await cancelRide(initialRide.id);
              allowLeaveRef.current = true;
              navigation.dispatch(e.data.action);
            },
          },
        ]
      );
    });
    return unsubscribe;
  }, [navigation, cancelRide, initialRide.id]);

  function handleCancel() {
    navigation.goBack();
  }

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <View style={styles.pulseContainer}>
          {[pulse1, pulse2, pulse3].map((anim, i) => (
            <Animated.View
              key={i}
              style={[
                styles.pulseRing,
                { transform: [{ scale: anim }], opacity: anim.interpolate({ inputRange: [1, 2.2], outputRange: [0.5, 0] }) },
              ]}
            />
          ))}
          <View style={styles.carCircle}>
            <Image source={require('../../../assets/icon.png')} style={styles.carLogo} />
          </View>
        </View>

        <Text style={styles.title}>{t('finding.title')}</Text>
        <Text style={styles.subtitle}>{t('finding.subtitle')}</Text>

        <View style={styles.timer}>
          <Text style={styles.timerText}>
            {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
          </Text>
          <Text style={styles.timerLabel}>{t('finding.searching')}</Text>
        </View>

        <View style={styles.tripInfo}>
          <View style={styles.infoRow}>
            <Text style={styles.infoIcon}>📍</Text>
            <Text style={styles.infoText} numberOfLines={1}>{rideOrigin(initialRide).address}</Text>
          </View>
          <View style={styles.infoSeparator} />
          <View style={styles.infoRow}>
            <Text style={styles.infoIcon}>🏁</Text>
            <Text style={styles.infoText} numberOfLines={1}>{rideDestination(initialRide).address}</Text>
          </View>
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>{t('finding.estimatedPrice')}</Text>
            <Text style={styles.price}>{formatCurrency(initialRide.price)}</Text>
          </View>
        </View>
      </View>

      <View style={[styles.footer, Platform.OS === 'android' && { paddingBottom: 32 + insets.bottom }]}>
        <Button title={t('finding.cancelRideTitle')} onPress={handleCancel} variant="outline" />
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    pulseContainer: { width: 120, height: 120, alignItems: 'center', justifyContent: 'center', marginBottom: 40 },
    pulseRing: {
      position: 'absolute',
      width: 100,
      height: 100,
      borderRadius: 50,
      backgroundColor: colors.accent,
    },
    carCircle: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Logo GoXL no lugar do emoji de carro — recortada em CÍRCULO (borderRadius
    // = metade do lado) para ficar concêntrica com o círculo dourado e os anéis
    // pulsantes. O círculo dourado vira um "halo" ao redor da logo.
    carLogo: { width: 56, height: 56, borderRadius: 28, resizeMode: 'cover' },
    title: { fontSize: 28, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: 12, lineHeight: 36 },
    subtitle: { fontSize: 15, color: colors.gray[400], textAlign: 'center', lineHeight: 22, marginBottom: 32 },
    timer: { alignItems: 'center', marginBottom: 32 },
    timerText: { fontSize: 42, fontWeight: '900', color: colors.accent, letterSpacing: -1 },
    timerLabel: { fontSize: 12, color: colors.gray[500], textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 },
    tripInfo: {
      width: '100%',
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.1)',
    },
    infoRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    infoIcon: { fontSize: 16, marginRight: 10 },
    infoText: { flex: 1, color: colors.gray[300], fontSize: 14 },
    infoSeparator: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 8 },
    priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, marginTop: 4, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' },
    priceLabel: { color: colors.gray[400], fontSize: 13 },
    price: { color: colors.accent, fontSize: 20, fontWeight: '800' },
    footer: { paddingHorizontal: 24, paddingBottom: 32 },
  });
}
