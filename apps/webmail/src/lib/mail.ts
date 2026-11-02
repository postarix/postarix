import type { Email, EmailAddress, Mailbox } from '@postarix/jmap-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { jmap } from './jmap';

export const keys = {
  mailboxes: ['mailboxes'] as const,
  emails: (mailboxId: string, search: string) => ['emails', mailboxId, search] as const,
  allEmails: ['emails'] as const,
  message: (id: string, remoteImages: boolean) => ['message', id, remoteImages] as const,
  identities: ['identities'] as const,
};

const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

export function sortMailboxes(list: Mailbox[]): Mailbox[] {
  const rank = (m: Mailbox) => (m.role && ROLE_ORDER.includes(m.role) ? ROLE_ORDER.indexOf(m.role) : ROLE_ORDER.length);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

export function useMailboxes() {
  return useQuery({
    queryKey: keys.mailboxes,
    queryFn: async () => sortMailboxes((await jmap.call<{ list: Mailbox[] }>('Mailbox/get')).list),
  });
}

export function useMailboxByRole(role: string) {
  const { data } = useMailboxes();
  return data?.find((m) => m.role === role);
}

export const LIST_PROPERTIES = ['threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'preview', 'receivedAt', 'hasAttachment', 'size'];
const PAGE_SIZE = 50;

export interface EmailPage {
  emails: Email[];
  total: number;
  position: number;
}

export function useEmails(mailboxId: string | null, search: string) {
  return useInfiniteQuery({
    queryKey: keys.emails(mailboxId ?? '', search),
    enabled: mailboxId !== null,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<EmailPage> => {
      const accountId = await jmap.accountId();
      const filter: Record<string, unknown> = { inMailbox: mailboxId };
      if (search.trim()) filter.text = search.trim();
      const results = await jmap.batch((b) => {
        const query = b.add('Email/query', {
          accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position: pageParam,
          limit: PAGE_SIZE,
          calculateTotal: true,
        });
        b.add('Email/get', { accountId, '#ids': b.ref(query, 'Email/query', '/ids'), properties: LIST_PROPERTIES });
      });
      const query = results.get('c0') as { total: number; position: number };
      const get = results.get('c1') as { list: Email[] };
      return { emails: get.list, total: query.total, position: query.position };
    },
    getNextPageParam: (last) => {
      const next = last.position + last.emails.length;
      return next < last.total && last.emails.length > 0 ? next : undefined;
    },
  });
}

export interface RenderedMessage {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  subject: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  sentAt: string | null;
  receivedAt: string;
  messageId: string[];
  references: string[];
  html: string;
  text: string;
  truncated: boolean;
  blockedImages: number;
  attachments: { blobId: string; name: string; type: string; size: number }[];
}

export function useMessage(id: string | null, remoteImages: boolean) {
  return useQuery({
    queryKey: keys.message(id ?? '', remoteImages),
    enabled: id !== null,
    queryFn: () => api<RenderedMessage>(`/mail/messages/${encodeURIComponent(id!)}${remoteImages ? '?remoteImages=1' : ''}`),
    staleTime: 5 * 60_000,
  });
}

export function useIdentities() {
  return useQuery({
    queryKey: keys.identities,
    queryFn: () => api<{ address: string; addresses: string[] }>('/mail/identities'),
    staleTime: 10 * 60_000,
  });
}

/** Changes to one or more messages (keywords, folders, deletion), then refreshes the lists. */
export function useUpdateEmails() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { update?: Record<string, Record<string, unknown>>; destroy?: string[] }) => {
      const result = await jmap.call<{ notUpdated?: Record<string, { type: string }> | null; notDestroyed?: Record<string, { type: string }> | null }>(
        'Email/set',
        { ...(args.update ? { update: args.update } : {}), ...(args.destroy ? { destroy: args.destroy } : {}) },
      );
      const failure = Object.values(result.notUpdated ?? {})[0] ?? Object.values(result.notDestroyed ?? {})[0];
      if (failure) throw new Error(`The mail server refused the change (${failure.type})`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.allEmails });
      void queryClient.invalidateQueries({ queryKey: keys.mailboxes });
      void queryClient.invalidateQueries({ queryKey: ['message'] });
    },
  });
}
