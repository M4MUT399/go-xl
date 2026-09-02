import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView, Switch, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { BackButton } from '../../components/common/BackButton';
import { useTranslation } from '../../i18n';
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
  const { t } = useTranslation();
  const { profile, patchProfile } = useAuth();
  const { contacts, loading, loadFailed, addContact, removeContact } = useTrustedContacts(profile?.id);

  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const styles = makeStyles(colors);

  const autoshare = profile?.trip_autoshare ?? false;
  const autoContactId = profile?.trip_autoshare_contact_id ?? null;

  // Trava de escrita em voo para as DUAS funções abaixo — elas gravam as MESMAS
  // colunas (`trip_autoshare`, `trip_autoshare_contact_id`), então uma trava só
  // para cada uma não resolveria nada.
  //
  // O defeito sem ela: cada chamada captura no fecho o valor de rollback vigente
  // quando começou. Dois toques rápidos criam dois UPDATEs concorrentes com
  // instantâneos DIFERENTES; se o primeiro falhar depois de o segundo ter
  // gravado, o rollback do primeiro escreve por cima um estado local que já não
  // corresponde ao banco. A chave passa a mostrar o contrário do que o servidor
  // tem — e esta é a chave que promete que alguém está acompanhando a viagem.
  //
  // Ignorar o segundo toque (em vez de enfileirar) é o certo aqui: o usuário vê
  // a chave parada no valor em gravação, que é a verdade em curso, e o toque
  // seguinte vale assim que o servidor responder.
  const autoshareWriteRef = useRef(false);

  async function handleAdd() {
    if (!name.trim()) {
      Alert.alert(t('trustedContacts.alertTitle'), t('trustedContacts.needName'));
      return;
    }
    setSaving(true);
    const ok = await addContact(name, label);
    setSaving(false);
    if (ok) {
      setName('');
      setLabel('');
    } else {
      Alert.alert(t('trustedContacts.alertTitle'), t('trustedContacts.saveError'));
    }
  }

  function handleRemove(id: string, contactName: string) {
    Alert.alert(
      t('trustedContacts.removeTitle'),
      t('trustedContacts.removeConfirm').replace('{name}', contactName),
      [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('trustedContacts.remove'),
        style: 'destructive',
        onPress: async () => {
          const ok = await removeContact(id);
          // A falha do DELETE era engolida: o contato continuava na lista, sem
          // explicação, e o passageiro achava que o toque não tinha "pegado".
          if (!ok) {
            Alert.alert(t('trustedContacts.alertTitle'), t('trustedContacts.saveError'));
            return;
          }
          // Se o contato removido era o escolhido para auto-compartilhar, limpa a
          // preferência para não apontar para um id inexistente.
          //
          // Este é o TERCEIRO escritor de `trip_autoshare_contact_id`, e por isso
          // ele entra na MESMA `autoshareWriteRef` das outras duas: sem isso, um
          // `toggleAutoshare` em voo poderia gravar por cima justamente o id do
          // contato que acabou de ser apagado. E o `error` não pode ser
          // descartado — se este UPDATE falhar em silêncio, o perfil segue
          // prometendo compartilhar a viagem com um contato que não existe mais,
          // que é a pior forma desta tela mentir.
          if (autoContactId === id && profile?.id && !autoshareWriteRef.current) {
            patchProfile({ trip_autoshare_contact_id: null });
            autoshareWriteRef.current = true;
            try {
              const { error } = await supabase
                .from('profiles').update({ trip_autoshare_contact_id: null }).eq('id', profile.id);
              if (error) {
                patchProfile({ trip_autoshare_contact_id: autoContactId });
                Alert.alert(t('trustedContacts.alertTitle'), t('trustedContacts.saveError'));
              }
            } finally {
              autoshareWriteRef.current = false;
            }
          }
        },
      },
    ]);
  }

  /**
   * Esta é a chave mais perigosa da tela: ela promete que TODA viagem futura
   * será compartilhada automaticamente com o contato de emergência escolhido.
   * O `patchProfile` é otimista (vira na hora, só no estado local) e o UPDATE que
   * vinha depois tinha o erro DESCARTADO — com RLS ou rede falhando, a chave
   * ficava verde, o passageiro entrava no carro de um estranho acreditando que
   * alguém estava acompanhando a viagem, e no banco `trip_autoshare` continuava
   * false. Agora, quando o servidor não confirma, desfazemos o patch local (a
   * chave volta) e dizemos que não deu — feio, mas é a única coisa verdadeira.
   */
  async function toggleAutoshare(on: boolean) {
    if (!profile?.id) return;
    if (autoshareWriteRef.current) return;
    // Ligar sem nenhum contato cadastrado não faz sentido — orienta a cadastrar.
    if (on && contacts.length === 0) {
      Alert.alert(t('trustedContacts.autoTitle'), t('trustedContacts.autoNeedContact'));
      return;
    }
    // Ao ligar sem contato escolhido, assume o primeiro da lista por conveniência.
    const nextContactId = on ? (autoContactId ?? contacts[0]?.id ?? null) : autoContactId;
    patchProfile({ trip_autoshare: on, trip_autoshare_contact_id: nextContactId });
    autoshareWriteRef.current = true;
    // `try/finally`: hoje o postgrest-js captura a falha de fetch e resolve com
    // `{ error }` em vez de rejeitar, então um `await` cru não deixaria a trava
    // presa. Mas isso é propriedade da biblioteca, não deste código — basta
    // alguém encadear `.throwOnError()` amanhã para a tela travar PARA SEMPRE,
    // sem nenhum sintoma que aponte para cá.
    let error;
    try {
      ({ error } = await supabase
        .from('profiles')
        .update({ trip_autoshare: on, trip_autoshare_contact_id: nextContactId })
        .eq('id', profile.id));
    } finally {
      autoshareWriteRef.current = false;
    }
    if (error) {
      patchProfile({ trip_autoshare: autoshare, trip_autoshare_contact_id: autoContactId });
      // PENDÊNCIA DE PRODUTO: o ideal seria `trustedContacts.autoshareError` =
      // "Não foi possível alterar o compartilhamento automático. Tente de novo."
      // Reusamos `trustedContacts.saveError`, o texto genérico de falha de
      // gravação desta mesma tela — translations.ts está sob edição do dono.
      Alert.alert(t('trustedContacts.alertTitle'), t('trustedContacts.saveError'));
    }
  }

  async function chooseAutoContact(id: string) {
    if (!profile?.id) return;
    if (autoshareWriteRef.current) return;
    patchProfile({ trip_autoshare_contact_id: id });
    autoshareWriteRef.current = true;
    let error;
    try {
      ({ error } = await supabase
        .from('profiles').update({ trip_autoshare_contact_id: id }).eq('id', profile.id));
    } finally {
      autoshareWriteRef.current = false;
    }
    // Mesmo problema do toggle: a bolinha do rádio pulava para o novo contato
    // mesmo quando a gravação falhava, e a viagem seguiria sendo compartilhada
    // com o contato ANTERIOR (ou com ninguém).
    if (error) {
      patchProfile({ trip_autoshare_contact_id: autoContactId });
      Alert.alert(t('trustedContacts.alertTitle'), t('trustedContacts.saveError'));
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <BackButton onPress={() => navigation.goBack()} />

        <Text style={styles.title}>{t('trustedContacts.title')}</Text>
        <Text style={styles.subtitle}>{t('trustedContacts.subtitle')}</Text>

        {/* ── Auto-compartilhar ─────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{t('trustedContacts.autoTitle')}</Text>
              <Text style={styles.rowDesc}>{t('trustedContacts.autoDesc')}</Text>
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
              <Text style={styles.chooseLabel}>{t('trustedContacts.sendTo')}</Text>
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
        <Text style={styles.sectionLabel}>{t('trustedContacts.yourContacts')}</Text>
        <View style={styles.card}>
          {loading ? (
            <Text style={styles.empty}>{t('trustedContacts.loading')}</Text>
          ) : contacts.length === 0 ? (
            // Falha de leitura mostrava exatamente o mesmo texto de "você ainda
            // não cadastrou ninguém" — ver `loadFailed` em useTrustedContacts.
            // PENDÊNCIA DE PRODUTO: falta `trustedContacts.loadError` = "Não foi
            // possível carregar seus contatos." Reusamos `trustedContacts.saveError`
            // (falha genérica desta tela) porque translations.ts é do dono.
            <Text style={styles.empty}>
              {loadFailed ? t('trustedContacts.saveError') : t('trustedContacts.empty')}
            </Text>
          ) : (
            contacts.map((c, i) => (
              <View key={c.id} style={[styles.row, i < contacts.length - 1 && styles.rowBorder]}>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{c.name}</Text>
                  {!!c.contact && <Text style={styles.rowDesc}>{c.contact}</Text>}
                </View>
                <TouchableOpacity onPress={() => handleRemove(c.id, c.name)}>
                  <Text style={styles.removeText}>{t('trustedContacts.remove')}</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* ── Adicionar ─────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>{t('trustedContacts.addSection')}</Text>
        <View style={styles.card}>
          <View style={styles.formPad}>
            <Input
              label={t('trustedContacts.nameLabel')}
              placeholder={t('trustedContacts.namePh')}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
            />
            <Input
              label={t('trustedContacts.labelLabel')}
              placeholder={t('trustedContacts.labelPh')}
              value={label}
              onChangeText={setLabel}
              autoCapitalize="none"
            />
            <Button title={t('trustedContacts.addBtn')} onPress={handleAdd} loading={saving} />
          </View>
        </View>

        <Text style={styles.note}>{t('trustedContacts.note')}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 24 },
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
