import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ForgotPassword'> };

export function ForgotPasswordScreen({ navigation }: Props) {
  const { resetPasswordForEmail } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const styles = makeStyles(colors);

  async function handleSend() {
    if (!email.trim()) {
      Alert.alert(t('common.attention'), t('forgotPassword.fillField'));
      return;
    }
    setLoading(true);
    // Não revela se o e-mail existe ou não — mesma mensagem em ambos os casos,
    // evitando enumeração de contas cadastradas.
    await resetPasswordForEmail(email.trim().toLowerCase());
    setLoading(false);
    setSent(true);
  }

  if (sent) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.successWrap}>
          <Text style={styles.successIcon}>📧</Text>
          <Text style={[styles.title, { textAlign: 'center' }]}>{t('forgotPassword.success')}</Text>
          <Text style={[styles.subtitle, { textAlign: 'center' }]}>{t('forgotPassword.successBody')}</Text>
          <TouchableOpacity style={{ marginTop: 32 }} onPress={() => navigation.navigate('Login')}>
            <Text style={styles.backLink}>{t('forgotPassword.backToLogin')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← {t('common.back')}</Text>
          </TouchableOpacity>

          <View style={styles.header}>
            <Text style={styles.title}>{t('forgotPassword.title')}</Text>
            <Text style={styles.subtitle}>{t('forgotPassword.subtitle')}</Text>
          </View>

          <View style={styles.form}>
            <Input
              label={t('forgotPassword.email')}
              value={email}
              onChangeText={setEmail}
              placeholder="seu@email.com"
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </View>

          <Button title={t('forgotPassword.send')} onPress={handleSend} loading={loading} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flexGrow: 1, padding: 24 },
    back: { marginBottom: 32, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    header: { marginBottom: 40 },
    title: {
      fontSize: 30,
      fontWeight: '800',
      color: colors.text,
      lineHeight: 38,
      marginBottom: 8,
      textAlign: 'left',
    },
    subtitle: { fontSize: 15, color: colors.gray[500], lineHeight: 21 },
    form: { marginBottom: 32 },
    successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
    successIcon: { fontSize: 56, marginBottom: 20 },
    backLink: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  });
}
