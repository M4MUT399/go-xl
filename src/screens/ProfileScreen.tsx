import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { Colors } from '../constants/colors';
import { Button } from '../components/common/Button';
import { useAuth } from '../hooks/useAuth';

const MENU_ITEMS = [
  { icon: '👤', label: 'Dados pessoais' },
  { icon: '💳', label: 'Pagamento' },
  { icon: '🔔', label: 'Notificações' },
  { icon: '🛟', label: 'Ajuda e suporte' },
  { icon: '📄', label: 'Termos e privacidade' },
];

export function ProfileScreen() {
  const { profile, signOut } = useAuth();

  const isDriver = profile?.type === 'driver';
  const initial = profile?.full_name?.[0]?.toUpperCase() ?? '?';

  function handleSignOut() {
    Alert.alert('Sair', 'Deseja realmente sair da conta?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: signOut },
    ]);
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <Text style={styles.name}>{profile?.full_name ?? 'Usuário'}</Text>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{isDriver ? '🚗 Motorista' : '✦ Executive XL'}</Text>
          </View>

          <View style={styles.stats}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>★ {Number(profile?.rating ?? 5).toFixed(1)}</Text>
              <Text style={styles.statLabel}>Avaliação</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{profile?.total_rides ?? 0}</Text>
              <Text style={styles.statLabel}>Corridas</Text>
            </View>
          </View>
        </View>

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

        <View style={styles.menu}>
          {MENU_ITEMS.map((item, i) => (
            <TouchableOpacity key={i} style={[styles.menuItem, i < MENU_ITEMS.length - 1 && styles.menuItemBorder]}>
              <Text style={styles.menuIcon}>{item.icon}</Text>
              <Text style={styles.menuLabel}>{item.label}</Text>
              <Text style={styles.menuArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Button title="Sair da conta" onPress={handleSignOut} variant="outline" style={styles.signOut} />

        <Text style={styles.version}>Go XL • v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  scroll: { padding: 16, paddingTop: 12 },
  profileCard: {
    backgroundColor: Colors.primary,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  avatarText: { fontSize: 34, fontWeight: '900', color: Colors.primary },
  name: { fontSize: 22, fontWeight: '800', color: Colors.white, marginBottom: 8 },
  badge: {
    backgroundColor: 'rgba(201,168,76,0.2)',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 5,
    marginBottom: 20,
  },
  badgeText: { color: Colors.accent, fontSize: 13, fontWeight: '600' },
  stats: { flexDirection: 'row', alignItems: 'center', width: '100%', justifyContent: 'center' },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontWeight: '800', color: Colors.white },
  statLabel: { fontSize: 12, color: Colors.gray[400], marginTop: 2 },
  statDivider: { width: 1, height: 36, backgroundColor: 'rgba(255,255,255,0.12)' },
  contactCard: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 16 },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  contactIcon: { fontSize: 16, marginRight: 12 },
  contactText: { fontSize: 14, color: Colors.gray[700] },
  contactDivider: { height: 1, backgroundColor: Colors.gray[100], marginVertical: 6, marginLeft: 28 },
  menu: { backgroundColor: Colors.white, borderRadius: 16, marginBottom: 24, overflow: 'hidden' },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 16 },
  menuItemBorder: { borderBottomWidth: 1, borderBottomColor: Colors.gray[100] },
  menuIcon: { fontSize: 18, marginRight: 14 },
  menuLabel: { flex: 1, fontSize: 15, color: Colors.gray[800] },
  menuArrow: { fontSize: 22, color: Colors.gray[400] },
  signOut: { marginBottom: 20 },
  version: { textAlign: 'center', fontSize: 12, color: Colors.gray[400] },
});
