import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  FlatList, KeyboardAvoidingView, Platform,
} from 'react-native';
// SafeAreaView do 'react-native' (não deste pacote) é NO-OP no Android — só
// aplica insets no iOS. Isso deixava o header do chat sobrepondo a barra de
// status no Android. O SafeAreaView de react-native-safe-area-context aplica
// os insets corretamente nas duas plataformas.
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList, Message } from '../types';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { useMessages } from '../hooks/useMessages';
import { markChatRead } from '../hooks/useUnreadMessages';
import { activeChatRideId } from '../lib/activeChatRide';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Chat'>;
  route: RouteProp<RootStackParamList, 'Chat'>;
};

export function ChatScreen({ navigation, route }: Props) {
  const { rideId, title } = route.params;
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { messages, sendMessage } = useMessages(rideId, profile?.id);
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<Message>>(null);

  const styles = makeStyles(colors);

  // Marca como lido ao entrar e ao sair. Usa o timestamp da última mensagem
  // (não o relógio do aparelho) para não deixar o badge preso por clock skew.
  const latestTs = messages.length
    ? new Date(messages[messages.length - 1].created_at).getTime()
    : undefined;

  useEffect(() => {
    markChatRead(rideId, latestTs);
    return () => { markChatRead(rideId, latestTs); };
  }, [rideId, latestTs]);

  // Track which chat is active so notifications can suppress banner (keep only sound)
  useFocusEffect(
    React.useCallback(() => {
      activeChatRideId.current = rideId;
      return () => { activeChatRideId.current = null; };
    }, [rideId])
  );

  function handleSend() {
    if (!text.trim()) return;
    sendMessage(text);
    setText('');
  }

  return (
    // `edges={['top']}`: o inset inferior já é aplicado manualmente na
    // inputBar (linha abaixo, considerando o teclado/Android nav bar) — deixar
    // o SafeAreaView aplicar o bottom também duplicaria o espaçamento.
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.headerTitle}>{title}</Text>
          <Text style={styles.headerSub}>Executive XL</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>💬</Text>
              <Text style={styles.emptyText}>Comece a conversa. Suas mensagens são privadas desta corrida.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const mine = item.sender_id === profile?.id;
            return (
              <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowTheirs]}>
                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.text}</Text>
                  <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
                    {new Date(item.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              </View>
            );
          }}
        />

        <View style={[styles.inputBar, { paddingBottom: 10 + (Platform.OS === 'android' ? insets.bottom : 0) }]}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Mensagem..."
            placeholderTextColor={colors.gray[400]}
            multiline
            onSubmitEditing={handleSend}
          />
          <TouchableOpacity style={[styles.sendBtn, !text.trim() && styles.sendBtnDisabled]} onPress={handleSend} disabled={!text.trim()}>
            <Text style={styles.sendBtnText}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.gray[100],
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { fontSize: 24, color: colors.primary },
    headerInfo: { marginLeft: 4 },
    headerTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
    headerSub: { fontSize: 12, color: colors.accent, fontWeight: '600' },
    list: { padding: 16, flexGrow: 1 },
    bubbleRow: { marginBottom: 10, flexDirection: 'row' },
    bubbleRowMine: { justifyContent: 'flex-end' },
    bubbleRowTheirs: { justifyContent: 'flex-start' },
    bubble: { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
    bubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
    bubbleTheirs: { backgroundColor: colors.card, borderBottomLeftRadius: 4 },
    bubbleText: { fontSize: 15, color: colors.gray[800] },
    bubbleTextMine: { color: colors.white },
    bubbleTime: { fontSize: 10, color: colors.gray[400], marginTop: 4, alignSelf: 'flex-end' },
    bubbleTimeMine: { color: 'rgba(255,255,255,0.6)' },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 40 },
    emptyEmoji: { fontSize: 44, marginBottom: 12 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center', lineHeight: 20 },
    inputBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.gray[100],
      gap: 8,
    },
    input: {
      flex: 1,
      backgroundColor: colors.gray[100],
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.text,
      maxHeight: 100,
    },
    sendBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendBtnDisabled: { backgroundColor: colors.gray[300] },
    sendBtnText: { color: colors.primary, fontSize: 20, fontWeight: '900' },
  });
}
