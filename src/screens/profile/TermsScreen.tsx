import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Terms'> };

const SECTIONS = [
  {
    title: '1. Aceitação dos termos',
    body: 'Ao usar o Go XL, você concorda com estes Termos de Uso. O Go XL é um aplicativo de transporte na categoria Executive XL que conecta passageiros e motoristas.',
  },
  {
    title: '2. Uso do serviço',
    body: 'Você deve fornecer informações verdadeiras no cadastro e usar o aplicativo de acordo com as leis locais. Motoristas devem manter documentos e veículo em conformidade.',
  },
  {
    title: '3. Pagamentos',
    body: 'Os valores das corridas são exibidos em dólares (US$) antes da confirmação. Tarifas podem variar conforme distância e tempo estimados.',
  },
  {
    title: '4. Cancelamentos',
    body: 'Corridas podem ser canceladas antes do início. Políticas de cancelamento e eventuais taxas serão exibidas no momento da solicitação.',
  },
  {
    title: '5. Privacidade',
    body: 'Coletamos apenas os dados necessários para operar o serviço (perfil, localização durante a corrida e histórico). Não vendemos seus dados a terceiros. A localização é usada somente enquanto o app está em uso para conectar você ao motorista/passageiro.',
  },
  {
    title: '6. Contato',
    body: 'Dúvidas sobre estes termos podem ser enviadas para suporte@goxl.app.',
  },
];

export function TermsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Voltar</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Termos e privacidade</Text>
        <Text style={styles.updated}>Última atualização: maio de 2026</Text>

        {SECTIONS.map((s, i) => (
          <View key={i} style={styles.section}>
            <Text style={styles.sectionTitle}>{s.title}</Text>
            <Text style={styles.sectionBody}>{s.body}</Text>
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
