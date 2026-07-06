import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, Alert,
  ActivityIndicator, Image, Animated, useWindowDimensions, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Svg, {
  Defs, LinearGradient as SvgGrad, Stop,
  Rect, Circle, Line,
} from 'react-native-svg';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { supabase } from '../../lib/supabase';
import { Button } from '../../components/common/Button';
import { hasPaymentCard } from '../../lib/onboarding';

const SUPABASE_URL   = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SETUP_CARD_URL = `${SUPABASE_URL}/functions/v1/setup-card`;
const SYNC_CARD_URL  = `${SUPABASE_URL}/functions/v1/sync-card`;

/** fetch COM timeout — o fetch do React Native NÃO tem timeout nativo. Sem isto,
 *  uma Edge Function lenta ou sem resposta deixa a tela "carregando" para sempre
 *  (o sintoma relatado no iOS e no Android). Ao estourar o prazo, aborta e o
 *  chamador cai num erro tratável em vez de congelar. */
async function fetchWithTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const GOLD       = '#C9A84C';
const GOLD_DIM   = 'rgba(201,168,76,0.7)';
const GOLD_FAINT = 'rgba(201,168,76,0.15)';
const WHITE      = '#FFFFFF';

type Phase = 'idle' | 'processing' | 'confirmed';

interface CardInfo {
  holderName: string;
  last4: string;
  brand: string;
  memberYear: number;
}

// ─── GoXL Credit Card ─────────────────────────────────────────────────────────

function GoXLCard({ info, W }: { info: CardInfo; W: number }) {
  const H = Math.round(W / 1.45);
  const name = (info.holderName || 'PASSENGER').toUpperCase();

  return (
    <View style={[card.wrap, { width: W, height: H }]}>
      {/* SVG background */}
      <Svg width={W} height={H} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGrad id="bg" x1="0" y1="0" x2={W} y2={H} gradientUnits="userSpaceOnUse">
            <Stop offset="0"   stopColor="#07091A" />
            <Stop offset="0.5" stopColor="#101828" />
            <Stop offset="1"   stopColor="#091520" />
          </SvgGrad>
          <SvgGrad id="shine" x1="0" y1="0" x2={W} y2={H} gradientUnits="userSpaceOnUse">
            <Stop offset="0"    stopColor={GOLD} stopOpacity="0" />
            <Stop offset="0.45" stopColor={GOLD} stopOpacity="0.07" />
            <Stop offset="1"    stopColor={GOLD} stopOpacity="0" />
          </SvgGrad>
        </Defs>
        <Rect width={W} height={H} rx={20} fill="url(#bg)" />
        <Rect width={W} height={H} rx={20} fill="url(#shine)" />
        <Circle cx={W + 8} cy={-12} r={130} fill="none" stroke={GOLD} strokeWidth={0.7} strokeOpacity={0.22} />
        <Circle cx={W + 8} cy={-12} r={98}  fill="none" stroke={GOLD} strokeWidth={0.5} strokeOpacity={0.15} />
        <Circle cx={W + 8} cy={-12} r={68}  fill="none" stroke={GOLD} strokeWidth={0.4} strokeOpacity={0.10} />
        <Rect x={0} y={H - 54} width={W} height={0.5} fill={GOLD} fillOpacity={0.2} />
        <Circle cx={W - 52} cy={H - 27} r={24} fill={GOLD}    fillOpacity={0.65} />
        <Circle cx={W - 30} cy={H - 27} r={24} fill="#E8C96A" fillOpacity={0.40} />
      </Svg>

      {/* ── Topo: logo + NFC — posição absoluta ──── */}
      <View style={card.topRow}>
        <Image source={require('../../../assets/icon.png')} style={card.logo} />
        <View style={card.nfc}>
          <View style={card.nfcR3} />
          <View style={card.nfcR2} />
          <View style={card.nfcR1} />
        </View>
      </View>

      {/* ── Meio: chip + nome + número ────────────── */}
      {/* posicionado absolutamente no centro do card */}
      <View style={[card.midSection, { top: H * 0.52 }]}>
        <View style={card.nameRow}>
          <View style={card.chip}>
            <View style={card.chipInner} />
          </View>
          <Text style={card.passengerName} numberOfLines={1}>{name}</Text>
        </View>
        <Text style={card.cardNum}>•••• •••• •••• {info.last4 || '••••'}</Text>
      </View>

      {/* ── Rodapé — posição absoluta no fundo ────── */}
      <View style={[card.bottomRow, { bottom: 10 }]}>
        <View style={{ flex: 1 }}>
          <Text style={card.holderLabel}>TITULAR</Text>
          <Text style={card.holderValue} numberOfLines={1}>{name}</Text>
        </View>
        <View style={{ alignItems: 'flex-end', marginRight: 70 }}>
          <Text style={card.holderLabel}>MEMBRO DESDE</Text>
          <Text style={card.holderValue}>{info.memberYear}</Text>
        </View>
      </View>
    </View>
  );
}

// ─── Tela de sucesso ──────────────────────────────────────────────────────────

function ConfirmedScreen({ info }: { info: CardInfo }) {
  const { width: sw } = useWindowDimensions();
  const CARD_W = sw - 48;

  const fade  = useRef(new Animated.Value(0)).current;
  const slideY = useRef(new Animated.Value(40)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade,   { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(slideY, { toValue: 0, friction: 6, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <SafeAreaView style={suc.container}>
      {/* Ornamentos dourados sutis no fundo */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        {/* Canto superior esquerdo */}
        <Circle cx={0}   cy={0}   r={120} fill="none" stroke={GOLD} strokeWidth={1} strokeOpacity={0.08} />
        <Circle cx={0}   cy={0}   r={80}  fill="none" stroke={GOLD} strokeWidth={1} strokeOpacity={0.06} />
        {/* Canto inferior direito */}
        <Circle cx="100%" cy="100%" r={140} fill="none" stroke={GOLD} strokeWidth={1} strokeOpacity={0.07} />
        <Circle cx="100%" cy="100%" r={90}  fill="none" stroke={GOLD} strokeWidth={1} strokeOpacity={0.05} />
        {/* Linha horizontal sutil no centro */}
        <Line x1="10%" y1="52%" x2="90%" y2="52%"
          stroke={GOLD} strokeWidth={0.5} strokeOpacity={0.12}
          strokeDasharray="4 8"
        />
      </Svg>

      <Animated.View style={[suc.content, { opacity: fade, transform: [{ translateY: slideY }] }]}>

        {/* Cartão centrado */}
        <GoXLCard info={info} W={CARD_W} />

        {/* Mensagem de aprovação */}
        <View style={suc.msgWrap}>
          <View style={suc.badge}>
            <Text style={suc.badgeTick}>✓</Text>
          </View>
          <Text style={suc.title}>Cartão aprovado!</Text>
          <Text style={suc.subtitle}>
            Seu cartão GoXL está pronto.{'\n'}Agora você pode solicitar viagens.
          </Text>

          {/* Divisor dourado */}
          <View style={suc.divider} />

          <Text style={suc.hint}>Redirecionando para o app…</Text>
        </View>

      </Animated.View>
    </SafeAreaView>
  );
}

// ─── Tela de processamento ────────────────────────────────────────────────────

function ProcessingScreen({ onEscape }: { onEscape?: () => void }) {
  const { colors } = useTheme();
  const [showEscape, setShowEscape] = useState(false);

  // Se depois de 5s ainda estiver processando, oferece uma saída manual para
  // o usuário nunca ficar preso sem ação (rede muito lenta, etc).
  useEffect(() => {
    const t = setTimeout(() => setShowEscape(true), 5000);
    return () => clearTimeout(t);
  }, []);

  return (
    <SafeAreaView style={[suc.container, { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 }]}>
      <Image source={require('../../../assets/icon.png')} style={suc.procLogo} />
      <ActivityIndicator size="large" color={colors.accent} style={{ marginTop: 28 }} />
      <Text style={suc.procText}>Confirmando seu cartão…</Text>
      <Text style={suc.procHint}>Isso pode levar alguns segundos.</Text>
      {showEscape && onEscape && (
        <Text style={suc.procEscape} onPress={onEscape}>
          Está demorando? Toque para voltar
        </Text>
      )}
    </SafeAreaView>
  );
}

// ─── Tela principal de onboarding ─────────────────────────────────────────────

export function AddCardOnboardingScreen() {
  const { profile, session, refreshProfile, patchProfile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<{ canGoBack: () => boolean; goBack: () => void }>();
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [cardInfo, setCardInfo] = useState<CardInfo>({
    holderName: profile?.full_name ?? '',
    last4: '',
    brand: '',
    memberYear: new Date().getFullYear(),
  });

  const userId = profile?.id ?? session?.user?.id;
  const styles = makeStyles(colors);

  // Sincroniza o nome sempre que o profile carregar (resolve race condition do useState)
  useEffect(() => {
    if (profile?.full_name) {
      setCardInfo(prev => ({ ...prev, holderName: profile.full_name! }));
    }
  }, [profile?.full_name]);

  // Esta tela NUNCA deveria aparecer para quem já tem cartão salvo. Mas o gate
  // em RequestRideScreen (hasPaymentCard) pode ler um profile null/desatualizado
  // quando o carregamento do perfil falha ou demora (rede ruim) e navegar para
  // cá por engano — foi o que causou o passageiro ver esta tela "do nada" e o
  // app parecer travado. Assim que confirmarmos (já no mount, ou logo depois
  // de um refresh) que o cartão já existe, saímos em silêncio, sem mostrar
  // nada ao usuário.
  useEffect(() => {
    if (phase === 'idle' && hasPaymentCard(profile)) {
      if (navigation.canGoBack()) navigation.goBack();
    }
  }, [profile, phase, navigation]);

  // Se chegamos aqui sem cartão no estado local, revalida contra o servidor:
  // o profile pode estar desatualizado (falha/timeout no gate anterior) mesmo
  // que o cartão já exista no banco. Isso alimenta o efeito acima.
  useEffect(() => {
    if (!hasPaymentCard(profile)) refreshProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esta tela agora é um PASSO dentro do app (chamada pelo gate de "pedir
  // corrida"), não mais o "muro" inicial. Ao confirmar o cartão, mostra a
  // celebração por um instante e volta para a tela anterior (pedir corrida),
  // que já enxerga o cartão salvo e deixa o passageiro solicitar.
  useEffect(() => {
    if (phase !== 'confirmed') return;
    const t = setTimeout(() => {
      if (navigation.canGoBack()) navigation.goBack();
    }, 1600);
    return () => clearTimeout(t);
  }, [phase, navigation]);

  type CardUpdates = {
    stripe_payment_method_id: string;
    stripe_customer_id: string;
    card_last4: string;
    card_brand: string;
  };

  /** Consulta o Stripe DIRETO (via Edge Function sync-card) e grava o cartão no
   *  perfil. Determinístico: não depende do webhook ter chegado. */
  /** Token de acesso SEM re-chamar getSession() à toa: usa a sessão que já está
   *  no contexto (instantâneo e sem risco do lock interno do gotrue travar no
   *  iOS de produção). Só consulta o gotrue como fallback — e mesmo assim com
   *  timeout de 4s para nunca pendurar. */
  async function getAccessToken(): Promise<string | null> {
    if (session?.access_token) return session.access_token;
    try {
      return await Promise.race([
        supabase.auth.getSession().then(({ data }) => data.session?.access_token ?? null),
        new Promise<null>((res) => setTimeout(() => res(null), 4000)),
      ]);
    } catch {
      return null;
    }
  }

  async function syncCard(): Promise<CardUpdates | null> {
    if (!userId) return null;
    const token = await getAccessToken();
    if (!token) return null;

    try {
      const res = await fetchWithTimeout(SYNC_CARD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      }, 12000);
      const json = await res.json() as {
        found?: boolean;
        payment_method_id?: string;
        customer_id?: string;
        last4?: string;
        brand?: string;
      };
      if (!json.found || !json.payment_method_id) return null;

      setCardInfo({
        holderName: profile?.full_name ?? '',
        last4: json.last4 ?? '',
        brand: json.brand ?? '',
        memberYear: new Date().getFullYear(),
      });

      return {
        stripe_payment_method_id: json.payment_method_id,
        stripe_customer_id: json.customer_id ?? '',
        card_last4: json.last4 ?? '',
        card_brand: json.brand ?? '',
      };
    } catch {
      return null;
    }
  }

  /** Tenta sincronizar algumas vezes — cobre o caso do cartão levar 1-2s para
   *  ser anexado ao Customer no Stripe após o submit do formulário. */
  async function pollForCard(): Promise<CardUpdates | null> {
    // Prazo total limitado (30s) — nunca deixa o usuário preso indefinidamente.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const updates = await syncCard();
      if (updates) return updates;
      await new Promise<void>((r) => setTimeout(r, 1500));
    }
    return null;
  }

  async function celebrateAndEnter(cardUpdates?: {
    stripe_payment_method_id: string;
    stripe_customer_id: string;
    card_last4: string;
    card_brand: string;
  }) {
    setPhase('confirmed');

    // Se tivermos as atualizações do cartão, aplica imediatamente no contexto
    // compartilhado → AppNavigator re-renderiza e troca de stack sem precisar
    // de nova query ao Supabase (que pode estar lenta ou com erro de rede).
    if (cardUpdates) {
      patchProfile(cardUpdates);
      // Em paralelo, tenta carregar o profile completo do DB (preenche o nome
      // real). Se falhar, o patch acima já garantiu a navegação.
      try { await refreshProfile(); } catch { /* ignora falha de rede */ }
      patchProfile(cardUpdates); // reforço: garante o campo de cartão após o fetch
      return; // AppNavigator vai navegar automaticamente
    }

    // Fallback para o fluxo real do Stripe: aguarda webhook gravar e faz poll.
    await new Promise<void>((r) => setTimeout(r, 2000));
    for (let i = 0; i < 8; i++) {
      try { await refreshProfile(); } catch { /* ignora falha de rede */ }
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
  }

  async function handleAddCard() {
    setLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        Alert.alert('Erro', 'Sessão expirada. Faça login novamente.');
        setLoading(false);
        return;
      }

      const res = await fetchWithTimeout(SETUP_CARD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      }, 20000);

      const json = await res.json() as { url?: string; error?: string };
      if (!json.url) {
        Alert.alert('Erro', json.error ?? 'Não foi possível abrir o formulário de pagamento.');
        setLoading(false);
        return;
      }

      await WebBrowser.openBrowserAsync(json.url);
      setLoading(false);
      setPhase('processing');

      const updates = await pollForCard();
      if (updates) {
        await celebrateAndEnter(updates);
      } else {
        setPhase('idle');
        Alert.alert(
          'Quase lá',
          'Ainda não recebemos confirmação do seu cartão. Se você concluiu o cadastro no navegador, toque em "Já adicionei meu cartão".'
        );
      }
    } catch {
      setPhase('idle');
      setLoading(false);
      Alert.alert('Erro', 'Não foi possível configurar o pagamento. Tente novamente.');
    }
  }

  /** DEV ONLY — escreve cartão fictício no perfil para pular o Stripe. */
  async function handleDevBypass() {
    if (!userId) { Alert.alert('Erro', 'Sessão não encontrada.'); return; }
    setPhase('processing');

    const cardUpdates = {
      stripe_payment_method_id: 'pm_test_bypass_dev',
      stripe_customer_id:       'cus_test_bypass_dev',
      card_last4:               '4242',
      card_brand:               'Visa',
    } as const;

    // UPSERT (não UPDATE): se a linha do profile não existir no banco — caso
    // deste passageiro de teste — o UPDATE não criaria nada e o INSERT de
    // viagens falharia com violação de FK (23503). O upsert garante a linha.
    const sessionEmail = session?.user?.email ?? '';
    const fallbackName = profile?.full_name
      || (sessionEmail ? sessionEmail.split('@')[0] : '')
      || 'Passageiro';

    const { error } = await supabase.from('profiles').upsert({
      id:         userId,
      full_name:  fallbackName,
      phone:      profile?.phone ?? '',
      email:      profile?.email ?? sessionEmail,
      type:       'passenger',
      rating:     profile?.rating ?? 5.0,
      total_rides: profile?.total_rides ?? 0,
      language:   profile?.language ?? 'en',
      ...cardUpdates,
    }, { onConflict: 'id' });

    if (error) {
      setPhase('idle');
      Alert.alert('Erro', error.message);
      return;
    }

    setCardInfo({
      holderName:  fallbackName,
      last4:       '4242',
      brand:       'Visa',
      memberYear:  new Date().getFullYear(),
    });

    // Passa os dados do cartão direto → patchProfile atualiza o contexto
    // imediatamente e o AppNavigator troca de stack sem nova query ao Supabase.
    await celebrateAndEnter(cardUpdates);
  }

  async function handleRecheck() {
    setPhase('processing');
    const updates = await syncCard();
    if (updates) {
      await celebrateAndEnter(updates);
    } else {
      setPhase('idle');
      Alert.alert('Atenção', 'Ainda não encontramos um cartão cadastrado. Tente adicionar novamente.');
    }
  }

  if (phase === 'confirmed') return <ConfirmedScreen info={cardInfo} />;
  if (phase === 'processing') return <ProcessingScreen onEscape={() => { setPhase('idle'); setLoading(false); }} />;

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.content, Platform.OS === 'android' && { paddingBottom: 32 + insets.bottom }]}>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>💳</Text>
        </View>
        <Text style={styles.title}>Adicione um cartão{'\n'}para continuar</Text>
        <Text style={styles.subtitle}>
          O Go XL cobra as viagens automaticamente ao final de cada corrida.
          Seu cartão é necessário antes de solicitar o primeiro transporte.
        </Text>
        <View style={styles.benefits}>
          <BenefitRow icon="🔒" text="Pagamento seguro via Stripe — seus dados ficam protegidos" />
          <BenefitRow icon="⚡" text="Cobrança automática — sem precisar pagar na hora" />
          <BenefitRow icon="🧾" text="Recibo enviado por e-mail após cada viagem" />
          <BenefitRow icon="❌" text="Você pode remover o cartão a qualquer momento no perfil" />
        </View>
        <Button
          title={loading ? 'Aguarde...' : 'Adicionar cartão agora'}
          onPress={handleAddCard}
          loading={loading}
        />
        <Text style={styles.recheck} onPress={handleRecheck}>
          Já adicionei meu cartão
        </Text>

        {/* ── Bypass de desenvolvimento (remover antes do lançamento) ── */}
        {__DEV__ && (
          <Text style={styles.devBypass} onPress={handleDevBypass}>
            [DEV] Entrar sem cartão (modo teste)
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}

function BenefitRow({ icon, text }: { icon: string; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 }}>
      <Text style={{ fontSize: 18, marginRight: 10 }}>{icon}</Text>
      <Text style={{ flex: 1, fontSize: 14, color: colors.textSecondary, lineHeight: 20 }}>{text}</Text>
    </View>
  );
}

// ─── Credit Card styles ───────────────────────────────────────────────────────

const card = StyleSheet.create({
  wrap: {
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: GOLD,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 18,
  },
  // Topo: logo + NFC — padding próprio, não depende do card padding
  topRow: {
    position: 'absolute',
    top: 16, left: 16, right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  logo: { width: 96, height: 96, borderRadius: 22 },
  nfc:  { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  nfcR3: { position: 'absolute', width: 30, height: 30, borderRadius: 15, borderWidth: 1.2, borderColor: 'rgba(201,168,76,0.45)' },
  nfcR2: { position: 'absolute', width: 20, height: 20, borderRadius: 10, borderWidth: 1.2, borderColor: 'rgba(201,168,76,0.35)' },
  nfcR1: { position: 'absolute', width: 10, height: 10, borderRadius:  5, borderWidth: 1.2, borderColor: 'rgba(201,168,76,0.5)'  },
  // Meio: chip + nome + número — posição absoluta calculada
  midSection: {
    position: 'absolute',
    left: 16, right: 16,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  chip: {
    width: 34, height: 26, borderRadius: 5,
    backgroundColor: GOLD,
    alignItems: 'center', justifyContent: 'center',
    opacity: 0.9,
  },
  chipInner: {
    width: 26, height: 18, borderRadius: 3,
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.2)',
    backgroundColor: '#E8C96A',
  },
  passengerName: {
    color: WHITE,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.8,
    flex: 1,
  },
  cardNum: {
    color: WHITE,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 3,
  },
  // Rodapé — posição absoluta no fundo
  bottomRow: {
    position: 'absolute',
    left: 16, right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  holderLabel: { color: GOLD_DIM, fontSize: 8, fontWeight: '700', letterSpacing: 2, marginBottom: 3 },
  holderValue: { color: WHITE, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
});

// ─── Success screen styles ────────────────────────────────────────────────────

const suc = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: WHITE,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  msgWrap: {
    alignItems: 'center',
    marginTop: 32,
    width: '100%',
  },
  badge: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: '#22C55E',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#22C55E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  badgeTick: { color: WHITE, fontSize: 28, fontWeight: '900', lineHeight: 32 },
  title: {
    fontSize: 26, fontWeight: '900',
    color: '#0A0D1C',
    marginBottom: 8, textAlign: 'center',
  },
  subtitle: {
    fontSize: 15, color: '#6B7280',
    textAlign: 'center', lineHeight: 22,
  },
  divider: {
    marginTop: 20, marginBottom: 14,
    width: 60, height: 2,
    backgroundColor: GOLD,
    borderRadius: 2,
    opacity: 0.6,
  },
  hint: { fontSize: 12, color: GOLD_DIM, letterSpacing: 1 },
  // processing
  procLogo: { width: 120, height: 120, borderRadius: 28 },
  procText:  { marginTop: 16, fontSize: 15, color: '#6B7280' },
  procHint:  { marginTop: 6, fontSize: 13, color: '#9AA1AC', textAlign: 'center' },
  procEscape:{ marginTop: 28, fontSize: 14, fontWeight: '600', color: GOLD_DIM, textAlign: 'center' },
});

// ─── Onboarding styles ────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: {
      flex: 1, paddingHorizontal: 28, paddingTop: 48, paddingBottom: 32,
      justifyContent: 'center',
    },
    iconWrap: {
      alignSelf: 'center', backgroundColor: colors.surface,
      borderRadius: 32, width: 80, height: 80,
      alignItems: 'center', justifyContent: 'center', marginBottom: 28,
    },
    icon: { fontSize: 40 },
    title: {
      fontSize: 28, fontWeight: '800', color: colors.text,
      textAlign: 'center', lineHeight: 36, marginBottom: 14,
    },
    subtitle: {
      fontSize: 15, color: colors.textMuted,
      textAlign: 'center', lineHeight: 22, marginBottom: 32,
    },
    benefits: {
      backgroundColor: colors.surface, borderRadius: 16,
      padding: 18, marginBottom: 32,
    },
    recheck: {
      marginTop: 18, textAlign: 'center',
      fontSize: 14, fontWeight: '600', color: colors.accent,
    },
    devBypass: {
      marginTop: 24, textAlign: 'center',
      fontSize: 12, color: colors.gray[400],
      borderTopWidth: 1, borderTopColor: colors.gray[200],
      paddingTop: 16,
    },
  });
}
