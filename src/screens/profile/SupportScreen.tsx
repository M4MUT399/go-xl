import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView, Linking } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Support'> };

const SUPPORT_EMAIL = 'support@goxl.app';

// Chaves de tradução das 3 perguntas frequentes (pergunta + resposta).
const FAQ_KEYS = ['1', '2', '3'];

export function SupportScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{t('support.title')}</Text>
        <Text style={styles.subtitle}>{t('support.subtitle')}</Text>

        <View style={styles.card}>
          <TouchableOpacity style={styles.contactRow} onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
            <Text style={styles.contactIcon}>📧</Text>
            <View style={styles.contactText}>
              <Text style={styles.contactLabel}>{t('support.emailLabel')}</Text>
              <Text style={styles.contactValue}>{SUPPORT_EMAIL}</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>{t('support.faqTitle')}</Text>
        <View style={styles.card}>
          {FAQ_KEYS.map((k, i) => (
            <View key={k} style={[styles.faqItem, i < FAQ_KEYS.length - 1 && styles.faqBorder]}>
              <Text style={styles.faqQ}>{t(`support.q${k}`)}</Text>
              <Text style={styles.faqA}>{t(`support.a${k}`)}</Text>
            </View>
          ))}
        </View>
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
    card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, marginBottom: 24 },
    contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    contactIcon: { fontSize: 22, marginRight: 14 },
    contactText: { flex: 1 },
    contactLabel: { fontSize: 12, color: colors.gray[500] },
    contactValue: { fontSize: 15, fontWeight: '600', color: colors.text, marginTop: 2 },
    divider: { height: 1, backgroundColor: colors.gray[100], marginVertical: 8 },
    sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 12 },
    faqItem: { paddingVertical: 12 },
    faqBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    faqQ: { fontSize: 15, fontWeight: '600', color: colors.gray[800], marginBottom: 4 },
    faqA: { fontSize: 13, color: colors.gray[600], lineHeight: 19 },
  });
}
