import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  Alert, Image,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Login'> };

export function LoginScreen({ navigation }: Props) {
  const { signIn } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const styles = makeStyles(colors);

  async function handleLogin() {
    if (!email || !password) {
      Alert.alert(t('common.attention'), t('login.fillFields'));
      return;
    }
    setLoading(true);
    const { error } = await signIn(email.trim().toLowerCase(), password);
    setLoading(false);
    if (error) Alert.alert(t('common.error'), t('login.invalid'));
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        enableOnAndroid
        extraScrollHeight={20}
      >
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← {t('common.back')}</Text>
          </TouchableOpacity>

          <Image
            source={require('../../../assets/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />

          <View style={styles.header}>
            <Text style={styles.title}>{t('login.title')}</Text>
            <Text style={styles.subtitle}>{t('login.subtitle')}</Text>
          </View>

          <View style={styles.form}>
            <Input
              label={t('login.email')}
              value={email}
              onChangeText={setEmail}
              placeholder="seu@email.com"
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Input
              label={t('login.password')}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
            />
            <TouchableOpacity style={styles.forgot} onPress={() => navigation.navigate('ForgotPassword')}>
              <Text style={styles.forgotText}>{t('login.forgot')}</Text>
            </TouchableOpacity>
          </View>

          <Button title={t('login.signIn')} onPress={handleLogin} loading={loading} />

          <View style={styles.registerRow}>
            <Text style={styles.registerText}>{t('login.noAccount')}</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Register', { type: 'passenger' })}>
              <Text style={styles.registerLink}>{t('login.create')}</Text>
            </TouchableOpacity>
          </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flexGrow: 1, padding: 24 },
    back: { marginBottom: 32, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    logo: {
      width: 120,
      height: 120,
      borderRadius: 24,
      alignSelf: 'center',
      marginBottom: 24,
    },
    header: { marginBottom: 40 },
    title: {
      fontSize: 34,
      fontWeight: '800',
      color: colors.text,
      lineHeight: 42,
      marginBottom: 8,
    },
    subtitle: { fontSize: 15, color: colors.gray[500] },
    form: { marginBottom: 32 },
    forgot: { alignSelf: 'flex-end', marginTop: -8 },
    forgotText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
    registerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 24 },
    registerText: { color: colors.gray[500], fontSize: 14 },
    registerLink: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  });
}
