import type { Contact } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { cn } from '@postarix/ui/lib/utils';
import { ArrowLeft, Mail, Pencil, Phone, Search, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Avatar } from '@/components/avatar';
import { ContactDialog } from '@/components/contact-dialog';
import { errorMessage } from '@/lib/api';
import { emptyDraft } from '@/lib/compose';
import { contactName, matchesContact, primaryEmail, useContacts, useDeleteContact } from '@/lib/contacts';
import { navigate } from '@/lib/router';
import { useComposer } from './mail';

const contactPath = (id: string | null, search: string) => `/contacts${id ? `/${encodeURIComponent(id)}` : ''}${search ? `?q=${encodeURIComponent(search)}` : ''}`;

function initialOf(contact: Contact): string {
  const letter = (contact.lastName || contact.firstName || contact.company || primaryEmail(contact) || '#').charAt(0).toLocaleUpperCase();
  return /\p{L}/u.test(letter) ? letter : '#';
}

function ContactDetail({ contact, onEdit, onWrite, onDeleted }: { contact: Contact; onEdit: () => void; onWrite: (email: string) => void; onDeleted: () => void }) {
  const remove = useDeleteContact();
  const [error, setError] = useState<string | null>(null);
  const name = contactName(contact);
  const email = primaryEmail(contact);
  return (
    <article className="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-10" aria-label={name}>
      <Button variant="ghost" size="sm" className="mb-4 lg:hidden" onClick={() => navigate('/contacts')}>
        <ArrowLeft aria-hidden />
        All contacts
      </Button>
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <Avatar name={name} email={email ?? contact.id} className="size-20 text-2xl" />
        <div className="min-w-0 flex-1">
          <h2 className="text-3xl leading-tight font-semibold break-words">{name}</h2>
          {contact.jobTitle || contact.company ? (
            <p className="mt-1 text-muted-foreground">{[contact.jobTitle, contact.company].filter(Boolean).join(', ')}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        {email ? (
          <Button variant="stamp" onClick={() => onWrite(email)}>
            <Mail aria-hidden />
            Write to {contact.firstName || name}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onEdit}>
          <Pencil aria-hidden />
          Edit
        </Button>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={remove.isPending}
          onClick={async () => {
            try {
              await remove.mutateAsync(contact.id);
              onDeleted();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          <Trash2 aria-hidden />
          Delete
        </Button>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}

      <dl className="mt-8 divide-y rounded-xl border bg-card">
        {contact.emails.map((e) => (
          <div key={`e-${e.value}`} className="flex items-center gap-4 px-4 py-3">
            <dt className="w-20 shrink-0 text-sm text-muted-foreground capitalize">{e.label || e.type || 'Email'}</dt>
            <dd className="min-w-0 flex-1 truncate">
              <button type="button" className="truncate text-primary underline-offset-4 hover:underline dark:text-foreground" onClick={() => onWrite(e.value)}>
                {e.value}
              </button>
            </dd>
          </div>
        ))}
        {contact.phones.map((p) => (
          <div key={`p-${p.value}`} className="flex items-center gap-4 px-4 py-3">
            <dt className="w-20 shrink-0 text-sm text-muted-foreground capitalize">{p.label || p.type || 'Phone'}</dt>
            <dd className="min-w-0 flex-1">
              <a href={`tel:${p.value.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-2 underline-offset-4 hover:underline">
                <Phone className="size-3.5 text-muted-foreground" aria-hidden />
                {p.value}
              </a>
            </dd>
          </div>
        ))}
        {contact.notes ? (
          <div className="flex gap-4 px-4 py-3">
            <dt className="w-20 shrink-0 text-sm text-muted-foreground">Notes</dt>
            <dd className="min-w-0 flex-1 text-sm whitespace-pre-wrap">{contact.notes}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

export function ContactsPage({ contactId, search, email, name }: { contactId: string | null; search: string; email: string; name: string }) {
  const contacts = useContacts();
  const composer = useComposer(email);
  const [query, setQuery] = useState(search);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const list = useMemo(() => (contacts.data ?? []).filter((c) => matchesContact(c, query)), [contacts.data, query]);
  const selected = contacts.data?.find((c) => c.id === contactId) ?? null;
  const write = (to: string) => composer.open({ ...emptyDraft(composer.defaultFrom), to: [{ email: to }] });

  const nav = (
    <div className="flex flex-col gap-4">
      <Button variant="stamp" size="lg" className="w-full justify-start" onClick={() => setEditing('new')}>
        <UserPlus aria-hidden />
        New contact
      </Button>
      <p className="px-1 text-sm text-sidebar-muted">
        {contacts.data ? `${contacts.data.length} ${contacts.data.length === 1 ? 'contact' : 'contacts'}` : ' '}
      </p>
      <p className="px-1 text-xs leading-relaxed text-sidebar-muted">
        Your contacts also sync to phones and desktop apps over CardDAV, with an app password.
      </p>
    </div>
  );

  return (
    <AppShell email={email} name={name} nav={nav}>
      <div className="flex h-full min-h-0">
        <section className={cn('flex min-h-0 w-full flex-col border-r lg:w-80 lg:shrink-0', selected && 'max-lg:hidden')} aria-label="Contact list">
          <div className="px-4 pt-4 pb-3">
            <h1 className="mb-3 text-2xl font-semibold">Contacts</h1>
            <div className="relative" role="search">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search contacts"
                aria-label="Search contacts"
                className="h-10 rounded-full border-transparent bg-card pl-9 shadow-[0_1px_2px_rgb(22_33_61/0.06)]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {contacts.isLoading ? (
              <div className="space-y-2 px-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : contacts.error ? (
              <p className="px-4 text-sm text-destructive">{errorMessage(contacts.error)}</p>
            ) : list.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <UsersRound className="mx-auto mb-3 size-10 stroke-[1.25] text-primary/30" aria-hidden />
                <p className="font-display text-lg font-semibold">{query ? 'No one matches' : 'No contacts yet'}</p>
                <p className="mt-1 text-sm text-muted-foreground">{query ? 'Try a name, a company or part of an address.' : 'Add the people you write to most.'}</p>
              </div>
            ) : (
              <ul aria-label="Contacts">
                {list.map((contact, index) => {
                  const letter = initialOf(contact);
                  const showLetter = index === 0 || initialOf(list[index - 1]!) !== letter;
                  const active = contact.id === contactId;
                  const cName = contactName(contact);
                  return (
                    <li key={contact.id}>
                      {showLetter ? <div className="px-4 pt-3 pb-1 font-display text-sm font-semibold text-muted-foreground">{letter}</div> : null}
                      <a
                        data-nav
                        href={contactPath(contact.id, query)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'relative mx-2 flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors',
                          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                          active ? 'bg-stamp-soft' : 'hover:bg-card',
                        )}
                      >
                        {active ? <span className="absolute inset-y-2 left-0 w-1 rounded-full bg-stamp" aria-hidden /> : null}
                        <Avatar name={cName} email={primaryEmail(contact) ?? contact.id} className="size-8" />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{cName}</span>
                          <span className="block truncate text-xs text-muted-foreground">{primaryEmail(contact) ?? contact.company}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
        <section className={cn('min-h-0 min-w-0 flex-1 overflow-y-auto', !selected && 'max-lg:hidden')} aria-label="Contact">
          {selected ? (
            <ContactDetail contact={selected} onEdit={() => setEditing(selected)} onWrite={write} onDeleted={() => navigate(contactPath(null, query))} />
          ) : (
            <div className="grid h-full place-items-center p-8 text-sm text-muted-foreground">Pick a contact to see their details.</div>
          )}
        </section>
      </div>
      {editing ? (
        <ContactDialog
          contact={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            navigate(contactPath(id, query));
          }}
        />
      ) : null}
      {composer.element}
    </AppShell>
  );
}
