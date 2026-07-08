import React from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ScrollView, Alert, Image, useWindowDimensions,
} from 'react-native';
import Svg, {
  Defs, LinearGradient as SvgLinearGradient, Stop,
  Rect, Circle,
} from 'react-native-svg';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../hooks/useTheme';
import { Button } from '../components/common/Button';
import { useAuth } from '../hooks/useAuth';
import { useVehicle } from '../hooks/useVehicle';
import { useUserStats } from '../hooks/useUserStats';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../i18n';
import { LanguageSelector } from '../components/common/LanguageSelector';
import type { RootStackParamList } from '../types';
import type { UserStats } from '../hooks/useUserStats';
import type { Profile } from '../types';

type ProfileRoute = 'EditProfile' | 'Payment' | 'NotificationSettings' | 'TrustedContacts' | 'Support' | 'Terms' | 'QRCode' | 'DriverVerification';

const MENU_ITEMS: { icon: string; labelKey: string; route: ProfileRoute; driverOnly?: boolean; passengerOnly?: boolean }[] = [
  { icon: '👤', labelKey: 'profile.personalData', route: 'EditProfile' },
  { icon: '📲', labelKey: 'profile.myQr', route: 'QRCode', driverOnly: true },
  { icon: '🪪', labelKey: 'profile.verification', route: 'DriverVerification', driverOnly: true },
  { icon: '💳', labelKey: 'profile.payment', route: 'Payment' },
  { icon: '🔔', labelKey: 'profile.notifications', route: 'NotificationSettings' },
  { icon: '🛡️', labelKey: 'profile.trustedContacts', route: 'TrustedContacts', passengerOnly: true },
  { icon: '🛟', labelKey: 'profile.support', route: 'Support' },
  { icon: '📄', labelKey: 'profile.terms', route: 'Terms' },
];

// ─── Credit Card component ───────────────────────────────────────────────────

interface CreditCardProps {
  profile: Profile | null;
  stats: UserStats;
  initial: string;
  isDriver: boolean;
  t: (key: string) => string;
}

function ProfileCreditCard({ profile, stats, initial, isDriver, t }: CreditCardProps) {
  const { width: screenWidth } = useWindowDimensions();
  const W = screenWidth - 32;
  // Proporção real de cartão de crédito (ISO 7810 ID-1 ≈ 1.586:1).
  const H = Math.round(W / 1.586);

  const memberYear = profile?.created_at
    ? new Date(profile.created_at).getFullYear()
    : new Date().getFullYear();

  return (
    <View style={[cc.card, { width: W, height: H }]}>

      {/* ── SVG background ───────────────────────────────── */}
      <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
        <Defs>
          {/* Main dark-navy gradient */}
          <SvgLinearGradient id="bg" x1="0" y1="0" x2={W} y2={H}
            gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#07091A" />
            <Stop offset="0.55" stopColor="#101828" />
            <Stop offset="1" stopColor="#091520" />
          </SvgLinearGradient>
          {/* Gold diagonal shine */}
          <SvgLinearGradient id="shine" x1="0" y1="0" x2={W} y2={H}
            gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#C9A84C" stopOpacity="0" />
            <Stop offset="0.45" stopColor="#C9A84C" stopOpacity="0.06" />
            <Stop offset="1" stopColor="#C9A84C" stopOpacity="0" />
          </SvgLinearGradient>
        </Defs>

        {/* Base fill */}
        <Rect width={W} height={H} rx={20} fill="url(#bg)" />
        {/* Shine overlay */}
        <Rect width={W} height={H} rx={20} fill="url(#shine)" />

        {/* Decorative arcs — top-right corner */}
        <Circle cx={W + 8} cy={-12} r={130} fill="none"
          stroke="#C9A84C" strokeWidth={0.7} strokeOpacity={0.22} />
        <Circle cx={W + 8} cy={-12} r={98} fill="none"
          stroke="#C9A84C" strokeWidth={0.5} strokeOpacity={0.15} />
        <Circle cx={W + 8} cy={-12} r={68} fill="none"
          stroke="#C9A84C" strokeWidth={0.4} strokeOpacity={0.10} />

        {/* Hairline separator above bottom row */}
        <Rect x={0} y={H - 44} width={W} height={0.5}
          fill="#C9A84C" fillOpacity={0.2} />

        {/* Mastercard-style overlapping circles — bottom-right */}
        <Circle cx={W - 48} cy={H - 22} r={20} fill="#C9A84C" fillOpacity={0.65} />
        <Circle cx={W - 30} cy={H - 22} r={20} fill="#E8C96A" fillOpacity={0.40} />
      </Svg>

      {/* ── Top row: logo + NFC ──────────────────────────── */}
      <View style={cc.topRow}>
        <View style={cc.logoGroup}>
          <Image source={require('../../assets/icon.png')} style={cc.logo} />
        </View>
        {/* NFC concentric-circle ornament */}
        <View style={cc.nfc}>
          <View style={cc.nfcRing3} />
          <View style={cc.nfcRing2} />
          <View style={cc.nfcRing1} />
        </View>
      </View>

      {/* ── Main row: info + photo ────────────────────────── */}
      <View style={cc.mainRow}>

        {/* Left — name / badge / stats */}
        <View style={cc.infoCol}>
          <Text style={cc.holderName}>
            {profile?.full_name?.toUpperCase() ?? 'DRIVER'}
          </Text>

          <View style={cc.rolePill}>
            {isDriver ? (
              <View style={cc.rolePillRow}>
                <Image source={require('../../assets/icon.png')} style={cc.roleLogo} />
                <Text style={cc.roleText}>EXECUTIVE DRIVER</Text>
              </View>
            ) : (
              <Text style={cc.roleText}>🧳  PASSENGER</Text>
            )}
          </View>

          <View style={cc.statsRow}>
            <View style={cc.statBlock}>
              <Text style={cc.statVal}>★ {stats.rating.toFixed(1)}</Text>
              <Text style={cc.statLabel}>
                {stats.ratingCount > 0
                  ? `${stats.ratingCount} ${t('profile.ratings')}`
                  : t('profile.rating')}
              </Text>
            </View>
            <View style={cc.statDivider} />
            <View style={cc.statBlock}>
              <Text style={cc.statVal}>{stats.totalRides}</Text>
              <Text style={cc.statLabel}>{t('profile.rides')}</Text>
            </View>
          </View>
        </View>

        {/* Right — profile photo */}
        <View style={cc.photoCol}>
          <View style={cc.photoRing}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={cc.photo} />
            ) : (
              <View style={cc.photoFallback}>
                <Image source={require('../../assets/icon.png')} style={cc.photoFallbackLogo} />
              </View>
            )}
          </View>
        </View>

      </View>

      {/* ── Bottom strip: member since + dot pattern ─────── */}
      <View style={cc.bottomRow}>
        <Text style={cc.memberSince}>MEMBER SINCE  {memberYear}</Text>
        <Text style={cc.dotRow}>•••• •••• ••••</Text>
        {/* spacer so dots don't overlap the Mastercard circles */}
        <View style={{ width: 68 }} />
      </View>

    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function ProfileScreen() {
  const { profile, signOut, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const isDriver = profile?.type === 'driver';
  const { vehicle, refresh } = useVehicle(isDriver ? profile?.id : undefined);
  const { stats, refresh: refreshStats } = useUserStats(profile?.id, profile?.type ?? 'passenger');
  const initial = profile?.full_name?.[0]?.toUpperCase() ?? '?';

  const styles = makeStyles(colors);

  useFocusEffect(
    React.useCallback(() => {
      refreshProfile?.();
      refreshStats();
      if (isDriver) refresh();
    }, [isDriver, refresh, refreshProfile, refreshStats])
  );

  function handleSignOut() {
    Alert.alert(t('profile.signOut'), t('profile.confirmSignOut'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('profile.signOut'), style: 'destructive', onPress: signOut },
    ]);
  }

  async function handleChangeLanguage(l: string) {
    if (profile?.id) {
      await supabase.from('profiles').update({ language: l }).eq('id', profile.id);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>

        {/* ── Credit card ─────────────────────────────────── */}
        <ProfileCreditCard
          profile={profile}
          stats={stats}
          initial={initial}
          isDriver={isDriver}
          t={t}
        />

        {/* ── Language selector — passenger: logo abaixo do card */}
        {!isDriver && (
          <View style={styles.langCard}>
            <LanguageSelector onChange={handleChangeLanguage} label={t('profile.language')} />
          </View>
        )}

        {/* ── Contact info ─────────────────────────────────── */}
        <View style={styles.contactCard}>
          <View style={styles.contactRow}>
            <Text style={styles.contactIcon}>📧</Text>
            <Text style={styles.contactText}>{profile?.email}</Text>
          </View>
          <View style={styles.contactDivider} />
          <View style={styles.contactRow}>
            <Text style={styles.contactIcon}>📱</Text>
            <Text style={styles.contactText}>{profile?.phone}</Text>
          </View>
        </View>

        {/* ── Vehicle card + language (driver only) ────────── */}
        {isDriver && (
          <>
            <View style={styles.vehicleCard}>
              <View style={styles.vehicleHeader}>
                <Text style={styles.vehicleTitle}>{t('profile.myVehicle')}</Text>
                <TouchableOpacity onPress={() => navigation.navigate('VehicleForm')}>
                  <Text style={styles.vehicleAction}>{vehicle ? t('common.edit') : t('common.register')}</Text>
                </TouchableOpacity>
              </View>
              {vehicle ? (
                <View style={styles.vehicleBody}>
                  <Text style={styles.vehicleEmoji}>🚙</Text>
                  <View style={styles.vehicleInfo}>
                    <Text style={styles.vehicleModel}>{vehicle.model}</Text>
                    <Text style={styles.vehicleMeta}>{vehicle.color} • {vehicle.year}</Text>
                  </View>
                  <View style={styles.plateBox}>
                    <Text style={styles.plateText}>{vehicle.plate}</Text>
                  </View>
                </View>
              ) : (
                <TouchableOpacity style={styles.vehicleEmpty} onPress={() => navigation.navigate('VehicleForm')}>
                  <Text style={styles.vehicleEmptyText}>{t('profile.registerCarHint')}</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Language selector — just below the vehicle card for drivers */}
            <View style={styles.langCard}>
              <LanguageSelector onChange={handleChangeLanguage} label={t('profile.language')} />
            </View>
          </>
        )}

        {/* ── Menu ─────────────────────────────────────────── */}
        <View style={styles.menu}>
          {MENU_ITEMS
            .filter((item) => !(isDriver && item.route === 'Payment'))
            .filter((item) => !item.driverOnly || isDriver)
            .filter((item) => !item.passengerOnly || !isDriver)
            .map((item, i, arr) => (
              <TouchableOpacity
                key={item.route}
                style={[styles.menuItem, i < arr.length - 1 && styles.menuItemBorder]}
                onPress={() => navigation.navigate(item.route)}
              >
                <Text style={styles.menuIcon}>{item.icon}</Text>
                <Text style={styles.menuLabel}>{t(item.labelKey)}</Text>
                <Text style={styles.menuArrow}>›</Text>
              </TouchableOpacity>
            ))}
        </View>

        <Button title={t('profile.signOut')} onPress={handleSignOut} variant="outline" style={styles.signOut} />

        <Text style={styles.version}>Go XL • v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Credit Card styles ───────────────────────────────────────────────────────

const GOLD = '#C9A84C';
const GOLD_DIM = 'rgba(201,168,76,0.7)';
const GOLD_FAINT = 'rgba(201,168,76,0.18)';
const WHITE = '#FFFFFF';

const cc = StyleSheet.create({
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    padding: 18,
    paddingBottom: 0,
    marginBottom: 16,
    justifyContent: 'space-between',
    // Gold glow shadow
    shadowColor: GOLD,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.30,
    shadowRadius: 22,
    elevation: 16,
  },

  // Top row
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  logoGroup: { flexDirection: 'row', alignItems: 'center' },
  logo: { width: 52, height: 52, borderRadius: 14 },
  brandText: { display: 'none' },
  // NFC ornament
  nfc: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  nfcRing3: {
    position: 'absolute',
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 1.2, borderColor: `rgba(201,168,76,0.45)`,
  },
  nfcRing2: {
    position: 'absolute',
    width: 21, height: 21, borderRadius: 10.5,
    borderWidth: 1.2, borderColor: `rgba(201,168,76,0.35)`,
  },
  nfcRing1: {
    position: 'absolute',
    width: 11, height: 11, borderRadius: 5.5,
    borderWidth: 1.2, borderColor: `rgba(201,168,76,0.5)`,
  },

  // Main content row
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingBottom: 2,
  },
  infoCol: { flex: 1, paddingRight: 12 },
  holderName: {
    color: WHITE,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 1.4,
    marginBottom: 5,
    flexShrink: 1,
  },
  rolePill: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: `rgba(201,168,76,0.4)`,
    backgroundColor: GOLD_FAINT,
    borderRadius: 20,
    paddingHorizontal: 9,
    paddingVertical: 3,
    marginBottom: 8,
  },
  roleText: {
    color: GOLD,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  rolePillRow: { flexDirection: 'row', alignItems: 'center' },
  // Logo GoXL no lugar do emoji de carro — ~25% maior que o emoji que substituiu.
  roleLogo: { width: 14, height: 14, borderRadius: 3.5, marginRight: 5 },
  statsRow: { flexDirection: 'row', alignItems: 'center' },
  statBlock: {},
  statVal: { color: WHITE, fontSize: 16, fontWeight: '800' },
  statLabel: { color: GOLD_DIM, fontSize: 9, marginTop: 1, letterSpacing: 0.5 },
  statDivider: {
    width: 1, height: 26,
    backgroundColor: `rgba(201,168,76,0.3)`,
    marginHorizontal: 12,
  },

  // Photo
  photoCol: { alignItems: 'center', justifyContent: 'center' },
  photoRing: {
    width: 86, height: 86, borderRadius: 43,
    borderWidth: 2.5, borderColor: GOLD,
    padding: 3,
    // Gold glow on photo
    shadowColor: GOLD,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 10,
  },
  photo: { width: 78, height: 78, borderRadius: 39 },
  photoFallback: {
    width: 78, height: 78, borderRadius: 39,
    backgroundColor: GOLD,
    alignItems: 'center', justifyContent: 'center',
  },
  // Logo GoXL como placeholder — 25% maior que o tamanho-base de um ícone
  // discreto (56px), preenchendo bem o círculo sem tocar a borda dourada.
  photoFallbackLogo: { width: 70, height: 70, borderRadius: 18 },

  // Bottom strip
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 44,
    paddingBottom: 2,
  },
  memberSince: {
    color: GOLD_DIM,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 2,
  },
  dotRow: {
    color: 'rgba(255,255,255,0.18)',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
  },
});

// ─── Screen styles ────────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 16, paddingTop: 12 },
    contactCard: { backgroundColor: colors.card, borderRadius: 16, padding: 16, marginBottom: 16 },
    contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    contactIcon: { fontSize: 16, marginRight: 12 },
    contactText: { fontSize: 14, color: colors.gray[700] },
    contactDivider: { height: 1, backgroundColor: colors.gray[100], marginVertical: 6, marginLeft: 28 },
    vehicleCard: { backgroundColor: colors.card, borderRadius: 16, padding: 16, marginBottom: 16 },
    vehicleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    vehicleTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
    vehicleAction: { fontSize: 14, fontWeight: '700', color: colors.accent },
    vehicleBody: { flexDirection: 'row', alignItems: 'center' },
    vehicleEmoji: { fontSize: 36, marginRight: 12 },
    vehicleInfo: { flex: 1 },
    vehicleModel: { fontSize: 16, fontWeight: '700', color: colors.gray[800] },
    vehicleMeta: { fontSize: 13, color: colors.gray[500], marginTop: 2 },
    plateBox: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    plateText: { color: colors.white, fontSize: 14, fontWeight: '800', letterSpacing: 1 },
    vehicleEmpty: {
      backgroundColor: colors.gray[100],
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.gray[200],
      borderStyle: 'dashed',
    },
    vehicleEmptyText: { fontSize: 13, color: colors.gray[500], textAlign: 'center' },
    menu: { backgroundColor: colors.card, borderRadius: 16, marginBottom: 24, overflow: 'hidden' },
    menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16 },
    menuItemBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    menuIcon: { fontSize: 18, marginRight: 14 },
    menuLabel: { flex: 1, fontSize: 15, color: colors.gray[800] },
    menuArrow: { fontSize: 22, color: colors.gray[400] },
    langCard: { backgroundColor: colors.card, borderRadius: 16, marginBottom: 24, padding: 16 },
    signOut: { marginBottom: 20 },
    version: { textAlign: 'center', fontSize: 12, color: colors.gray[400] },
  });
}
