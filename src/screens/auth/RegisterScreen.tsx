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
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Register'>;
  route: RouteProp<RootStackParamList, 'Register'>;
};

export function RegisterScreen({ navigation, route }: Props) {
  const { type } = route.params;
  const { signUp } = useAuth();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const isDriver = type === 'driver';

  async function handleRegister() {
    if (!fullName || !phone || !email || !password) {
      Alert.alert('Atenção', 'Preencha todos os campos.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Atenção', 'Senha deve ter ao menos 6 caracteres.');
      return;
    }
    setLoading(true);
    const { error } = await signUp(email.trim().toLowerCase(), password, fullName, phone, type);
    setLoading(false);
    if (error) Alert.alert('Erro', error.message);
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← Voltar</Text>
          </TouchableOpacity>

          <View style={styles.header}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{isDriver ? '🚗 Motorista' : '👤 Passageiro'}</Text>
            </View>
            <Text style={styles.title}>Criar{'\n'}sua conta</Text>
            <Text style={styles.subtitle}>
              {isDriver
                ? 'Cadastre-se como motorista Executive XL'
                : 'Comece a usar o Go XL agora'}
            </Text>
          </View>

          <View style={styles.form}>
            <Input
              label="Nome completo"
              value={fullName}
              onChangeText={setFullName}
              placeholder="Seu nome"
              autoCapitalize="words"
            />
            <Input
              label="Telefone"
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
          </View>

          <Button title="Criar conta" onPress={handleRegister} loading={loading} />

          <View style={styles.loginRow}>
            <Text style={styles.loginText}>Já tem conta? </Text>
            <TouchableOpacity onPress={() => navigation.navigate('Login')}>
              <Text style={styles.loginLink}>Entrar</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white },
  scroll: { flexGrow: 1, padding: 24 },
  back: { marginBottom: 24, alignSelf: 'flex-start' },
  backText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  header: { marginBottom: 36 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.gray[100],
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginBottom: 16,
  },
  badgeText: { fontSize: 13, fontWeight: '600', color: Colors.gray[600] },
  title: {
    fontSize: 34,
    fontWeight: '800',
    color: Colors.primary,
    lineHeight: 42,
    marginBottom: 8,
  },
  subtitle: { fontSize: 15, color: Colors.gray[500] },
  form: { marginBottom: 32 },
  loginRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 24 },
  loginText: { color: Colors.gray[500], fontSize: 14 },
  loginLink: { color: Colors.accent, fontSize: 14, fontWeight: '700' },
});
