import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Terms'> };

// Chaves de tradução das 6 seções (título + corpo). O texto real vive em i18n.
const SECTION_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6'];

export function TermsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{t('terms.title')}</Text>
        <Text style={styles.updated}>{t('terms.updated')}</Text>

        {SECTION_KEYS.map((k) => (
          <View key={k} style={styles.section}>
            <Text style={styles.sectionTitle}>{t(`terms.${k}.title`)}</Text>
            <Text style={styles.sectionBody}>{t(`terms.${k}.body`)}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { padding: 24 },
    back: { marginBottom: 20, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    updated: { fontSize: 13, color: colors.gray[400], marginBottom: 24 },
    section: { marginBottom: 20 },
    sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.gray[800], marginBottom: 6 },
    sectionBody: { fontSize: 14, color: colors.gray[600], lineHeight: 21 },
  });
}
