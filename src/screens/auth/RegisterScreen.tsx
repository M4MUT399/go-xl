import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { AvatarPicker } from '../../components/common/AvatarPicker';
import { LanguageSelector } from '../../components/common/LanguageSelector';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation, type Lang } from '../../i18n';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Register'>;
  route: RouteProp<RootStackParamList, 'Register'>;
};

export function RegisterScreen({ navigation, route }: Props) {
  const { type } = route.params;
  const { signUp } = useAuth();
  const { colors } = useTheme();
  const { t, lang, setLang } = useTranslation();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [avatarUri, setAvatarUri] = useState('');
  const [selectedLang, setSelectedLang] = useState<Lang>(lang);
  const [loading, setLoading] = useState(false);

  const isDriver = type === 'driver';
  const styles = makeStyles(colors);

  function chooseLang(l: Lang) {
    setSelectedLang(l);
    setLang(l); // aplica imediatamente a tradução na tela
  }

  async function handleRegister() {
    if (!fullName || !phone || !email || !password) {
      Alert.alert(t('common.attention'), t('register.fillAll'));
      return;
    }
    if (password.length < 6) {
      Alert.alert(t('common.attention'), t('register.passwordShort'));
      return;
    }
    if (isDriver && !avatarUri) {
      Alert.alert(t('common.attention'), t('register.photoRequired'));
      return;
    }
    setLoading(true);
    const { error } = await signUp(email.trim().toLowerCase(), password, fullName, phone, type, {
      language: selectedLang,
      avatarUri: avatarUri || undefined,
    });
    setLoading(false);
    if (error) Alert.alert(t('common.error'), error.message);
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← {t('common.back')}</Text>
          </TouchableOpacity>

          <View style={styles.header}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{isDriver ? t('register.driver') : t('register.passenger')}</Text>
            </View>
            <Text style={styles.title}>{t('register.title')}</Text>
            <Text style={styles.subtitle}>
              {isDriver ? t('register.subtitleDriver') : t('register.subtitlePassenger')}
            </Text>
          </View>

          <View style={styles.avatarWrap}>
            <AvatarPicker
              value={avatarUri}
              pathPrefix="signup"
              onChange={setAvatarUri}
              required={isDriver}
              local
              label={isDriver ? t('register.photoDriverRequired') : t('register.photo')}
            />
          </View>

          <View style={styles.form}>
            <LanguageSelector value={selectedLang} onChange={chooseLang} label={t('register.language')} />
            <Input
              label={t('register.fullName')}
              value={fullName}
              onChangeText={setFullName}
              placeholder={t('register.fullNamePh')}
              autoCapitalize="words"
            />
            <Input
              label={t('register.phone')}
              value={phone}
              onChangeText={setPhone}
              placeholder="(11) 99999-9999"
              keyboardType="phone-pad"
            />
            <Input
              label={t('register.email')}
              value={email}
              onChangeText={setEmail}
              placeholder="seu@email.com"
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <Input
              label={t('register.password')}
              value={password}
              onChangeText={setPassword}
              placeholder={t('register.passwordPh')}
              secureTextEntry
            />
          </View>

          <Button title={t('register.create')} onPress={handleRegister} loading={loading} />

          <View style={styles.loginRow}>
            <Text style={styles.loginText}>{t('register.haveAccount')}</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Login')}>
              <Text style={styles.loginLink}>{t('login.signIn')}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flexGrow: 1, padding: 24 },
    back: { marginBottom: 24, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    header: { marginBottom: 24 },
    avatarWrap: { alignItems: 'center', marginBottom: 20 },
    badge: {
      alignSelf: 'flex-start',
      backgroundColor: colors.gray[100],
      borderRadius: 20,
      paddingHorizontal: 12,
      paddingVertical: 5,
      marginBottom: 16,
    },
    badgeText: { fontSize: 13, fontWeight: '600', color: colors.gray[600] },
    title: {
      fontSize: 34,
      fontWeight: '800',
      color: colors.text,
      lineHeight: 42,
      marginBottom: 8,
    },
    subtitle: { fontSize: 15, color: colors.gray[500] },
    form: { marginBottom: 32 },
    loginRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 24 },
    loginText: { color: colors.gray[500], fontSize: 14 },
    loginLink: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  });
}
