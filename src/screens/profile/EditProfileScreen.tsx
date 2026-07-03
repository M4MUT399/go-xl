import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { AvatarPicker } from '../../components/common/AvatarPicker';
import { useAuth } from '../../hooks/useAuth';
import { supabase, supabaseUrl, supabaseAnonKey } from '../../lib/supabase';
import { withTimeout } from '../../lib/withTimeout';
import { useTranslation } from '../../i18n';

const DELETE_ACCOUNT_URL  = `${supabaseUrl}/functions/v1/delete-account`;

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'EditProfile'> };

export function EditProfileScreen({ navigation }: Props) {
  const { profile, patchProfile, signOut } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url ?? '');
  const [emergencyName, setEmergencyName] = useState(profile?.emergency_contact_name ?? '');
  const [emergencyPhone, setEmergencyPhone] = useState(profile?.emergency_contact_phone ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    try {
      // PATCH cru no PostgREST em vez de `supabase.from().update()`.
      // Motivo: no dispositivo, o caminho de escrita autenticada do supabase-js
      // TRAVA de forma intermitente (o botão "Salvar" ficava girando para
      // sempre, em WiFi e 4G). Replicamos o padrão comprovado do edgeFunction.ts
      // e do upload de foto: token fresco via getSession() + fetch manual.
      const patch = {
        full_name: fullName.trim(),
        phone: phone.trim(),
        avatar_url: avatarUrl || null,
        emergency_contact_name: emergencyName.trim() || null,
        emergency_contact_phone: emergencyPhone.trim() || null,
      };

      const { data: { session } } = await withTimeout(
        supabase.auth.getSession(),
        10000,
        'Não foi possível validar sua sessão. Tente novamente.'
      );
      const token = session?.access_token;
      if (!token) throw new Error('Sessão expirada. Faça login novamente.');

      const res = await withTimeout(
        fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${profile.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${token}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(patch),
        }),
        15000,
        'Não foi possível salvar. Verifique sua conexão e tente novamente.'
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `Falha ao salvar (${res.status}).`);
      }

      // Atualiza o estado local imediatamente (sem nova query, que também
      // poderia travar) para que a UI reflita as mudanças ao voltar.
      patchProfile({
        full_name: patch.full_name,
        phone: patch.phone,
        avatar_url: patch.avatar_url ?? undefined,
        emergency_contact_name: patch.emergency_contact_name ?? undefined,
        emergency_contact_phone: patch.emergency_contact_phone ?? undefined,
      });

      Alert.alert(t('common.done'), t('edit.updated'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert('Erro', e?.message ?? 'Não foi possível salvar as alterações.');
    } finally {
      setSaving(false);
    }
  }

  function confirmDeleteAccount() {
    Alert.alert(
      t('edit.deleteTitle'),
      t('edit.deleteWarning'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('edit.deleteConfirm'), style: 'destructive', onPress: confirmDeleteAccountFinal },
      ]
    );
  }

  function confirmDeleteAccountFinal() {
    // Segunda confirmação — ação irreversível.
    Alert.alert(
      t('edit.deleteFinalTitle'),
      t('edit.deleteFinalWarning'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('edit.deleteConfirm'), style: 'destructive', onPress: handleDeleteAccount },
      ]
    );
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    try {
      const { data: { session } } = await withTimeout(
        supabase.auth.getSession(),
        10000,
        'Não foi possível confirmar sua sessão. Tente novamente.'
      );
      const res = await withTimeout(
        fetch(DELETE_ACCOUNT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token ?? ''}`,
          },
          body: JSON.stringify({}),
        }),
        15000,
        'Não foi possível excluir a conta. Verifique sua conexão e tente novamente.'
      );
      const json = await res.json() as { ok?: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? 'Falha ao excluir conta.');
      await signOut();
      // Após o signOut, o AppNavigator detecta a ausência de sessão e volta
      // para a tela de Welcome automaticamente — nenhuma navegação manual necessária.
    } catch (e: any) {
      setDeleting(false);
      Alert.alert(t('common.error'), e?.message ?? t('edit.deleteError'));
    }
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

          <TouchableOpacity
            style={styles.deleteAccountLink}
            onPress={confirmDeleteAccount}
            disabled={deleting}
          >
            <Text style={styles.deleteAccountText}>
              {deleting ? t('edit.deleting') : t('edit.deleteAccount')}
            </Text>
          </TouchableOpacity>
      </KeyboardAwareScrollView>
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
    deleteAccountLink: {
      marginTop: 28, alignItems: 'center',
      borderTopWidth: 1, borderTopColor: colors.gray[200], paddingTop: 20,
    },
    deleteAccountText: { color: '#E03131', fontSize: 14, fontWeight: '700' },
  });
}
