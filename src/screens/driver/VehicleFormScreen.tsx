import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Alert, ActivityIndicator,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { Button } from '../../components/common/Button';
import { Input } from '../../components/common/Input';
import { useAuth } from '../../hooks/useAuth';
import { useVehicle } from '../../hooks/useVehicle';
import { useTranslation } from '../../i18n';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'VehicleForm'> };

const currentYear = new Date().getFullYear();

export function VehicleFormScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { vehicle, loading, saveVehicle } = useVehicle(profile?.id);

  const [model, setModel] = useState('');
  const [plate, setPlate] = useState('');
  const [color, setColor] = useState('');
  const [year, setYear] = useState('');
  const [saving, setSaving] = useState(false);

  const styles = makeStyles(colors);

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
      Alert.alert(t('common.attention'), t('vehicle.fillAll'));
      return;
    }
    if (isNaN(yearNum) || yearNum < 1990 || yearNum > currentYear + 1) {
      Alert.alert(t('common.attention'), `${t('vehicle.invalidYear')} (1990–${currentYear + 1}).`);
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
      Alert.alert(t('common.error'), error === 'DUPLICATE' ? t('vehicle.duplicate') : error);
    } else {
      Alert.alert(t('common.done'), t('vehicle.saved'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
      ]);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </SafeAreaView>
    );
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

          <View style={styles.header}>
            <View style={styles.iconCircle}>
              <Text style={{ fontSize: 28 }}>🚗</Text>
            </View>
            <Text style={styles.title}>{vehicle ? t('vehicle.editTitle') : t('vehicle.newTitle')}</Text>
            <Text style={styles.subtitle}>{t('vehicle.subtitle')}</Text>
          </View>

          <View style={styles.form}>
            <Input
              label={t('vehicle.model')}
              value={model}
              onChangeText={setModel}
              placeholder={t('vehicle.modelPh')}
              autoCapitalize="words"
            />
            <Input
              label={t('vehicle.plate')}
              value={plate}
              onChangeText={(tx) => setPlate(tx.toUpperCase())}
              placeholder="ABC1D23"
              autoCapitalize="characters"
              maxLength={8}
            />
            <Input
              label={t('vehicle.color')}
              value={color}
              onChangeText={setColor}
              placeholder={t('vehicle.colorPh')}
              autoCapitalize="words"
            />
            <Input
              label={t('vehicle.year')}
              value={year}
              onChangeText={setYear}
              placeholder={String(currentYear)}
              keyboardType="number-pad"
              maxLength={4}
            />
          </View>

          <Button
            title={vehicle ? t('vehicle.save') : t('vehicle.register')}
            onPress={handleSave}
            loading={saving}
          />
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    center: { alignItems: 'center', justifyContent: 'center' },
    scroll: { flexGrow: 1, padding: 24 },
    back: { marginBottom: 24, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    header: { alignItems: 'center', marginBottom: 32 },
    iconCircle: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.gray[100],
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 16,
    },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 8 },
    subtitle: { fontSize: 14, color: colors.gray[500], textAlign: 'center', paddingHorizontal: 20 },
    form: { marginBottom: 24 },
  });
}
