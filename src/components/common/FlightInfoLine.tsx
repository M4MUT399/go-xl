import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { formatFlightNumber } from '../../lib/airportTrip';
import type { Ride } from '../../types';

/**
 * Voo e terminal de uma corrida para aeroporto (migration 0088). Some quando a
 * corrida não tem — corrida comum não ganha linha vazia.
 */
export function FlightInfoLine({ ride, style }: {
  ride: Pick<Ride, 'flight_number' | 'airport_terminal'>;
  style?: object;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  if (!ride.flight_number && !ride.airport_terminal) return null;

  const partes = [
    ride.flight_number ? `${t('ride.flightLabel')} ${formatFlightNumber(ride.flight_number)}` : null,
    ride.airport_terminal || null,
  ].filter(Boolean);

  return (
    <View style={[styles.box, { backgroundColor: colors.gray[100], borderColor: colors.accent }, style]}>
      <Text style={[styles.text, { color: colors.text }]} numberOfLines={2}>
        ✈️  {partes.join('  ·  ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  text: { fontSize: 14, fontWeight: '700' },
});
