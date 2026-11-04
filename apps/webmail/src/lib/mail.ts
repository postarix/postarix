import type { Email, EmailAddress, Mailbox } from '@postarix/jmap-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { jmap } from './jmap';

export const keys = {
  mailboxes: ['mailboxes'] as const,
  emails: (mailboxId: string, search: string, label = '') => ['emails', mailboxId, search, label] as const,
  thread: (threadId: string) => ['emails', 'thread', threadId] as const,
  labels: ['labels'] as const,
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
  /** Messages in each listed message's conversation. */
  threadSizes: Record<string, number>;
  total: number;
  position: number;
}

/**
 * One page of a folder (or of a label, across folders but Trash and Junk),
 * one row per conversation: the newest message of each.
 */
export function useEmails(mailboxId: string | null, search: string, label?: { keyword: string; exclude: string[] } | null) {
  return useInfiniteQuery({
    queryKey: keys.emails(mailboxId ?? '', search, label?.keyword ?? ''),
    enabled: mailboxId !== null || Boolean(label),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<EmailPage> => {
      const accountId = await jmap.accountId();
      const filter: Record<string, unknown> = label
        ? { hasKeyword: label.keyword, ...(label.exclude.length ? { inMailboxOtherThan: label.exclude } : {}) }
        : { inMailbox: mailboxId };
      if (search.trim()) filter.text = search.trim();
      const results = await jmap.batch((b) => {
        const query = b.add('Email/query', {
          accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          collapseThreads: true,
          position: pageParam,
          limit: PAGE_SIZE,
          calculateTotal: true,
        });
        const get = b.add('Email/get', { accountId, '#ids': b.ref(query, 'Email/query', '/ids'), properties: LIST_PROPERTIES });
        b.add('Thread/get', { accountId, '#ids': b.ref(get, 'Email/get', '/list/*/threadId') });
      });
      const query = results.get('c0') as { total: number; position: number };
      const get = results.get('c1') as { list: Email[] };
      const threads = results.get('c2') as { list: { id: string; emailIds: string[] }[] } | undefined;
      const threadSizes = Object.fromEntries((threads?.list ?? []).map((t) => [t.id, t.emailIds.length]));
      return { emails: get.list, threadSizes, total: query.total, position: query.position };
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
  /** The message carries calendar data (see useInvitation). */
  calendar: boolean;
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
    queryFn: () => api<{ address: string; name?: string; addresses: string[] }>('/mail/identities'),
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

export interface ThreadMessage {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from: EmailAddress[] | null;
  receivedAt: string;
  preview: string;
}

/** The messages of a conversation, oldest first (drafts left out). */
export function useThread(threadId: string | null) {
  return useQuery({
    queryKey: keys.thread(threadId ?? ''),
    enabled: threadId !== null,
    queryFn: async () => {
      const accountId = await jmap.accountId();
      const results = await jmap.batch((b) => {
        const thread = b.add('Thread/get', { accountId, ids: [threadId] });
        b.add('Email/get', {
          accountId,
          '#ids': b.ref(thread, 'Thread/get', '/list/*/emailIds'),
          properties: ['mailboxIds', 'keywords', 'from', 'receivedAt', 'preview'],
        });
      });
      const list = (results.get('c1') as { list: ThreadMessage[] }).list;
      return list.filter((m) => !m.keywords.$draft).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    },
  });
}

export interface Label {
  id: string;
  name: string;
  keyword: string;
}

export function useLabels() {
  return useQuery({ queryKey: keys.labels, queryFn: async () => (await api<{ data: Label[] }>('/me/labels')).data, staleTime: 60_000 });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<Label>('/me/labels', { method: 'POST', body: { name } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.labels }),
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/me/labels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.labels }),
  });
}
