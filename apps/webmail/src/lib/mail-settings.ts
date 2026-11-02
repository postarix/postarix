import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface MailFilter {
  field: 'from' | 'to' | 'subject';
  contains: string;
  action: 'move' | 'markRead' | 'label' | 'delete';
  folder?: string;
  keyword?: string;
}

export interface MailSettings {
  filters: MailFilter[];
  vacation: { enabled: boolean; subject: string; message: string; until: string | null };
  forwarding: { enabled: boolean; address: string; keepCopy: boolean };
}

export interface MailSettingsState extends MailSettings {
  /** A filter set up in a mail app is active; saving replaces it. */
  otherFiltersActive: boolean;
}

const KEY = ['mail-settings'];

export function useMailSettings(enabled: boolean) {
  return useQuery({ queryKey: KEY, queryFn: () => api<MailSettingsState>('/me/mail-settings'), enabled });
}

export function useSaveMailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: MailSettings) => api<MailSettingsState>('/me/mail-settings', { method: 'PUT', body: settings }),
    onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
  });
}
