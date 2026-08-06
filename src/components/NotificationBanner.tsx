import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity, Platform } from 'react-native';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../hooks/useTheme';
import { setNotifyHandler } from '../lib/inAppNotify';

interface BannerData {
  title: string;
  body: string;
}

export function NotificationBanner() {
  const { colors } = useTheme();
  const [data, setData] = useState<BannerData | null>(null);
  const translateY = useRef(new Animated.Value(-160)).current;
  const playerRef = useRef<AudioPlayer | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      playerRef.current = createAudioPlayer(require('../../assets/notification.wav'));
    } catch {
      playerRef.current = null;
    }
    return () => {
      playerRef.current?.remove();
    };
  }, []);

  const hide = useCallback(() => {
    Animated.timing(translateY, { toValue: -160, duration: 250, useNativeDriver: true }).start(() => {
      setData(null);
    });
  }, [translateY]);

  const show = useCallback(
    (title: string, body: string) => {
      setData({ title, body });

      // som
      try {
        playerRef.current?.seekTo(0);
        playerRef.current?.play();
      } catch {
        // ignora
      }
      // vibração
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 8 }).start();

      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(hide, 4000);
    },
    [translateY, hide]
  );

  useEffect(() => {
    setNotifyHandler(show);
    return () => setNotifyHandler(null);
  }, [show]);

  if (!data) return null;

  return (
    <Animated.View style={[styles.container, { transform: [{ translateY }] }]} pointerEvents="box-none">
      <TouchableOpacity activeOpacity={0.9} style={[styles.banner, { backgroundColor: colors.primary }]} onPress={hide}>
        <View style={[styles.iconCircle, { backgroundColor: colors.accent }]}>
          <Text style={styles.icon}>💬</Text>
        </View>
        <View style={styles.textWrap}>
          <Text style={[styles.title, { color: colors.white }]} numberOfLines={1}>{data.title}</Text>
          <Text style={[styles.body, { color: colors.gray[300] }]} numberOfLines={2}>{data.body}</Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 24,
    left: 12,
    right: 12,
    zIndex: 9999,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 10,
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  icon: { fontSize: 20 },
  textWrap: { flex: 1 },
  title: { fontSize: 15, fontWeight: '800' },
  body: { fontSize: 14, marginTop: 2 },
});
