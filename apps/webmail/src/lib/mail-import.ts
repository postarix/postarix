import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface MailImport {
  id: string;
  host: string;
  username: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  imported: number;
  skipped: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface MailImportInput {
  host: string;
  security: 'tls' | 'starttls';
  username: string;
  password: string;
}

const key = ['mail-imports'] as const;

/** The person's imports; refreshed every few seconds while one runs. */
export function useMailImports() {
  return useQuery({
    queryKey: key,
    queryFn: async () => (await api<{ data: MailImport[] }>('/me/mail-imports')).data,
    refetchInterval: (query) => (query.state.data?.some((i) => i.status === 'queued' || i.status === 'running') ? 3000 : false),
  });
}

export function useStartMailImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MailImportInput) => api<MailImport>('/me/mail-imports', { method: 'POST', body: input }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useCancelMailImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<MailImport>(`/me/mail-imports/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
}

/** Server settings of well-known providers, filled in from the address. */
export function knownServer(address: string): { host: string; note: string } | null {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { host: 'imap.gmail.com', note: 'Gmail needs an app password (Google account › Security › App passwords).' };
  }
  if (['yahoo.com', 'yahoo.es', 'ymail.com'].includes(domain)) return { host: 'imap.mail.yahoo.com', note: 'Yahoo needs an app password.' };
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return { host: 'imap.mail.me.com', note: 'iCloud needs an app-specific password.' };
  if (domain === 'fastmail.com') return { host: 'imap.fastmail.com', note: 'Fastmail needs an app password.' };
  if (domain === 'gmx.com' || domain === 'gmx.net') return { host: 'imap.gmx.com', note: '' };
  return null;
}
