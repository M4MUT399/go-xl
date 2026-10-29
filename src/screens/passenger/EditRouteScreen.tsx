// EditRouteScreen — o passageiro muda a rota com a corrida em andamento
// (29/10/2026): troca o destino e/ou inclui até 3 paradas.
//
// Quem decide o preço é o servidor (update-ride-route): a tela pede primeiro
// uma SIMULAÇÃO (dryRun) para mostrar o valor novo, e só depois da confirmação
// manda aplicar — aí o servidor cobra a diferença no cartão ou devolve, e o
// motorista recebe a rota nova.

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, Alert, ActivityIndicator, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList, Location } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useTranslation } from '../../i18n';
import { useDebounce } from '../../hooks/useDebounce';
import { useLocation } from '../../hooks/useLocation';
import { BackButton } from '../../components/common/BackButton';
import { Button } from '../../components/common/Button';
import { searchPlaces, resolvePlace, newSessionToken, PlaceSuggestion } from '../../lib/geocoding';
import { formatCurrency } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { rideDestination } from '../../lib/ride';
import { rideStops } from '../../hooks/useLiveRide';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'EditRoute'>;
  route: RouteProp<RootStackParamList, 'EditRoute'>;
};

const MAX_STOPS = 3;

/** Campo sendo editado: o destino ou uma parada (índice na lista de pendentes). */
type Editing = { kind: 'destination' } | { kind: 'stop'; index: number | null };

export function EditRouteScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const { location } = useLocation();

  const doneStops = rideStops(ride).filter((s) => !!s.done_at);
  const [destination, setDestination] = useState<Location>(rideDestination(ride));
  const [stops, setStops] = useState<Location[]>(
    rideStops(ride).filter((s) => !s.done_at).map((s) => ({ lat: s.lat, lng: s.lng, address: s.address ?? '' })),
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [query, setQuery] = useState('');
  const debounced = useDebounce(query, 400);
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const sessionRef = useRef(newSessionToken());
  const [quote, setQuote] = useState<{ price: number; delta: number } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [saving, setSaving] = useState(false);

  const changed =
    destination.lat !== rideDestination(ride).lat
    || destination.lng !== rideDestination(ride).lng
    || JSON.stringify(stops.map((s) => [s.lat, s.lng]))
      !== JSON.stringify(rideStops(ride).filter((s) => !s.done_at).map((s) => [s.lat, s.lng]));

  useEffect(() => {
    if (!editing || debounced.trim().length < 3) { setResults([]); return; }
    let alive = true;
    setSearching(true);
    searchPlaces(debounced, sessionRef.current, location ?? undefined).then((list) => {
      if (alive) { setResults(list); setSearching(false); }
    });
    return () => { alive = false; };
  }, [debounced, editing, location]);

  // Cotação no servidor sempre que a rota muda.
  useEffect(() => {
    if (!changed) { setQuote(null); return; }
    let alive = true;
    setQuoting(true);
    supabase.functions.invoke('update-ride-route', { body: { rideId: ride.id, destination, stops, dryRun: true } })
      .then(({ data, error }) => {
        if (!alive) return;
        setQuoting(false);
        setQuote(error || !data?.dryRun ? null : { price: data.price, delta: data.delta });
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(destination), JSON.stringify(stops)]);

  async function pick(s: PlaceSuggestion) {
    const p = await resolvePlace(s, sessionRef.current);
    sessionRef.current = newSessionToken();
    if (!p || !editing) {
      Alert.alert(t('common.error'), t('payment.genericError'));
      return;
    }
    const loc: Location = { lat: p.lat, lng: p.lng, address: s.address || s.shortName };
    if (editing.kind === 'destination') setDestination(loc);
    else if (editing.index == null) setStops((cur) => [...cur, loc]);
    else setStops((cur) => cur.map((x, i) => (i === editing.index ? loc : x)));
    setEditing(null);
    setQuery('');
    setResults([]);
    Keyboard.dismiss();
  }

  async function apply() {
    if (!quote) return;
    const msg = quote.delta > 0
      ? t('editRoute.confirmCharge', 'The new route adds {amount}. It will be charged to your card.').replace('{amount}', formatCurrency(quote.delta))
      : quote.delta < 0
        ? t('editRoute.confirmRefund', 'The new route is shorter: {amount} will be refunded to your card.').replace('{amount}', formatCurrency(-quote.delta))
        : t('editRoute.confirmSame', 'The fare stays the same.');
    Alert.alert(t('editRoute.confirmTitle', 'Update route?'), `${msg}\n\n${t('editRoute.newTotal', 'New fare')}: ${formatCurrency(quote.price)}`, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('editRoute.confirm', 'Confirm'),
        onPress: async () => {
          setSaving(true);
          const { data, error } = await supabase.functions.invoke('update-ride-route', { body: { rideId: ride.id, destination, stops } });
          setSaving(false);
          if (error || !data?.success) {
            Alert.alert(t('common.error'), t('editRoute.failed', "We couldn't update the route. Nothing was charged."));
            return;
          }
          supabase.functions.invoke('send-ride-push', { body: { kind: 'route_changed', rideId: ride.id } }).catch(() => {});
          navigation.goBack();
        },
      },
    ]);
  }

  const row = (label: string, value: string, onEdit: () => void, onRemove?: () => void) => (
    <View style={styles.row}>
      <TouchableOpacity style={{ flex: 1 }} onPress={onEdit}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue} numberOfLines={2}>{value}</Text>
      </TouchableOpacity>
      {onRemove && (
        <TouchableOpacity onPress={onRemove} style={styles.remove} accessibilityLabel={t('editRoute.remove', 'Remove')}>
          <Text style={styles.removeText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <BackButton onPress={() => navigation.goBack()} />
      <Text style={styles.title}>{t('editRoute.title', 'Change route')}</Text>

      {doneStops.map((s, i) => (
        <Text key={`done-${i}`} style={styles.done}>✓ {s.address ?? ''}</Text>
      ))}
      {stops.map((s, i) =>
        row(
          `${t('editRoute.stop', 'Stop')} ${doneStops.length + i + 1}`,
          s.address,
          () => setEditing({ kind: 'stop', index: i }),
          () => setStops((cur) => cur.filter((_, j) => j !== i)),
        ),
      )}
      {row(t('editRoute.destination', 'Destination'), destination.address, () => setEditing({ kind: 'destination' }))}

      {doneStops.length + stops.length < MAX_STOPS && (
        <TouchableOpacity style={styles.addStop} onPress={() => setEditing({ kind: 'stop', index: null })}>
          <Text style={styles.addStopText}>＋ {t('editRoute.addStop', 'Add stop')}</Text>
        </TouchableOpacity>
      )}

      {editing && (
        <View style={styles.searchBox}>
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder={editing.kind === 'destination'
              ? t('editRoute.searchDestination', 'Search new destination')
              : t('editRoute.searchStop', 'Search stop address')}
            placeholderTextColor={colors.gray[500]}
          />
          {searching && <ActivityIndicator style={{ marginTop: 8 }} color={colors.accent} />}
          <FlatList
            data={results}
            keyboardShouldPersistTaps="handled"
            keyExtractor={(s, i) => `${s.placeId || s.shortName}-${i}`}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.result} onPress={() => pick(item)}>
                <Text style={styles.resultTitle}>{item.shortName}</Text>
                <Text style={styles.resultSub} numberOfLines={1}>{item.address}</Text>
              </TouchableOpacity>
            )}
          />
        </View>
      )}

      {!editing && changed && (
        <View style={styles.footer}>
          {quoting ? (
            <ActivityIndicator color={colors.accent} />
          ) : quote ? (
            <Text style={styles.quote}>
              {t('editRoute.newTotal', 'New fare')}: {formatCurrency(quote.price)}
              {quote.delta !== 0 ? `  (${quote.delta > 0 ? '+' : '−'}${formatCurrency(Math.abs(quote.delta))})` : ''}
            </Text>
          ) : (
            <Text style={styles.quoteErr}>{t('editRoute.quoteFailed', "Couldn't calculate the new fare.")}</Text>
          )}
          <Button title={t('editRoute.confirm', 'Confirm')} onPress={apply} loading={saving} disabled={!quote || quoting} />
        </View>
      )}
    </SafeAreaView>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 16 },
    title: { fontSize: 22, fontWeight: '800', color: colors.text, marginVertical: 12 },
    done: { color: colors.gray[500], marginBottom: 6 },
    row: {
      flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card,
      borderRadius: 12, padding: 12, marginBottom: 8,
    },
    rowLabel: { fontSize: 12, color: colors.gray[500], fontWeight: '700', textTransform: 'uppercase' },
    rowValue: { fontSize: 15, color: colors.text, marginTop: 2 },
    remove: { padding: 8 },
    removeText: { fontSize: 18, color: colors.error },
    addStop: { paddingVertical: 12 },
    addStopText: { color: colors.accent, fontWeight: '800', fontSize: 16 },
    searchBox: { flex: 1 },
    input: {
      borderWidth: 1, borderColor: colors.gray[300], borderRadius: 10, padding: 12,
      color: colors.text, fontSize: 16, backgroundColor: colors.card,
    },
    result: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.gray[300] },
    resultTitle: { color: colors.text, fontWeight: '700' },
    resultSub: { color: colors.gray[500], fontSize: 13 },
    footer: { marginTop: 'auto', paddingBottom: 16, gap: 10 },
    quote: { color: colors.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
    quoteErr: { color: colors.error, textAlign: 'center' },
  });
}
