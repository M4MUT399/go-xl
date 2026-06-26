import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Switch, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'NotificationSettings'> };

const STORAGE_KEY = '@goxl:notif_prefs';

interface Prefs {
  rides: boolean;
  promotions: boolean;
  sound: boolean;
}

const DEFAULTS: Prefs = { rides: true, promotions: false, sound: true };

const ITEMS: { key: keyof Prefs; title: string; desc: string }[] = [
  { key: 'rides', title: 'Corridas', desc: 'Avisos de novas corridas e atualizações de status' },
  { key: 'promotions', title: 'Promoções', desc: 'Ofertas, descontos e novidades do Go XL' },
  { key: 'sound', title: 'Som', desc: 'Tocar som ao receber notificações' },
];

export function NotificationSettingsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);

  const styles = makeStyles(colors);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) setPrefs({ ...DEFAULTS, ...JSON.parse(raw) });
    });
  }, []);

  function toggle(key: keyof Prefs) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Voltar</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Notificações</Text>
        <Text style={styles.subtitle}>Escolha o que deseja receber</Text>

        <View style={styles.card}>
          {ITEMS.map((item, i) => (
            <View key={item.key} style={[styles.row, i < ITEMS.length - 1 && styles.rowBorder]}>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{item.title}</Text>
                <Text style={styles.rowDesc}>{item.desc}</Text>
              </View>
              <Switch
                value={prefs[item.key]}
                onValueChange={() => toggle(item.key)}
                trackColor={{ true: colors.accent, false: colors.gray[300] }}
                thumbColor={colors.white}
              />
            </View>
          ))}
        </View>

        <Text style={styles.note}>
          As preferências são salvas neste dispositivo. O envio real de push depende da
          permissão do sistema.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 24 },
    back: { marginBottom: 20, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    subtitle: { fontSize: 14, color: colors.gray[500], marginBottom: 24 },
    card: { backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 16 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    rowText: { flex: 1, paddingRight: 12 },
    rowTitle: { fontSize: 15, fontWeight: '600', color: colors.gray[800] },
    rowDesc: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    note: { fontSize: 12, color: colors.gray[400], marginTop: 16, lineHeight: 18 },
  });
}
