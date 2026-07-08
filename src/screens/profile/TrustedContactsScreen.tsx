import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView, Switch, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { useTrustedContacts } from '../../hooks/useTrustedContacts';
import { supabase } from '../../lib/supabase';
import { Input } from '../../components/common/Input';
import { Button } from '../../components/common/Button';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'TrustedContacts'> };

/**
 * Contatos de confiança + preferência de compartilhamento automático (Tarefa 1).
 *
 * Aqui o passageiro cadastra pessoas para quem costuma enviar o link de
 * acompanhamento e, opcionalmente, liga o "auto-compartilhar": ao iniciar a
 * corrida, o app oferece abrir o share sheet para o contato escolhido em um
 * toque. O envio NUNCA é automático — o share sheet sempre exige a ação do
 * passageiro (regra de segurança).
 */
export function TrustedContactsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { profile, patchProfile } = useAuth();
  const { contacts, loading, addContact, removeContact } = useTrustedContacts(profile?.id);

  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const styles = makeStyles(colors);

  const autoshare = profile?.trip_autoshare ?? false;
  const autoContactId = profile?.trip_autoshare_contact_id ?? null;

  async function handleAdd() {
    if (!name.trim()) {
      Alert.alert('Contato de confiança', 'Informe ao menos o nome do contato.');
      return;
    }
    setSaving(true);
    const ok = await addContact(name, label);
    setSaving(false);
    if (ok) {
      setName('');
      setLabel('');
    } else {
      Alert.alert('Contato de confiança', 'Não foi possível salvar o contato. Tente novamente.');
    }
  }

  function handleRemove(id: string, contactName: string) {
    Alert.alert('Remover contato', `Remover "${contactName}" da lista?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Remover',
        style: 'destructive',
        onPress: async () => {
          const ok = await removeContact(id);
          // Se o contato removido era o escolhido para auto-compartilhar, limpa a
          // preferência para não apontar para um id inexistente.
          if (ok && autoContactId === id && profile?.id) {
            patchProfile({ trip_autoshare_contact_id: null });
            await supabase.from('profiles').update({ trip_autoshare_contact_id: null }).eq('id', profile.id);
          }
        },
      },
    ]);
  }

  async function toggleAutoshare(on: boolean) {
    if (!profile?.id) return;
    // Ligar sem nenhum contato cadastrado não faz sentido — orienta a cadastrar.
    if (on && contacts.length === 0) {
      Alert.alert('Compartilhamento automático', 'Cadastre um contato de confiança antes de ativar.');
      return;
    }
    // Ao ligar sem contato escolhido, assume o primeiro da lista por conveniência.
    const nextContactId = on ? (autoContactId ?? contacts[0]?.id ?? null) : autoContactId;
    patchProfile({ trip_autoshare: on, trip_autoshare_contact_id: nextContactId });
    await supabase
      .from('profiles')
      .update({ trip_autoshare: on, trip_autoshare_contact_id: nextContactId })
      .eq('id', profile.id);
  }

  async function chooseAutoContact(id: string) {
    if (!profile?.id) return;
    patchProfile({ trip_autoshare_contact_id: id });
    await supabase.from('profiles').update({ trip_autoshare_contact_id: id }).eq('id', profile.id);
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Voltar</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Contatos de confiança</Text>
        <Text style={styles.subtitle}>
          Pessoas para quem você costuma enviar o link de acompanhamento da viagem ao vivo.
        </Text>

        {/* ── Auto-compartilhar ─────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Compartilhamento automático</Text>
              <Text style={styles.rowDesc}>
                Ao iniciar a corrida, oferecemos abrir o envio para o contato escolhido.
                O link só é enviado quando você confirma.
              </Text>
            </View>
            <Switch
              value={autoshare}
              onValueChange={toggleAutoshare}
              trackColor={{ true: colors.accent, false: colors.gray[300] }}
              thumbColor={colors.white}
            />
          </View>

          {autoshare && contacts.length > 0 && (
            <View style={styles.chooseBlock}>
              <Text style={styles.chooseLabel}>Enviar para</Text>
              {contacts.map((c) => {
                const selected = autoContactId === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.chooseRow}
                    onPress={() => chooseAutoContact(c.id)}
                  >
                    <View style={[styles.radio, selected && styles.radioOn]}>
                      {selected && <View style={styles.radioDot} />}
                    </View>
                    <Text style={styles.chooseName}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* ── Lista de contatos ─────────────────────────────────── */}
        <Text style={styles.sectionLabel}>Seus contatos</Text>
        <View style={styles.card}>
          {loading ? (
            <Text style={styles.empty}>Carregando…</Text>
          ) : contacts.length === 0 ? (
            <Text style={styles.empty}>Nenhum contato cadastrado ainda.</Text>
          ) : (
            contacts.map((c, i) => (
              <View key={c.id} style={[styles.row, i < contacts.length - 1 && styles.rowBorder]}>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{c.name}</Text>
                  {!!c.contact && <Text style={styles.rowDesc}>{c.contact}</Text>}
                </View>
                <TouchableOpacity onPress={() => handleRemove(c.id, c.name)}>
                  <Text style={styles.removeText}>Remover</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* ── Adicionar ─────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>Adicionar contato</Text>
        <View style={styles.card}>
          <View style={styles.formPad}>
            <Input
              label="Nome"
              placeholder="Ex.: Maria (esposa)"
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
            />
            <Input
              label="Telefone ou e-mail (opcional)"
              placeholder="Só para você reconhecer na lista"
              value={label}
              onChangeText={setLabel}
              autoCapitalize="none"
            />
            <Button title="Adicionar contato" onPress={handleAdd} loading={saving} />
          </View>
        </View>

        <Text style={styles.note}>
          O rótulo de telefone/e-mail serve apenas para você reconhecer o contato. O envio do
          link é sempre feito por você, pelo compartilhamento nativo do celular.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 24 },
    back: { marginBottom: 20, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    subtitle: { fontSize: 14, color: colors.gray[500], marginBottom: 24, lineHeight: 20 },
    sectionLabel: {
      fontSize: 12, color: colors.gray[400], textTransform: 'uppercase',
      letterSpacing: 0.5, marginBottom: 8, marginTop: 8,
    },
    card: { backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 16, marginBottom: 16 },
    formPad: { paddingVertical: 16 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    rowText: { flex: 1, paddingRight: 12 },
    rowTitle: { fontSize: 15, fontWeight: '600', color: colors.gray[800] },
    rowDesc: { fontSize: 12, color: colors.gray[500], marginTop: 2, lineHeight: 17 },
    removeText: { fontSize: 13, color: colors.error, fontWeight: '700' },
    empty: { fontSize: 14, color: colors.gray[400], paddingVertical: 18, textAlign: 'center' },
    // Escolha do contato para auto-compartilhar
    chooseBlock: { paddingBottom: 16, paddingTop: 4 },
    chooseLabel: {
      fontSize: 12, color: colors.gray[400], textTransform: 'uppercase',
      letterSpacing: 0.5, marginBottom: 8,
    },
    chooseRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    radio: {
      width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.gray[300],
      alignItems: 'center', justifyContent: 'center', marginRight: 10,
    },
    radioOn: { borderColor: colors.accent },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
    chooseName: { fontSize: 15, color: colors.gray[800] },
    note: { fontSize: 12, color: colors.gray[400], marginTop: 4, lineHeight: 18 },
  });
}
