import React from 'react';
import { View, TextInput, Text, StyleSheet, TextInputProps } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export function Input({ label, error, style, ...props }: InputProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  return (
    <View style={styles.wrapper}>
      {label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        style={[styles.input, error && styles.inputError, style]}
        placeholderTextColor={colors.gray[400]}
        {...props}
      />
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    wrapper: { marginBottom: 16 },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.gray[500],
      marginBottom: 6,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    input: {
      height: 52,
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      paddingHorizontal: 16,
      fontSize: 15,
      color: colors.text,
      borderWidth: 1.5,
      borderColor: colors.gray[200],
    },
    inputError: {
      borderColor: colors.error,
    },
    error: {
      fontSize: 12,
      color: colors.error,
      marginTop: 4,
    },
  });
}
