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

/** A contact, with the account it belongs to: the person's own, or a colleague's who shares their contacts. */
export type AccountContact = Contact & { accountId: string; sharedBy: string | null };

const CONTACT_PROPERTIES = ['firstName', 'lastName', 'company', 'jobTitle', 'nickname', 'notes', 'emails', 'phones', 'addressbookId'];

async function accountContacts(accountId: string): Promise<Contact[]> {
  const results = await jmap.batch((b) => {
    const q = b.add('Contact/query', { accountId, limit: 5000 });
    b.add('Contact/get', { accountId, '#ids': b.ref(q, 'Contact/query', '/ids'), properties: CONTACT_PROPERTIES });
  }, USING_CONTACTS);
  return (results.get('c1') as { list: Contact[] }).list;
}

/**
 * All contacts of the person's address book, then those colleagues share with
 * them (address books stay small enough to load at once). An account shared
 * for its calendar only has no readable contacts and is skipped.
 */
export function useContacts() {
  return useQuery({
    queryKey: contactKeys.all,
    queryFn: async (): Promise<AccountContact[]> => {
      const session = await jmap.session();
      const own = await jmap.accountId();
      const shared = Object.entries(session.accounts).filter(([id, a]) => id !== own && CAPABILITIES.contacts in a.accountCapabilities);
      const lists = await Promise.all([
        accountContacts(own).then((list) => list.map((c) => ({ ...c, accountId: own, sharedBy: null }))),
        ...shared.map(([id, account]) =>
          accountContacts(id)
            .then((list) => list.map((c) => ({ ...c, accountId: id, sharedBy: account.name })))
            .catch(() => [] as AccountContact[]),
        ),
      ]);
      return sortContacts(lists.flat()) as AccountContact[];
    },
    staleTime: 5 * 60_000,
  });
}

export type ContactInput = Pick<Contact, 'firstName' | 'lastName' | 'company' | 'jobTitle' | 'notes' | 'emails' | 'phones'>;

export function useSaveContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accountId, input }: { id: string | null; accountId?: string; input: ContactInput }): Promise<string> => {
      const cleaned = {
        ...input,
        emails: input.emails.filter((e) => e.value.trim()).map((e, i) => ({ ...e, value: e.value.trim(), isDefault: i === 0 })),
        phones: input.phones.filter((p) => p.value.trim()).map((p) => ({ ...p, value: p.value.trim() })),
      };
      const result = await jmap.call<{
        created?: Record<string, { id: string }>;
        notCreated?: Record<string, { type: string; description?: string }>;
        notUpdated?: Record<string, { type: string; description?: string }>;
      }>('Contact/set', { ...(accountId ? { accountId } : {}), ...(id ? { update: { [id]: cleaned } } : { create: { c: cleaned } }) }, USING_CONTACTS);
      const failure = Object.values(result.notCreated ?? {})[0] ?? Object.values(result.notUpdated ?? {})[0];
      if (failure) {
        throw new Error(failure.type === 'forbidden' ? 'You can only read these contacts.' : `Could not save the contact (${failure.description ?? failure.type})`);
      }
      return id ?? result.created!.c!.id;
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: contactKeys.all }),
  });
}

export function useDeleteContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accountId }: { id: string; accountId?: string }) => {
      const result = await jmap.call<{ notDestroyed?: Record<string, { type: string }> }>(
        'Contact/set',
        { ...(accountId ? { accountId } : {}), destroy: [id] },
        USING_CONTACTS,
      );
      const failure = Object.values(result.notDestroyed ?? {})[0];
      if (failure) throw new Error(failure.type === 'forbidden' ? 'You can only read these contacts.' : `Could not delete the contact (${failure.type})`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: contactKeys.all }),
  });
}
