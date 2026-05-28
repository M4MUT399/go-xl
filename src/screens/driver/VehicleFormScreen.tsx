import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useAuth } from '../../hooks/useAuth';
import { useVehicle } from '../../hooks/useVehicle';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'VehicleForm'> };

const currentYear = new Date().getFullYear();

export function VehicleFormScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { vehicle, loading, saveVehicle } = useVehicle(profile?.id);

  const [model, setModel] = useState('');
  const [plate, setPlate] = useState('');
  const [color, setColor] = useState('');
  const [year, setYear] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (vehicle) {
      setModel(vehicle.model);
      setPlate(vehicle.plate);
      setColor(vehicle.color);
      setYear(String(vehicle.year));
    }
  }, [vehicle]);

  async function handleSave() {
    const yearNum = parseInt(year, 10);
    if (!model.trim() || !plate.trim() || !color.trim() || !year.trim()) {
      Alert.alert('Atenção', 'Preencha todos os campos.');
      return;
    }
    if (isNaN(yearNum) || yearNum < 1990 || yearNum > currentYear + 1) {
      Alert.alert('Atenção', `Informe um ano válido (1990–${currentYear + 1}).`);
      return;
    }

    setSaving(true);
    const { error } = await saveVehicle({
      model: model.trim(),
      plate: plate.trim().toUpperCase(),
      color: color.trim(),
      year: yearNum,
    });
    setSaving(false);

    if (error) {
      Alert.alert('Erro', error);
    } else {
      Alert.alert('Pronto!', 'Veículo salvo com sucesso.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={Colors.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
            <Text style={styles.backText}>← Voltar</Text>
          </TouchableOpacity>

          <View style={styles.header}>
            <View style={styles.iconCircle}>
              <Text style={{ fontSize: 28 }}>🚗</Text>
            </View>
            <Text style={styles.title}>{vehicle ? 'Editar veículo' : 'Cadastrar veículo'}</Text>
            <Text style={styles.subtitle}>Seu carro precisa atender ao padrão Executive XL</Text>
          </View>

          <View style={styles.form}>
            <Input
              label="Modelo"
              value={model}
              onChangeText={setModel}
              placeholder="Ex: Toyota Corolla"
              autoCapitalize="words"
            />
            <Input
              label="Placa"
              value={plate}
              onChangeText={(t) => setPlate(t.toUpperCase())}
              placeholder="ABC1D23"
              autoCapitalize="characters"
              maxLength={8}
            />
            <Input
              label="Cor"
              value={color}
              onChangeText={setColor}
              placeholder="Ex: Preto"
              autoCapitalize="words"
            />
            <Input
              label="Ano"
              value={year}
              onChangeText={setYear}
              placeholder={String(currentYear)}
              keyboardType="number-pad"
              maxLength={4}
            />
          </View>

          <Button title={vehicle ? 'Salvar alterações' : 'Cadastrar veículo'} onPress={handleSave} loading={saving} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.white },
  center: { alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1, padding: 24 },
  back: { marginBottom: 24, alignSelf: 'flex-start' },
  backText: { color: Colors.primary, fontSize: 15, fontWeight: '600' },
  header: { alignItems: 'center', marginBottom: 32 },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 26, fontWeight: '800', color: Colors.primary, marginBottom: 8 },
  subtitle: { fontSize: 14, color: Colors.gray[500], textAlign: 'center', paddingHorizontal: 20 },
  form: { marginBottom: 24 },
});
