import { useColorScheme } from 'react-native';
import { LightTheme, DarkTheme, AppTheme } from '../constants/theme';

export function useTheme(): { colors: AppTheme; isDark: boolean } {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  return { colors: isDark ? DarkTheme : LightTheme, isDark };
}
