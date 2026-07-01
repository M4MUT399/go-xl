import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView, Linking } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Support'> };

const SUPPORT_EMAIL = 'support@goxl.app';
const SUPPORT_PHONE = '+1 (407) 000-0000';

const FAQ = [
  {
    q: 'Como solicito uma corrida?',
    a: 'Na tela inicial, toque em "Para onde você vai?", digite o destino, confirme o preço estimado e toque em solicitar.',
  },
  {
    q: 'Como funciona o pagamento?',
    a: 'Os valores são exibidos em dólar (US$). O pagamento em cartão estará disponível em breve.',
  },
  {
    q: 'Sou motorista. Como recebo corridas?',
    a: 'Cadastre seu veículo no Perfil, ative o modo Online na tela inicial e aguarde as solicitações.',
  },
];

export function SupportScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Voltar</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Ajuda e suporte</Text>
        <Text style={styles.subtitle}>Estamos aqui para ajudar</Text>

        <View style={styles.card}>
          <TouchableOpacity style={styles.contactRow} onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
            <Text style={styles.contactIcon}>📧</Text>
            <View style={styles.contactText}>
              <Text style={styles.contactLabel}>E-mail</Text>
              <Text style={styles.contactValue}>{SUPPORT_EMAIL}</Text>
            </View>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.contactRow} onPress={() => Linking.openURL(`tel:${SUPPORT_PHONE.replace(/[^+\d]/g, '')}`)}>
            <Text style={styles.contactIcon}>📞</Text>
            <View style={styles.contactText}>
              <Text style={styles.contactLabel}>Telefone</Text>
              <Text style={styles.contactValue}>{SUPPORT_PHONE}</Text>
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>Perguntas frequentes</Text>
        <View style={styles.card}>
          {FAQ.map((item, i) => (
            <View key={i} style={[styles.faqItem, i < FAQ.length - 1 && styles.faqBorder]}>
              <Text style={styles.faqQ}>{item.q}</Text>
              <Text style={styles.faqA}>{item.a}</Text>
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
