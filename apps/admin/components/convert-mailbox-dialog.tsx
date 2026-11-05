'use client';

import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { type FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { Mailbox, SharedMember } from '@/lib/types';
import { AppDialog } from './app-dialog';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';
import { PasswordInput } from './password-input';

const RIGHTS: { value: SharedMember['rights']; label: string }[] = [
  { value: 'read', label: t('Read') },
  { value: 'readWrite', label: t('Read and organize') },
  { value: 'send', label: t('Read, organize and send') },
];

/**
 * Turns a mailbox into a shared one (choosing its first members), or a shared
 * one back into a person's. Its mail stays.
 */
export function ConvertMailboxDialog({
  orgId,
  mailbox,
  people,
  onDone,
  onClose,
}: {
  orgId: string;
  mailbox: Mailbox;
  people: Mailbox[];
  onDone: () => void;
  onClose: () => void;
}) {
  const toShared = mailbox.kind !== 'shared';
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState('');
  const [chosen, setChosen] = useState<Record<string, SharedMember['rights']>>({});
  const candidates = people.filter((p) => p.userId && p.userId !== mailbox.userId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.post(
        `/orgs/${orgId}/mailboxes/${mailbox.id}/convert`,
        toShared
          ? {
              to: 'shared',
              sharedSeen: data.get('sharedSeen') !== null,
              members: Object.entries(chosen).map(([userId, rights]) => ({ userId, rights })),
            }
          : { to: 'person', password },
      );
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={toShared ? `${t('Make shared:')} ${mailbox.address}` : `${t('Make personal:')} ${mailbox.address}`}
      description={
        toShared
          ? t('All its mail, folders and read state stay. Nobody signs in as it any more: its password, app passwords and links to other applications are removed, and whoever is signed in to it is signed out everywhere. The people you choose use it from their own mail.')
          : t('All its mail stays. A new account signs in as it with the password you set, and its members lose it at once, even in mail apps already connected.')
      }
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          {toShared ? (
            <>
              <Field>
                <FieldLabel>{t('Members')}</FieldLabel>
                {candidates.length ? (
                  <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                    {candidates.map((p) => {
                      const id = p.userId!;
                      const rights = chosen[id];
                      return (
                        <li key={id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <label className="flex min-w-0 items-center gap-2">
                            <Checkbox
                              checked={rights !== undefined}
                              onCheckedChange={(v) =>
                                setChosen((current) => {
                                  const next = { ...current };
                                  if (v === true) next[id] = 'readWrite';
                                  else delete next[id];
                                  return next;
                                })
                              }
                            />
                            <span className="truncate">{p.displayName ? `${p.displayName} <${p.address}>` : p.address}</span>
                          </label>
                          {rights ? (
                            <FormSelect
                              aria-label={`${t('Rights of')} ${p.address}`}
                              value={rights}
                              onChange={(e) => setChosen((current) => ({ ...current, [id]: e.target.value as SharedMember['rights'] }))}
                            >
                              {RIGHTS.map((r) => (
                                <FormSelectOption key={r.value} value={r.value}>
                                  {r.label}
                                </FormSelectOption>
                              ))}
                            </FormSelect>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  {t('You can change them later with Members. Without members, nobody can use it.')}
                </p>
              </Field>
              <Field orientation="horizontal">
                <Checkbox id="convert-shared-seen" name="sharedSeen" defaultChecked />
                <FieldLabel htmlFor="convert-shared-seen" className="font-normal">
                  {t('One read/unread state for the whole team')}
                </FieldLabel>
              </Field>
            </>
          ) : (
            <FormField label={t('Password')} hint={t('At least 12 characters.')}>
              {(props) => <PasswordInput {...props} value={password} onChange={setPassword} required autoFocus />}
            </FormField>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <LoadingButton type="submit" loading={pending} variant={toShared ? 'destructive' : 'default'}>
              {toShared ? t('Make shared') : t('Make personal')}
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}
