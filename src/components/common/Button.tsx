import React from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

export function Button({ title, onPress, variant = 'primary', loading, disabled, style, textStyle }: ButtonProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <TouchableOpacity
      style={[styles.base, styles[variant], disabled && styles.disabled, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.primary : colors.accent} />
      ) : (
        <Text style={[styles.text, styles[`${variant}Text`], textStyle]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    base: {
      height: 54,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    primary: {
      backgroundColor: colors.accent,
    },
    secondary: {
      backgroundColor: colors.primary,
    },
    outline: {
      backgroundColor: colors.transparent,
      borderWidth: 1.5,
      borderColor: colors.accent,
    },
    ghost: {
      backgroundColor: colors.transparent,
    },
    disabled: {
      opacity: 0.45,
    },
    text: {
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    primaryText: { color: colors.primary },
    secondaryText: { color: colors.white },
    outlineText: { color: colors.accent },
    ghostText: { color: colors.gray[500] },
  });
}
