import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { TrustedContact } from '../types';

/**
 * useTrustedContacts — CRUD dos contatos de confiança do passageiro (Tarefa 1).
 *
 * A tabela trusted_contacts tem RLS `auth.uid() = owner_id`, então o passageiro
 * só enxerga e altera os próprios contatos. O rótulo `contact` (telefone/e-mail)
 * é apenas para reconhecimento na lista — o envio real do link é sempre pelo
 * share sheet nativo, escolhido pelo próprio passageiro.
 */
export function useTrustedContacts(ownerId: string | undefined) {
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!ownerId) {
      setContacts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await supabase
        .from('trusted_contacts')
        .select('id, owner_id, name, contact, created_at')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: true });
      setContacts((data as TrustedContact[]) ?? []);
    } catch {
      /* mantém a lista atual */
    } finally {
      setLoading(false);
    }
  }, [ownerId]);

  useEffect(() => { refresh(); }, [refresh]);

  const addContact = useCallback(
    async (name: string, contact?: string): Promise<boolean> => {
      if (!ownerId) return false;
      const trimmed = name.trim();
      if (!trimmed) return false;
      try {
        const { data, error } = await supabase
          .from('trusted_contacts')
          .insert({ owner_id: ownerId, name: trimmed, contact: contact?.trim() || null })
          .select('id, owner_id, name, contact, created_at')
          .single();
        if (error || !data) return false;
        setContacts((prev) => [...prev, data as TrustedContact]);
        return true;
      } catch {
        return false;
      }
    },
    [ownerId],
  );

  const removeContact = useCallback(
    async (id: string): Promise<boolean> => {
      if (!ownerId) return false;
      try {
        const { error } = await supabase
          .from('trusted_contacts')
          .delete()
          .eq('id', id)
          .eq('owner_id', ownerId);
        if (error) return false;
        setContacts((prev) => prev.filter((c) => c.id !== id));
        return true;
      } catch {
        return false;
      }
    },
    [ownerId],
  );

  return { contacts, loading, refresh, addContact, removeContact };
}
