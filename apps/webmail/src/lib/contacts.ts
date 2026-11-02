import { CAPABILITIES, type Contact } from '@postarix/jmap-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jmap } from './jmap';

export const USING_CONTACTS = [CAPABILITIES.core, CAPABILITIES.contacts];
export const contactKeys = { all: ['contacts'] as const };

export function contactName(contact: Pick<Contact, 'firstName' | 'lastName' | 'company' | 'emails'>): string {
  const full = `${contact.firstName} ${contact.lastName}`.trim();
  return full || contact.company || contact.emails[0]?.value || 'Unnamed contact';
}

export function primaryEmail(contact: Pick<Contact, 'emails'>): string | undefined {
  return (contact.emails.find((e) => e.isDefault) ?? contact.emails[0])?.value;
}

/** Sorted by last name, then first name (people), or company/email otherwise. */
export function sortContacts(list: Contact[]): Contact[] {
  const key = (c: Contact) => (c.lastName || c.firstName || c.company || primaryEmail(c) || '').toLocaleLowerCase();
  return [...list].sort((a, b) => key(a).localeCompare(key(b)) || contactName(a).localeCompare(contactName(b)));
}

export function matchesContact(contact: Contact, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return [contact.firstName, contact.lastName, contact.company, contact.nickname, ...contact.emails.map((e) => e.value), ...contact.phones.map((p) => p.value)]
    .some((value) => value?.toLocaleLowerCase().includes(q));
}

/** All contacts of the user's address books (personal address books stay small enough to load at once). */
export function useContacts() {
  return useQuery({
    queryKey: contactKeys.all,
    queryFn: async () => {
      const accountId = await jmap.accountId();
      const results = await jmap.batch((b) => {
        const q = b.add('Contact/query', { accountId, limit: 5000 });
        b.add('Contact/get', {
          accountId,
          '#ids': b.ref(q, 'Contact/query', '/ids'),
          properties: ['firstName', 'lastName', 'company', 'jobTitle', 'nickname', 'notes', 'emails', 'phones', 'addressbookId'],
        });
      }, USING_CONTACTS);
      return sortContacts((results.get('c1') as { list: Contact[] }).list);
    },
    staleTime: 5 * 60_000,
  });
}

export type ContactInput = Pick<Contact, 'firstName' | 'lastName' | 'company' | 'jobTitle' | 'notes' | 'emails' | 'phones'>;

export function useSaveContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string | null; input: ContactInput }): Promise<string> => {
      const cleaned = {
        ...input,
        emails: input.emails.filter((e) => e.value.trim()).map((e, i) => ({ ...e, value: e.value.trim(), isDefault: i === 0 })),
        phones: input.phones.filter((p) => p.value.trim()).map((p) => ({ ...p, value: p.value.trim() })),
      };
      const result = await jmap.call<{
        created?: Record<string, { id: string }>;
        notCreated?: Record<string, { type: string; description?: string }>;
        notUpdated?: Record<string, { type: string; description?: string }>;
      }>('Contact/set', id ? { update: { [id]: cleaned } } : { create: { c: cleaned } }, USING_CONTACTS);
      const failure = Object.values(result.notCreated ?? {})[0] ?? Object.values(result.notUpdated ?? {})[0];
      if (failure) throw new Error(`Could not save the contact (${failure.description ?? failure.type})`);
      return id ?? result.created!.c!.id;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: contactKeys.all }),
  });
}

export function useDeleteContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await jmap.call<{ notDestroyed?: Record<string, { type: string }> }>('Contact/set', { destroy: [id] }, USING_CONTACTS);
      const failure = Object.values(result.notDestroyed ?? {})[0];
      if (failure) throw new Error(`Could not delete the contact (${failure.type})`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: contactKeys.all }),
  });
}
