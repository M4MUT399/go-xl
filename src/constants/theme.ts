export interface AppTheme {
  // Fundos
  background: string;
  backgroundSecondary: string;
  surface: string;
  card: string;
  // Textos
  text: string;
  textSecondary: string;
  textMuted: string;
  // Bordas e divisores
  border: string;
  divider: string;
  // Marca (igual nos dois temas)
  primary: string;
  primaryLight: string;
  accent: string;
  accentLight: string;
  // Status (igual nos dois temas)
  success: string;
  warning: string;
  error: string;
  // Utilitários
  white: string;
  black: string;
  transparent: string;
  mapOverlay: string;
  // Escala de cinza semântica
  gray: {
    100: string; 200: string; 300: string; 400: string;
    500: string; 600: string; 700: string; 800: string; 900: string;
  };
}

export const LightTheme: AppTheme = {
  background: '#FFFFFF',
  backgroundSecondary: '#F8F8F8',
  surface: '#F0F2F5',
  card: '#FFFFFF',
  text: '#1A1A2E',
  textSecondary: '#404040',
  textMuted: '#737373',
  border: '#E5E7EB',
  divider: '#EBEBEB',
  primary: '#1A1A2E',
  primaryLight: '#16213E',
  accent: '#C9A84C',
  accentLight: '#E8C96A',
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#EF4444',
  white: '#FFFFFF',
  black: '#0A0A0A',
  transparent: 'transparent',
  mapOverlay: 'rgba(26,26,46,0.85)',
  gray: {
    100: '#F5F5F5', 200: '#EBEBEB', 300: '#D4D4D4', 400: '#ADADAD',
    500: '#737373', 600: '#525252', 700: '#404040', 800: '#262626', 900: '#171717',
  },
};

export const DarkTheme: AppTheme = {
  background: '#1A1A2E',
  backgroundSecondary: '#16213E',
  surface: '#0F1825',
  card: '#1E2440',
  text: '#F0F0F0',
  textSecondary: '#D4D4D4',
  textMuted: '#ADADAD',
  border: '#2A2D4A',
  divider: '#2A2D4A',
  primary: '#1A1A2E',
  primaryLight: '#16213E',
  accent: '#C9A84C',
  accentLight: '#E8C96A',
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#EF4444',
  white: '#FFFFFF',
  black: '#0A0A0A',
  transparent: 'transparent',
  mapOverlay: 'rgba(10,10,20,0.90)',
  gray: {
    100: '#1E2132', 200: '#252840', 300: '#3A3D5C', 400: '#5A5D7A',
    500: '#7A7D9A', 600: '#9A9DB8', 700: '#BABDD4', 800: '#DADDEF', 900: '#F0F2FF',
  },
};
