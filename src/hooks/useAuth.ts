/**
 * useAuth — atalho para consumir o AuthContext.
 *
 * Mantém a mesma API pública de antes, então nenhum componente
 * precisa mudar suas importações ou chamadas.
 */
import { useAuthContext } from '../contexts/AuthContext';

export function useAuth() {
  return useAuthContext();
}
