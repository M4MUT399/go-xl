import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { AvatarPicker } from '../../components/common/AvatarPicker';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../i18n';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'EditProfile'> };

export function EditProfileScreen({ navigation }: Props) {
  const { profile, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url ?? '');
  const [emergencyName, setEmergencyName] = useState(profile?.emergency_contact_name ?? '');
  const [emergencyPhone, setEmergencyPhone] = useState(profile?.emergency_contact_phone ?? '');
  const [saving, setSaving] = useState(false);

  const isDriver = profile?.type === 'driver';
  const styles = makeStyles(colors);

  async function handleSave() {
    if (!fullName.trim() || !phone.trim()) {
      Alert.alert(t('common.attention'), t('register.fillAll'));
      return;
    }
    if (isDriver && !avatarUrl) {
      Alert.alert(t('common.attention'), t('edit.photoRequired'));
      return;
    }
    if (!profile?.id) return;

    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: fullName.trim(),
        phone: phone.trim(),
        avatar_url: avatarUrl || null,
        emergency_contact_name: emergencyName.trim() || null,
        emergency_contact_phone: emergencyPhone.trim() || null,
      })
      .eq('id', profile.id);
    setSaving(false);

    if (error) {
      Alert.alert('Erro', error.message);
    } else {
      await refreshProfile?.();
      Alert.alert(t('common.done'), t('edit.updated'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
      ]);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← {t('common.back')}</Text>
          </TouchableOpacity>

          <Text style={styles.title}>{t('edit.title')}</Text>
          <Text style={styles.subtitle}>{t('edit.subtitle')}</Text>

          <View style={styles.avatarWrap}>
            <AvatarPicker
              value={avatarUrl}
              pathPrefix={profile?.id ?? 'tmp'}
              onChange={setAvatarUrl}
              required={isDriver}
            />
          </View>

          <View style={styles.form}>
            <Input label={t('edit.fullName')} value={fullName} onChangeText={setFullName} autoCapitalize="words" />
            <Input label={t('edit.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

            <Text style={styles.sectionLabel}>{t('edit.emergencySection')}</Text>
            <Input
              label={t('edit.emergencyName')}
              value={emergencyName}
              onChangeText={setEmergencyName}
              autoCapitalize="words"
            />
            <Input
              label={t('edit.emergencyPhone')}
              value={emergencyPhone}
              onChangeText={setEmergencyPhone}
              keyboardType="phone-pad"
            />

            <View style={styles.readonly}>
              <Text style={styles.readonlyLabel}>{t('edit.emailLabel')}</Text>
              <Text style={styles.readonlyValue}>{profile?.email}</Text>
              <Text style={styles.readonlyHint}>{t('edit.emailHint')}</Text>
            </View>
          </View>

          <Button title={t('common.saveChanges')} onPress={handleSave} loading={saving} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flexGrow: 1, padding: 24 },
    back: { marginBottom: 20, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    subtitle: { fontSize: 14, color: colors.gray[500], marginBottom: 28 },
    avatarWrap: { alignItems: 'center', marginBottom: 24 },
    form: { marginBottom: 24 },
    sectionLabel: {
      fontSize: 13, fontWeight: '700', color: colors.gray[500],
      marginTop: 12, marginBottom: 4, letterSpacing: 0.5, textTransform: 'uppercase',
    },
    readonly: { marginTop: 8 },
    readonlyLabel: { fontSize: 12, fontWeight: '700', color: colors.gray[500], marginBottom: 6, letterSpacing: 0.5 },
    readonlyValue: { fontSize: 15, color: colors.gray[700] },
    readonlyHint: { fontSize: 12, color: colors.gray[400], marginTop: 4 },
  });
}
