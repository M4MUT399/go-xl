import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image, ActivityIndicator, Alert,
} from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { pickImage, uploadImage } from '../../lib/storage';
import { useTranslation } from '../../i18n';

type Props = {
  /** URL atual da foto (se já existir). */
  value?: string | null;
  /** Pasta no bucket — normalmente o id do usuário. */
  pathPrefix: string;
  /** Chamado com a URL pública após o upload concluir. */
  onChange: (url: string) => void;
  /** Tamanho do círculo. */
  size?: number;
  /** Marca visual de campo obrigatório. */
  required?: boolean;
  label?: string;
  /** Em 'local', devolve o URI local sem subir (upload feito depois, ex.: no cadastro). */
  local?: boolean;
};

/** Seletor de foto de rosto circular, com upload para o bucket 'avatars'. */
export function AvatarPicker({
  value,
  pathPrefix,
  onChange,
  size = 110,
  required = false,
  label,
  local = false,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const styles = makeStyles(colors, size);

  async function pickAndApply(fromCamera: boolean) {
    const uri = await pickImage({ aspect: [1, 1], fromCamera });
    if (!uri) return;
    if (local) {
      onChange(uri); // upload adiado (ex.: no cadastro, após criar a conta)
      return;
    }
    setUploading(true);
    try {
      const url = await uploadImage('avatars', uri, pathPrefix);
      onChange(url);
    } catch (e: any) {
      Alert.alert(t('avatar.uploadErrorTitle'), e?.message ?? t('avatar.tryAgain'));
    } finally {
      setUploading(false);
    }
  }

  function handlePick() {
    Alert.alert(
      t('avatar.sheetTitle'),
      t('avatar.sheetMessage'),
      [
        { text: t('avatar.takePhoto'), onPress: () => pickAndApply(true) },
        { text: t('avatar.chooseFromLibrary'), onPress: () => pickAndApply(false) },
        { text: t('avatar.cancel'), style: 'cancel' },
      ],
      { cancelable: true }
    );
  }

  return (
    <View style={styles.wrap}>
      <TouchableOpacity onPress={handlePick} activeOpacity={0.8} style={styles.circle}>
        {uploading ? (
          <ActivityIndicator color={colors.accent} />
        ) : value ? (
          <Image source={{ uri: value }} style={styles.img} />
        ) : (
          <Text style={styles.placeholder}>📷</Text>
        )}
        <View style={styles.editBadge}>
          <Text style={styles.editIcon}>{value ? '✎' : '+'}</Text>
        </View>
      </TouchableOpacity>
      <Text style={styles.label}>
        {label ?? t('avatar.label')}
        {required ? <Text style={styles.req}> *</Text> : null}
      </Text>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors'], size: number) {
  return StyleSheet.create({
    wrap: { alignItems: 'center', marginBottom: 8 },
    circle: {
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: colors.gray[100],
      borderWidth: 2,
      borderColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'visible',
    },
    img: { width: size, height: size, borderRadius: size / 2 },
    placeholder: { fontSize: size * 0.34 },
    editBadge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: colors.white,
    },
    editIcon: { color: colors.primary, fontSize: 16, fontWeight: '800' },
    label: { marginTop: 10, fontSize: 13, color: colors.gray[500], fontWeight: '600' },
    req: { color: '#E03131' },
  });
}
