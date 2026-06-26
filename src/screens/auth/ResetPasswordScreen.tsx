import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, Alert,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';

/** Tela exibida quando o usuário chega via deep link de recuperação de senha.
 *  Não recebe navigation: ela é a única rota disponível enquanto isRecovery
 *  for true (ver AppNavigator) — ao salvar, clearRecovery() libera o fluxo
 *  normal de navegação. */
export function ResetPasswordScreen() {
  const { updatePassword, clearRecovery, signOut } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const styles = makeStyles(colors);

  async function handleSave() {
    if (!password || !confirm) {
      Alert.alert(t('common.attention'), t('resetPassword.fillFields'));
      return;
    }
    if (password.length < 6) {
      Alert.alert(t('common.attention'), t('resetPassword.tooShort'));
      return;
    }
    if (password !== confirm) {
      Alert.alert(t('common.attention'), t('resetPassword.mismatch'));
      return;
    }
    setLoading(true);
    const { error } = await updatePassword(password);
    setLoading(false);
    if (error) {
      Alert.alert(t('common.error'), error.message);
      return;
    }
    Alert.alert(t('common.done'), t('resetPassword.success'), [
      { text: t('common.ok'), onPress: clearRecovery },
    ]);
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.title}>{t('resetPassword.title')}</Text>
            <Text style={styles.subtitle}>{t('resetPassword.subtitle')}</Text>
          </View>

          <View style={styles.form}>
            <Input
              label={t('resetPassword.newPassword')}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
            />
            <Input
              label={t('resetPassword.confirmPassword')}
              value={confirm}
              onChangeText={setConfirm}
              placeholder="••••••••"
              secureTextEntry
            />
          </View>

          <Button title={t('resetPassword.save')} onPress={handleSave} loading={loading} />

          <Text style={styles.signOutLink} onPress={() => { clearRecovery(); signOut(); }}>
            {t('common.cancel')}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flexGrow: 1, padding: 24, justifyContent: 'center' },
    header: { marginBottom: 40 },
    title: {
      fontSize: 30,
      fontWeight: '800',
      color: colors.text,
      lineHeight: 38,
      marginBottom: 8,
    },
    subtitle: { fontSize: 15, color: colors.gray[500], lineHeight: 21 },
    form: { marginBottom: 32 },
    signOutLink: {
      marginTop: 24, textAlign: 'center',
      fontSize: 14, fontWeight: '600', color: colors.gray[500],
    },
  });
}
