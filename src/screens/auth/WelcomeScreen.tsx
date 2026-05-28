import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, Image, Dimensions } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Button } from '../../components/common/Button';
import { Colors } from '../../constants/colors';

const { height } = Dimensions.get('window');

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Welcome'> };

export function WelcomeScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.hero}>
        <View style={styles.logoContainer}>
          <Text style={styles.logoText}>GO</Text>
          <Text style={styles.logoXL}>XL</Text>
        </View>
        <Text style={styles.tagline}>Transporte executivo{'\n'}de alto padrão</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>✦ Executive XL</Text>
        </View>
      </View>

      <View style={styles.footer}>
        <Button
          title="Entrar"
          onPress={() => navigation.navigate('Login')}
          variant="primary"
          style={styles.btn}
        />
        <Button
          title="Sou motorista parceiro"
          onPress={() => navigation.navigate('Register', { type: 'driver' })}
          variant="outline"
          style={styles.btn}
        />
        <Text style={styles.terms}>
          Ao continuar, você aceita nossos{' '}
          <Text style={styles.link}>Termos de Uso</Text> e{' '}
          <Text style={styles.link}>Política de Privacidade</Text>
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.primary,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 24,
  },
  logoText: {
    fontSize: 72,
    fontWeight: '900',
    color: Colors.white,
    letterSpacing: -2,
  },
  logoXL: {
    fontSize: 72,
    fontWeight: '900',
    color: Colors.accent,
    letterSpacing: -2,
  },
  tagline: {
    fontSize: 22,
    color: Colors.gray[300],
    textAlign: 'center',
    lineHeight: 32,
    marginBottom: 20,
  },
  badge: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  badgeText: {
    color: Colors.accent,
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
  terms: {
    fontSize: 12,
    color: Colors.gray[500],
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  link: {
    color: Colors.accent,
  },
});
