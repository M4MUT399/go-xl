import React, { useEffect, useState } from 'react';
import { Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDriverRideContext } from '../../contexts/DriverRideContext';
import { navigationRef } from '../../navigation/AppNavigator';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';

/**
 * "Voltar à corrida" do MOTORISTA (29/10/2026). A tela de navegação agora tem
 * saída (☰ Menu) para o motorista consultar ganhos, agenda, perfil etc. com a
 * corrida em andamento — e esta pílula, por cima de qualquer outra tela,
 * leva de volta a ela. Some na própria tela de navegação e sem corrida ativa.
 */
export function ReturnToRideBar() {
  const { activeRide } = useDriverRideContext();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [routeName, setRouteName] = useState<string | undefined>(undefined);

  useEffect(() => {
    const read = () => setRouteName(navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : undefined);
    read();
    return navigationRef.addListener('state', read);
  }, []);

  if (!activeRide || !['accepted', 'driver_en_route', 'in_progress'].includes(activeRide.status)) return null;
  if (!routeName || routeName === 'DriverNavigate' || routeName === 'Chat') return null;

  return (
    <TouchableOpacity
      style={[styles.bar, { bottom: insets.bottom + 70, backgroundColor: colors.accent }]}
      activeOpacity={0.9}
      onPress={() => {
        if (navigationRef.isReady()) navigationRef.navigate('DriverNavigate', { ride: activeRide });
      }}
    >
      <Text style={styles.text}>🚗 {t('driverNav.backToRide', 'Back to current ride')} →</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 24,
    paddingVertical: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 8,
  },
  text: { color: '#1A1A2E', fontWeight: '800', fontSize: 15 },
});
