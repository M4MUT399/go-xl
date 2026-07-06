/**
 * CompleteRegistration — cadastro completo de uma conta EXPRESSA.
 *
 * Contas criadas via QR do motorista entram só com o cartão (nome provisório,
 * sem telefone). Quando o passageiro vai agendar ou pedir a 2ª viagem, este
 * gate cobra os dados que faltam: nome, e-mail, telefone e uma senha (para que
 * ele consiga acessar a conta depois pelo login normal).
 *
 * Ao concluir, o telefone passa a estar preenchido → o perfil vira "completo"
 * (ver src/lib/onboarding.ts) e os gates de corrida deixam de aparecer.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'CompleteRegistration'>;
};

export function CompleteRegistrationScreen({ navigation }: Props) {
  const { profile, session, patchProfile, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    const cleanName = fullName.trim();
    const cleanEmail = email.trim().toLowerCase();
    const digits = phone.replace(/\D/g, '');

    if (!cleanName || !cleanEmail || !phone) {
      Alert.alert('Atenção', 'Preencha nome, e-mail e telefone.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      Alert.alert('Atenção', 'Informe um e-mail válido.');
      return;
    }
    if (digits.length < 10) {
      Alert.alert('Atenção', 'Informe um telefone válido com DDD.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Atenção', 'A senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Atenção', 'As senhas não coincidem.');
      return;
    }

    const userId = profile?.id ?? session?.user?.id;
    if (!userId) {
      Alert.alert('Erro', 'Sessão não encontrada. Entre novamente.');
      return;
    }

    setLoading(true);
    try {
      // 1) Atualiza o perfil com os dados reais (telefone → cadastro completo).
      const { error: profErr } = await supabase
        .from('profiles')
        .update({ full_name: cleanName, phone: digits, email: cleanEmail })
        .eq('id', userId);
      if (profErr) throw profErr;

      // 2) Define uma senha real (para login futuro). Best-effort.
      try {
        await supabase.auth.updateUser({ password });
      } catch { /* não bloqueia o cadastro */ }

      // 3) Tenta trocar o e-mail de login para o real. Pode exigir confirmação
      //    por e-mail dependendo da configuração do Supabase; por isso é
      //    best-effort e não trava o fluxo.
      try {
        await supabase.auth.updateUser({ email: cleanEmail });
      } catch { /* confirmação pendente — ok */ }

      // 4) Atualiza o contexto local para os gates liberarem imediatamente.
      patchProfile({ full_name: cleanName, phone: digits, email: cleanEmail });
      try { await refreshProfile(); } catch { /* ignora falha de rede */ }

      Alert.alert(
        'Cadastro concluído!',
        'Seus dados foram salvos. Agora é só continuar com sua viagem.',
        [{ text: 'Continuar', onPress: () => { if (navigation.canGoBack()) navigation.goBack(); } }]
      );
    } catch (e: unknown) {
      const err = e as { message?: string };
      Alert.alert('Erro', err?.message ?? 'Não foi possível salvar. Tente novamente.');
    } finally {
      setLoading(false);
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
          <Text style={styles.backText}>← Voltar</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Falta pouco</Text>
          </View>
          <Text style={styles.title}>Complete seu cadastro</Text>
          <Text style={styles.subtitle}>
            Para agendar ou pedir novas viagens, precisamos dos seus dados.
            Leva menos de 1 minuto.
          </Text>
        </View>

        <View style={styles.form}>
          <Input
            label="Nome completo"
            value={fullName}
            onChangeText={setFullName}
            placeholder="Ex: João Silva"
            autoCapitalize="words"
          />
          <Input
            label="Telefone (com DDD)"
            value={phone}
            onChangeText={setPhone}
            placeholder="(11) 99999-9999"
            keyboardType="phone-pad"
          />
          <Input
            label="E-mail"
            value={email}
            onChangeText={setEmail}
            placeholder="seu@email.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Input
            label="Senha"
            value={password}
            onChangeText={setPassword}
            placeholder="Mínimo 6 caracteres"
            secureTextEntry
          />
          <Input
            label="Confirmar senha"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder="Repita a senha"
            secureTextEntry
          />
        </View>

        <Button title="Salvar e continuar" onPress={handleSave} loading={loading} />
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
    header: { marginBottom: 24 },
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
      fontSize: 32,
      fontWeight: '800',
      color: colors.text,
      lineHeight: 40,
      marginBottom: 8,
    },
    subtitle: { fontSize: 15, color: colors.gray[500], lineHeight: 21 },
    form: { marginBottom: 24 },
  });
}
