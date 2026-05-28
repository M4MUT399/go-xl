import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'EditProfile'> };

export function EditProfileScreen({ navigation }: Props) {
  const { profile, refreshProfile } = useAuth();
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!fullName.trim() || !phone.trim()) {
      Alert.alert('Atenção', 'Preencha nome e telefone.');
      return;
    }
    if (!profile?.id) return;

    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim(), phone: phone.trim() })
      .eq('id', profile.id);
    setSaving(false);

    if (error) {
      Alert.alert('Erro', error.message);
    } else {
      await refreshProfile?.();
      Alert.alert('Pronto!', 'Dados atualizados.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← Voltar</Text>
          </TouchableOpacity>

          <Text style={styles.title}>Dados pessoais</Text>
          <Text style={styles.subtitle}>Atualize suas informações de cadastro</Text>

          <View style={styles.form}>
            <Input label="Nome completo" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
            <Input label="Telefone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

            <View style={styles.readonly}>
              <Text style={styles.readonlyLabel}>E-MAIL</Text>
              <Text style={styles.readonlyValue}>{profile?.email}</Text>
              <Text style={styles.readonlyHint}>O e-mail não pode ser alterado.</Text>
            </View>
          </View>

          <Button title="Salvar alterações" onPress={handleSave} loading={saving} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white },
  scroll: { flexGrow: 1, padding: 24 },
  back: { marginBottom: 20, alignSelf: 'flex-start' },
  backText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  title: { fontSize: 26, fontWeight: '800', color: Colors.primary, marginBottom: 6 },
  subtitle: { fontSize: 14, color: Colors.gray[500], marginBottom: 28 },
  form: { marginBottom: 24 },
  readonly: { marginTop: 8 },
  readonlyLabel: { fontSize: 12, fontWeight: '700', color: Colors.gray[500], marginBottom: 6, letterSpacing: 0.5 },
  readonlyValue: { fontSize: 15, color: Colors.gray[700] },
  readonlyHint: { fontSize: 12, color: Colors.gray[400], marginTop: 4 },
});
