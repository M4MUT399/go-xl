import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ActivityIndicator, Alert, FlatList,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { withTimeout } from '../../lib/withTimeout';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Payment'> };

const SUPABASE_URL          = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SETUP_CARD_URL        = `${SUPABASE_URL}/functions/v1/setup-card`;
const SYNC_CARD_URL         = `${SUPABASE_URL}/functions/v1/sync-card`;
const LIST_CARDS_URL        = `${SUPABASE_URL}/functions/v1/list-cards`;
const SET_DEFAULT_CARD_URL  = `${SUPABASE_URL}/functions/v1/set-default-card`;
const REMOVE_CARD_URL       = `${SUPABASE_URL}/functions/v1/remove-card`;

const REQUEST_TIMEOUT_MS = 15000;

const BRAND_LABEL: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex',
  discover: 'Discover', jcb: 'JCB', diners: 'Diners', unionpay: 'UnionPay',
};

interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export function PaymentScreen({ navigation }: Props) {
  const { refreshProfile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  // pmId da linha com ação (definir padrão/remover) em andamento — evita
  // travar a tela inteira quando só um cartão está sendo alterado.
  const [busyCardId, setBusyCardId] = useState<string | null>(null);

  const styles = makeStyles(colors);

  // Requisição autenticada às Edge Functions de cartão, com timeout — sem
  // isso, rede instável deixava a lista de cartões girando para sempre.
  async function callCardFunction<T>(url: string, body: Record<string, unknown> = {}): Promise<T> {
    const { data: { session } } = await withTimeout(
      supabase.auth.getSession(),
      10000,
      t('payment.sessionConfirmError')
    );
    if (!session) throw new Error(t('payment.sessionExpired'));

    const res = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      }),
      REQUEST_TIMEOUT_MS,
      t('payment.connectError')
    );
    const json = await res.json() as T & { error?: string };
    if (!res.ok || (json as { error?: string }).error) {
      throw new Error((json as { error?: string }).error ?? t('payment.genericError'));
    }
    return json;
  }

  const fetchCards = useCallback(async () => {
    setLoadingCards(true);
    setCardsError(null);
    try {
      const json = await callCardFunction<{ cards: SavedCard[] }>(LIST_CARDS_URL);
      setCards(json.cards ?? []);
    } catch (e: any) {
      console.error('[PaymentScreen] falha ao listar cartões:', e);
      setCardsError(e?.message ?? t('payment.listError'));
      setCards([]);
    } finally {
      setLoadingCards(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchCards();
    }, [fetchCards])
  );

  async function handleAddCard() {
    setAddingCard(true);
    try {
      const json = await callCardFunction<{ url?: string }>(SETUP_CARD_URL);
      if (!json.url) throw new Error(t('payment.setupOpenError'));

      // Abre o Stripe Checkout (modo setup) no navegador do aparelho
      await WebBrowser.openBrowserAsync(json.url);

      // Consulta o Stripe DIRETO (determinístico — não depende do webhook
      // chegar a tempo) para confirmar o novo cartão salvo.
      await callCardFunction(SYNC_CARD_URL).catch(() => { /* usuário pode ter cancelado o checkout */ });

      await refreshProfile();
      await fetchCards();
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('payment.setupError'));
    } finally {
      setAddingCard(false);
    }
  }

  async function handleSetDefault(card: SavedCard) {
    if (card.isDefault || busyCardId) return;
    setBusyCardId(card.id);
    try {
      await callCardFunction(SET_DEFAULT_CARD_URL, { payment_method_id: card.id });
      await refreshProfile();
      await fetchCards();
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('payment.setDefaultError'));
    } finally {
      setBusyCardId(null);
    }
  }

  function confirmRemoveCard(card: SavedCard) {
    const cardLabel = `${BRAND_LABEL[card.brand] ?? card.brand} •••• ${card.last4}`;
    Alert.alert(
      t('payment.removeTitle'),
      t('payment.removeConfirm').replace('{card}', cardLabel),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('payment.remove'), style: 'destructive', onPress: () => handleRemoveCard(card) },
      ]
    );
  }

  async function handleRemoveCard(card: SavedCard) {
    if (busyCardId) return;
    setBusyCardId(card.id);
    try {
      await callCardFunction(REMOVE_CARD_URL, { payment_method_id: card.id });
      await refreshProfile();
      await fetchCards();
    } catch (e: any) {
      Alert.alert(t('common.error'), e?.message ?? t('payment.removeError'));
    } finally {
      setBusyCardId(null);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* ── Cabeçalho ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('payment.title')}</Text>
      </View>

      {loadingCards ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={cards}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            cards.length > 0 ? <Text style={styles.sectionLabel}>{t('payment.yourCards')}</Text> : null
          }
          renderItem={({ item }) => (
            <CardRow
              card={item}
              busy={busyCardId === item.id}
              onPress={() => handleSetDefault(item)}
              onRemove={() => confirmRemoveCard(item)}
              styles={styles}
              colors={colors}
            />
          )}
          ListEmptyComponent={
            cardsError ? (
              <View style={styles.emptyCard}>
                <Text style={[styles.cardEmoji, styles.cardEmojiMuted]}>⚠️</Text>
                <Text style={styles.noCardTitle}>{t('payment.loadErrorTitle')}</Text>
                <Text style={styles.noCardSub}>{cardsError}</Text>
                <TouchableOpacity style={styles.changeBtn} onPress={fetchCards}>
                  <Text style={styles.changeBtnText}>{t('payment.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={[styles.cardEmoji, styles.cardEmojiMuted]}>💳</Text>
                <Text style={styles.noCardTitle}>{t('payment.noCardsTitle')}</Text>
                <Text style={styles.noCardSub}>{t('payment.noCardsSub')}</Text>
              </View>
            )
          }
          ListFooterComponent={
            <>
              <TouchableOpacity style={styles.addBtn} onPress={handleAddCard} disabled={addingCard}>
                {addingCard
                  ? <ActivityIndicator color={colors.white} />
                  : <Text style={styles.addBtnText}>
                      {cards.length > 0 ? t('payment.addNew') : t('payment.addFirst')}
                    </Text>}
              </TouchableOpacity>
              <Text style={styles.secureNote}>{t('payment.secureNote')}</Text>
            </>
          }
        />
      )}
    </SafeAreaView>
  );
}

function CardRow({
  card, busy, onPress, onRemove, styles, colors,
}: {
  card: SavedCard;
  busy: boolean;
  onPress: () => void;
  onRemove: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const { t } = useTranslation();
  const brandLabel = BRAND_LABEL[card.brand] ?? card.brand.toUpperCase();
  const expiry = card.expMonth && card.expYear
    ? `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`
    : null;

  return (
    <TouchableOpacity
      style={[styles.cardRow, card.isDefault && styles.cardRowDefault]}
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.8}
    >
      <View style={styles.cardRowLeft}>
        <Text style={styles.cardRowEmoji}>💳</Text>
        <View>
          <Text style={styles.cardRowBrand}>{brandLabel} •••• {card.last4}</Text>
          <Text style={styles.cardRowMeta}>
            {expiry ? `${t('payment.expires')} ${expiry}` : ''}
            {card.isDefault ? (expiry ? `  •  ${t('payment.default')}` : t('payment.default')) : ''}
          </Text>
        </View>
      </View>

      {busy ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <TouchableOpacity onPress={onRemove} style={styles.cardRowRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.cardRowRemoveText}>{t('payment.remove')}</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    header: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: 16, paddingVertical: 12,
      backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.gray[100],
    },
    back:          { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText:      { fontSize: 24, color: colors.primary },
    title:         { fontSize: 18, fontWeight: '700', color: colors.text, marginLeft: 4 },
    centered:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
    content:       { padding: 20, flexGrow: 1 },
    sectionLabel: {
      fontSize: 13, fontWeight: '700', color: colors.gray[500],
      marginBottom: 10, letterSpacing: 0.5, textTransform: 'uppercase',
    },
    cardRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: colors.card, borderRadius: 16, padding: 16, marginBottom: 12,
      borderWidth: 1.5, borderColor: 'transparent',
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
    },
    cardRowDefault: { borderColor: colors.accent },
    cardRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
    cardRowEmoji: { fontSize: 28 },
    cardRowBrand: { fontSize: 15, fontWeight: '700', color: colors.text },
    cardRowMeta: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    cardRowRemove: { paddingHorizontal: 8, paddingVertical: 4 },
    cardRowRemoveText: { fontSize: 12, fontWeight: '700', color: colors.error },
    emptyCard: {
      backgroundColor: colors.card, borderRadius: 20, padding: 28, alignItems: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08, shadowRadius: 16, elevation: 4, marginBottom: 20,
    },
    cardEmoji:      { fontSize: 52, marginBottom: 14 },
    cardEmojiMuted: { opacity: 0.25 },
    changeBtn:      { marginTop: 20, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary, minWidth: 160, alignItems: 'center' },
    changeBtnText:  { fontSize: 15, fontWeight: '700', color: colors.primary },
    noCardTitle:    { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 10 },
    noCardSub:      { fontSize: 14, color: colors.gray[500], textAlign: 'center', lineHeight: 20, paddingHorizontal: 8 },
    addBtn:         { backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 14, alignItems: 'center', marginTop: 4 },
    addBtnText:     { color: colors.white, fontSize: 16, fontWeight: '700' },
    secureNote:     { marginTop: 20, fontSize: 12, color: colors.gray[400], textAlign: 'center' },
  });
}
