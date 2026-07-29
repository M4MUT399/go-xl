import React from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import Svg, { Path, Line, Circle } from 'react-native-svg';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import type { AppTheme } from '../../constants/theme';
import { useTranslation } from '../../i18n';
import { useAuth } from '../../hooks/useAuth';
import { useTelematics, type TripSession } from '../../hooks/useTelematics';
import { formatDistance } from '../../lib/format';
import type { ScoreCategory } from '../../lib/telematics/scorer';
import type { ChallengeProgress, SlotState } from '../../lib/telematics/challenges';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DrivingInsights'> };

// ─── Medidor semicircular (estilo Cambridge Mobile Telematics) ────────────────

function catColor(cat: ScoreCategory | null, colors: AppTheme): string {
  switch (cat) {
    case 'great':
    case 'good': return colors.success;
    case 'fair': return colors.warning;
    case 'poor': return colors.error;
    default: return colors.gray[400];
  }
}

/** Ponto (x,y) no arco para um valor 0–100 (arco de 180° por cima do centro). */
function pointOnArc(cx: number, cy: number, r: number, value: number): { x: number; y: number } {
  const angle = Math.PI + (Math.PI * Math.max(0, Math.min(100, value))) / 100; // π → 2π
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** Constrói um path de arco (via segmentos) do valor `from` ao `to`. */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const steps = Math.max(2, Math.round(Math.abs(to - from)));
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const v = from + ((to - from) * i) / steps;
    const p = pointOnArc(cx, cy, r, v);
    d += `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
  }
  return d.trim();
}

function Gauge({ score, color, track }: { score: number | null; color: string; track: string }) {
  const W = 260, H = 156, cx = W / 2, cy = 140, r = 108, sw = 18;
  const value = score ?? 0;
  const marks = [75, 85];
  return (
    <Svg width={W} height={H}>
      {/* Trilha de fundo (0–100) */}
      <Path d={arcPath(cx, cy, r, 0, 100)} stroke={track} strokeWidth={sw} strokeLinecap="round" fill="none" />
      {/* Progresso até a nota */}
      {score != null && score > 0 && (
        <Path d={arcPath(cx, cy, r, 0, value)} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
      )}
      {/* Marcas de 75 e 85 */}
      {marks.map((m) => {
        const outer = pointOnArc(cx, cy, r + sw / 2 - 1, m);
        const inner = pointOnArc(cx, cy, r - sw / 2 + 1, m);
        return (
          <Line key={m} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#FFFFFF" strokeWidth={2.5} />
        );
      })}
      {/* Ponteiro na ponta do progresso */}
      {score != null && score > 0 && (() => {
        const p = pointOnArc(cx, cy, r, value);
        return <Circle cx={p.x} cy={p.y} r={sw / 2 - 2} fill="#FFFFFF" stroke={color} strokeWidth={3} />;
      })()}
    </Svg>
  );
}

// ─── Marcadores de desafio (esteira ✓/✕/–) ────────────────────────────────────

function SlotDot({ state, colors }: { state: SlotState; colors: AppTheme }) {
  const map = {
    ok: { bg: colors.success, ch: '✓', fg: '#FFFFFF' },
    fail: { bg: colors.warning, ch: '✕', fg: '#FFFFFF' },
    pending: { bg: colors.gray[200], ch: '–', fg: colors.gray[500] },
  }[state];
  return (
    <View style={[dotStyles.dot, { backgroundColor: map.bg }]}>
      <Text style={[dotStyles.ch, { color: map.fg }]}>{map.ch}</Text>
    </View>
  );
}

const dotStyles = StyleSheet.create({
  dot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginRight: 6, marginBottom: 6 },
  ch: { fontSize: 12, fontWeight: '800' },
});

// ─── Tela ─────────────────────────────────────────────────────────────────────

export function DrivingInsightsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { profile } = useAuth();
  const styles = makeStyles(colors);
  const { sessions, loading, overall, category, scoringCount, challenges, reload } = useTelematics(profile?.id);

  const color = catColor(category, colors);
  const hasData = overall != null;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={colors.accent} />}
      >
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{t('insights.title')}</Text>
        <Text style={styles.subtitle}>{t('insights.poweredBy')}</Text>

        {loading && sessions.length === 0 ? (
          <ActivityIndicator color={colors.accent} style={{ marginTop: 60 }} />
        ) : !hasData ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyEmoji}>🚗</Text>
            <Text style={styles.emptyTitle}>{t('insights.emptyTitle')}</Text>
            <Text style={styles.emptyText}>{t('insights.emptyText')}</Text>
          </View>
        ) : (
          <>
            {/* ── Medidor ── */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>{t('insights.yourScore')}</Text>
              <Text style={styles.window}>
                {t('insights.lastTrips').replace('{n}', String(scoringCount))}
              </Text>
              <View style={styles.gaugeWrap}>
                <Gauge score={overall} color={color} track={colors.gray[200]} />
                <View style={styles.gaugeCenter}>
                  <Text style={[styles.scoreNum, { color: colors.text }]}>{overall}</Text>
                  <Text style={[styles.scoreCat, { color }]}>{t(`insights.cat.${category}`)}</Text>
                </View>
              </View>
              <Text style={styles.hint}>{t('insights.tierHint')}</Text>
            </View>

            {/* ── Desafios de direção segura ── */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>{t('insights.challengesTitle')}</Text>
              <View style={styles.trophyPill}>
                <Text style={styles.trophyText}>
                  🏆 {t('insights.safeThisMonth').replace('{n}', String(challenges.safeTripsThisMonth))}
                </Text>
              </View>
            </View>

            {challenges.challenges.map((c) => (
              <ChallengeCard key={c.key} c={c} colors={colors} styles={styles} t={t} />
            ))}

            {/* ── Viagens recentes ── */}
            <Text style={[styles.sectionTitle, { marginTop: 24 }]}>{t('insights.recentTrips')}</Text>
            {sessions.slice(0, 20).map((s) => (
              <TripRow key={s.id} s={s} colors={colors} styles={styles} />
            ))}

            <Text style={styles.retention}>{t('insights.retention')}</Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ChallengeCard({
  c, colors, styles, t,
}: { c: ChallengeProgress; colors: AppTheme; styles: ReturnType<typeof makeStyles>; t: (k: string) => string }) {
  const status = c.completed
    ? t('insights.challengeDone')
    : t('insights.challengeRemaining').replace('{n}', String(c.remaining || c.target));
  return (
    <View style={styles.challengeCard}>
      <View style={styles.challengeTop}>
        <Text style={styles.challengeName}>{t(`insights.challenge.${c.key}`)}</Text>
        <Text style={[styles.challengeStatus, c.completed && { color: colors.success }]}>{status}</Text>
      </View>
      <View style={styles.slotsRow}>
        {c.slots.map((s, i) => (
          <SlotDot key={i} state={s} colors={colors} />
        ))}
      </View>
    </View>
  );
}

function TripRow({ s, colors, styles }: { s: TripSession; colors: AppTheme; styles: ReturnType<typeof makeStyles> }) {
  const cat = s.score >= 85 ? colors.success : s.score >= 75 ? colors.success : s.score >= 60 ? colors.warning : colors.error;
  const when = s.ended_at ? new Date(s.ended_at) : null;
  const dateStr = when
    ? when.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) +
      ' · ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '—';
  const chips: { icon: string; n: number }[] = [
    { icon: '⚡', n: s.speeding_count },
    { icon: '🛑', n: s.hard_brake_count },
    { icon: '🚀', n: s.hard_accel_count },
    { icon: '↪️', n: s.hard_corner_count },
  ].filter((x) => x.n > 0);
  return (
    <View style={styles.tripRow}>
      <View style={[styles.tripScore, { borderColor: cat }]}>
        <Text style={[styles.tripScoreNum, { color: cat }]}>{s.score}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.tripDate}>{dateStr}</Text>
        <Text style={styles.tripMeta}>{formatDistance(s.distance_km)} · {Math.round(s.duration_min)} min</Text>
      </View>
      <View style={styles.tripChips}>
        {chips.length === 0 ? (
          <Text style={styles.tripClean}>✓</Text>
        ) : (
          chips.map((x, i) => (
            <Text key={i} style={styles.tripChip}>{x.icon}{x.n}</Text>
          ))
        )}
      </View>
    </View>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { padding: 20, paddingBottom: 48 },
    back: { marginBottom: 8 },
    backText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
    title: { fontSize: 28, fontWeight: '800', color: colors.text },
    subtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2, marginBottom: 16 },

    card: { backgroundColor: colors.card, borderRadius: 18, padding: 20, borderWidth: 1, borderColor: colors.border, marginBottom: 20 },
    cardLabel: { fontSize: 18, fontWeight: '700', color: colors.text },
    window: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
    gaugeWrap: { alignItems: 'center', justifyContent: 'center', marginTop: 8 },
    gaugeCenter: { position: 'absolute', top: 54, alignItems: 'center' },
    scoreNum: { fontSize: 52, fontWeight: '800', lineHeight: 56 },
    scoreCat: { fontSize: 18, fontWeight: '700', marginTop: -2 },
    hint: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 8 },

    sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
    sectionTitle: { fontSize: 20, fontWeight: '800', color: colors.text },
    trophyPill: { backgroundColor: colors.success + '22', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
    trophyText: { color: colors.success, fontWeight: '700', fontSize: 12 },

    challengeCard: { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
    challengeTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
    challengeName: { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 },
    challengeStatus: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
    slotsRow: { flexDirection: 'row', flexWrap: 'wrap' },

    tripRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
    tripScore: { width: 44, height: 44, borderRadius: 22, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    tripScoreNum: { fontSize: 16, fontWeight: '800' },
    tripDate: { fontSize: 14, fontWeight: '700', color: colors.text },
    tripMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
    tripChips: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', maxWidth: 110, justifyContent: 'flex-end' },
    tripChip: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
    tripClean: { fontSize: 18, color: colors.success, fontWeight: '800' },

    emptyCard: { alignItems: 'center', padding: 32, marginTop: 24 },
    emptyEmoji: { fontSize: 48, marginBottom: 12 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
    emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginTop: 6, lineHeight: 20 },

    retention: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: 20, lineHeight: 18 },
  });
}
