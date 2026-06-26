import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ScrollView, Alert, Image,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { pickImage, uploadPrivateImage } from '../../lib/storage';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DriverVerification'> };

type LocalShot = { uri: string; uploadedPath?: string };

export function DriverVerificationScreen({ navigation }: Props) {
  const { profile, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);

  const status = profile?.verification_status ?? 'unsubmitted';
  const canSubmit = status === 'unsubmitted' || status === 'rejected' || status === 'revoked';

  const [selfie, setSelfie] = useState<LocalShot | null>(null);
  const [document, setDocument] = useState<LocalShot | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePick(target: 'selfie' | 'document') {
    const uri = await pickImage({ aspect: target === 'selfie' ? [1, 1] : [16, 10] });
    if (!uri) return;
    if (target === 'selfie') setSelfie({ uri });
    else setDocument({ uri });
  }

  async function handleSubmit() {
    if (!profile?.id || !selfie || !document) {
      Alert.alert(t('common.attention'), t('verification.fillBoth'));
      return;
    }
    setSubmitting(true);
    try {
      const [selfiePath, documentPath] = await Promise.all([
        uploadPrivateImage('driver-verification', selfie.uri, profile.id),
        uploadPrivateImage('driver-verification', document.uri, profile.id),
      ]);

      const { error } = await supabase
        .from('profiles')
        .update({
          verification_selfie_url: selfiePath,
          verification_document_url: documentPath,
          verification_status: 'pending',
          verification_submitted_at: new Date().toISOString(),
        })
        .eq('id', profile.id);

      if (error) throw error;

      await refreshProfile();
      Alert.alert(t('common.done'), t('verification.submitted'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
      ]);
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('verification.submitError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{t('verification.title')}</Text>
        <Text style={styles.subtitle}>{t('verification.subtitle')}</Text>

        <StatusBadge status={status} notes={profile?.verification_notes} t={t} colors={colors} />

        {canSubmit && (
          <>
            <ShotPicker
              label={t('verification.selfieLabel')}
              shot={selfie}
              onPress={() => handlePick('selfie')}
              colors={colors}
            />
            <ShotPicker
              label={t('verification.documentLabel')}
              shot={document}
              onPress={() => handlePick('document')}
              colors={colors}
            />
            <Button
              title={t('verification.submit')}
              onPress={handleSubmit}
              loading={submitting}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatusBadge({
  status, notes, t, colors,
}: {
  status: string;
  notes?: string;
  t: (key: string) => string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const map: Record<string, { bg: string; fg: string; icon: string; labelKey: string }> = {
    unsubmitted: { bg: colors.gray[100], fg: colors.gray[600], icon: '📄', labelKey: 'verification.statusUnsubmitted' },
    pending:     { bg: 'rgba(201,168,76,0.15)', fg: '#A07C1F', icon: '⏳', labelKey: 'verification.statusPending' },
    approved:    { bg: 'rgba(34,197,94,0.15)',  fg: '#15803D', icon: '✅', labelKey: 'verification.statusApproved' },
    rejected:    { bg: 'rgba(224,49,49,0.12)',  fg: '#C92A2A', icon: '⚠️', labelKey: 'verification.statusRejected' },
    revoked:     { bg: 'rgba(224,49,49,0.12)',  fg: '#C92A2A', icon: '⚠️', labelKey: 'verification.statusRevoked' },
  };
  const cfg = map[status] ?? map.unsubmitted;

  return (
    <View style={[badgeStyles.wrap, { backgroundColor: cfg.bg }]}>
      <Text style={badgeStyles.icon}>{cfg.icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[badgeStyles.label, { color: cfg.fg }]}>{t(cfg.labelKey)}</Text>
        {notes && (status === 'rejected' || status === 'revoked') && (
          <Text style={[badgeStyles.notes, { color: cfg.fg }]}>{notes}</Text>
        )}
      </View>
    </View>
  );
}

function ShotPicker({
  label, shot, onPress, colors,
}: {
  label: string;
  shot: LocalShot | null;
  onPress: () => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <TouchableOpacity style={shotStyles.wrap} onPress={onPress} activeOpacity={0.8}>
      {shot ? (
        <Image source={{ uri: shot.uri }} style={shotStyles.preview} />
      ) : (
        <View style={[shotStyles.preview, shotStyles.placeholder, { backgroundColor: colors.gray[100] }]}>
          <Text style={{ fontSize: 28 }}>📷</Text>
        </View>
      )}
      <Text style={[shotStyles.label, { color: colors.gray[600] }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { flexGrow: 1, padding: 24 },
    back: { marginBottom: 20, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    subtitle: { fontSize: 14, color: colors.gray[500], marginBottom: 20, lineHeight: 20 },
  });
}

const badgeStyles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'flex-start',
    borderRadius: 14, padding: 16, marginBottom: 24, gap: 12,
  },
  icon: { fontSize: 22 },
  label: { fontSize: 15, fontWeight: '700' },
  notes: { fontSize: 13, marginTop: 4, lineHeight: 18 },
});

const shotStyles = StyleSheet.create({
  wrap: { marginBottom: 20 },
  preview: { width: '100%', height: 180, borderRadius: 14 },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  label: { marginTop: 8, fontSize: 13, fontWeight: '600' },
});
