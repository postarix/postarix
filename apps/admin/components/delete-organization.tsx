'use client';

import { Button } from '@postarix/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@postarix/ui/components/dialog';
import { Input } from '@postarix/ui/components/input';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { keys } from '@/lib/queries';
import type { OrganizationSummary } from '@/lib/types';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';

/**
 * Shown to instance administrators only (the API enforces it too). Deleting
 * needs the organization's name typed out, because it erases every mailbox.
 */
export function DeleteOrganization({ org }: { org: OrganizationSummary }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { counts } = org;

  const close = () => {
    setOpen(false);
    setTyped('');
    setError(null);
  };

  return (
    <section aria-labelledby="danger-zone" className="mt-10 rounded-xl border border-destructive/40 p-5">
      <h3 id="danger-zone" className="font-display text-lg font-semibold">
        Delete this organization
      </h3>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Erases its {counts.mailboxes} {counts.mailboxes === 1 ? 'mailbox' : 'mailboxes'} with all their mail, calendars and
        contacts, {counts.aliases} {counts.aliases === 1 ? 'alias' : 'aliases'}, {counts.domains}{' '}
        {counts.domains === 1 ? 'domain' : 'domains'} and their signing keys. This can’t be undone.
      </p>
      <Button variant="destructive" className="mt-4" onClick={() => setOpen(true)}>
        Delete organization
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setPending(true);
              setError(null);
              try {
                await api.delete(`/admin/organizations/${org.id}`, { confirm: typed });
                await queryClient.invalidateQueries({ queryKey: keys.allOrgs });
                await queryClient.invalidateQueries({ queryKey: keys.myOrgs });
                queryClient.removeQueries({ queryKey: keys.org(org.id) });
                router.replace('/');
              } catch (e) {
                setError(errorMessage(e));
                setPending(false);
              }
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Delete {org.name}?</DialogTitle>
              <DialogDescription>
                Every mailbox and its mail is erased from the mail server, and the people who used them can no longer sign
                in.
              </DialogDescription>
            </DialogHeader>
            <FormField label={`Type “${org.name}” to confirm`}>
              {(props) => (
                <Input {...props} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              )}
            </FormField>
            {error ? <Notice>{error}</Notice> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <LoadingButton type="submit" variant="destructive" loading={pending} disabled={typed !== org.name}>
                Delete organization
              </LoadingButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
