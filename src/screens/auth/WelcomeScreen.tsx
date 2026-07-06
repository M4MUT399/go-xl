import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, Dimensions, Image, TouchableOpacity } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { LanguageSelector } from '../../components/common/LanguageSelector';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';

const { height } = Dimensions.get('window');

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Welcome'> };

export function WelcomeScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.hero}>
        <Image
          source={require('../../../assets/icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.tagline}>{t('welcome.tagline')}</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{t('welcome.badge')}</Text>
        </View>
      </View>

      <View style={styles.footer}>
        <LanguageSelector />
        <Button
          title={t('welcome.createAccount')}
          onPress={() => navigation.navigate('Register', { type: 'passenger' })}
          variant="primary"
          style={styles.btn}
        />
        <Button
          title={t('welcome.signIn')}
          onPress={() => navigation.navigate('Login')}
          variant="outline"
          style={styles.btn}
        />
        <TouchableOpacity
          onPress={() => navigation.navigate('Register', { type: 'driver' })}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.driverLink}>{t('welcome.becomeDriver')}</Text>
        </TouchableOpacity>
        <Text style={styles.terms}>
          {t('welcome.terms')}{' '}
          <Text style={styles.link}>{t('welcome.termsOfUse')}</Text> {t('welcome.and')}{' '}
          <Text style={styles.link}>{t('welcome.privacy')}</Text>
        </Text>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.primary,
    },
    hero: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
    },
    logo: {
      width: 200,
      height: 200,
      borderRadius: 36,
      marginBottom: 24,
    },
    tagline: {
      fontSize: 22,
      color: colors.gray[300],
      textAlign: 'center',
      lineHeight: 32,
      marginBottom: 20,
    },
    badge: {
      backgroundColor: 'rgba(201,168,76,0.15)',
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    badgeText: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '600',
      letterSpacing: 1,
    },
    footer: {
      paddingHorizontal: 24,
      paddingBottom: 32,
      gap: 12,
    },
    btn: {
      width: '100%',
    },
    driverLink: {
      color: colors.accent,
      fontSize: 14,
      fontWeight: '600',
      textAlign: 'center',
      marginTop: 4,
    },
    terms: {
      fontSize: 12,
      color: colors.gray[500],
      textAlign: 'center',
      marginTop: 8,
      lineHeight: 18,
    },
    link: {
      color: colors.accent,
    },
  });
}
