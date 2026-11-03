'use client';

import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { authClient, useSession } from '@/lib/auth-client';
import { isSuperAdmin, keys, useAllOrganizations, useMyOrganizations } from '@/lib/queries';
import { t } from '@/lib/i18n';

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
    <AppDialog open={open} onClose={onClose} title={t('New organization')} description={t('A company, a family or a single person.')}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Name')}>{(props) => <Input {...props} name="name" required maxLength={100} autoFocus />}</FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <LoadingButton type="submit" loading={pending}>{t('Create')}</LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const superAdmin = isSuperAdmin(session?.user.role);
  const mine = useMyOrganizations();
  const all = useAllOrganizations(superAdmin);
  const query = superAdmin ? all : mine;
  const orgs = query.data;
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title={t('Organizations')}
        description={superAdmin ? 'Every organization on this instance.' : 'Organizations you belong to.'}
        actions={
          superAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />{t('New organization')}</Button>
          ) : null
        }
      />
      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : orgs && orgs.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((org) => (
            <Link key={org.id} href={`/o/${org.id}`} className="group rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none">
              <Card className="h-full shadow-xs transition-all group-hover:border-ink/30 group-hover:shadow-md">
                <CardHeader>
                  <CardTitle>{org.name}</CardTitle>
                  <CardDescription>{org.role ? `Your role: ${org.role}` : 'Instance administrator access'}</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl className="flex gap-5 text-sm">
                    {(['domains', 'mailboxes', 'members'] as const).map((key) => (
                      <div key={key} className="flex items-baseline gap-1.5">
                        <dd className="text-xl font-semibold tabular-nums">{org.counts[key]}</dd>
                        <dt className="text-muted-foreground">{org.counts[key] === 1 ? key.replace(/s$/, '') : key}</dt>
                      </div>
                    ))}
                  </dl>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Building2}
          title={t('No organizations yet')}
          description={
            superAdmin
              ? 'Create the first organization to add domains and mailboxes.'
              : 'Ask an administrator to add you to an organization.'
          }
          action={superAdmin ? <Button onClick={() => setCreating(true)}>{t('New organization')}</Button> : null}
        />
      )}
      <CreateOrganizationDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
