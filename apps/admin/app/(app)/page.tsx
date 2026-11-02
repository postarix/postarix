'use client';

import { Alert, Button, Card, Dialog, EmptyState, Field, Input, PageHeader } from '@postarix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { authClient, useSession } from '@/lib/auth-client';
import { isSuperAdmin, keys, useAllOrganizations, useMyOrganizations } from '@/lib/queries';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function CreateOrganizationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    setPending(true);
    setError(null);
    const { data, error: createError } = await authClient.organization.create({
      name,
      slug: `${slugify(name) || 'org'}-${crypto.randomUUID().slice(0, 6)}`,
      keepCurrentActiveOrganization: true,
    });
    setPending(false);
    if (createError || !data) return setError(createError?.message ?? 'Could not create the organization');
    await queryClient.invalidateQueries({ queryKey: keys.myOrgs });
    await queryClient.invalidateQueries({ queryKey: keys.allOrgs });
    onClose();
    router.push(`/o/${data.id}`);
  }

  return (
    <Dialog open={open} onClose={onClose} title="New organization" description="A company, a family or a single person.">
      <form onSubmit={submit} className="space-y-4">
        {error ? <Alert>{error}</Alert> : null}
        <Field label="Name">{(props) => <Input {...props} name="name" required maxLength={100} autoFocus />}</Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const superAdmin = isSuperAdmin(session?.user.role);
  const mine = useMyOrganizations();
  const all = useAllOrganizations(superAdmin);
  const orgs = superAdmin ? all.data : mine.data;
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Organizations"
        description={superAdmin ? 'Every organization on this instance.' : 'Organizations you belong to.'}
        actions={
          superAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              New organization
            </Button>
          ) : null
        }
      />
      {orgs && orgs.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => (
            <Link key={org.id} href={`/o/${org.id}`} className="group">
              <Card className="h-full p-5 transition-shadow group-hover:shadow-md">
                <p className="font-semibold text-ink">{org.name}</p>
                <p className="text-xs text-ink-muted">{org.role ? `Your role: ${org.role}` : 'Super-admin access'}</p>
                <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
                  {(['domains', 'mailboxes', 'members'] as const).map((key) => (
                    <div key={key} className="rounded-md bg-surface-muted px-2 py-2">
                      <dt className="text-[11px] uppercase tracking-wide text-ink-muted">{key}</dt>
                      <dd className="text-lg font-semibold">{org.counts[key]}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No organizations yet"
            description={
              superAdmin
                ? 'Create the first organization to add domains and mailboxes.'
                : 'Ask an administrator to add you to an organization.'
            }
            action={superAdmin ? <Button onClick={() => setCreating(true)}>New organization</Button> : null}
          />
        </Card>
      )}
      <CreateOrganizationDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
