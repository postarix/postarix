'use client';

import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { CreateOrganizationDialog } from '@/components/create-organization';
import { PageHeader } from '@/components/page-header';
import { useSession } from '@/lib/auth-client';
import { isSuperAdmin, useAllOrganizations, useMyOrganizations } from '@/lib/queries';
import { t } from '@/lib/i18n';

/** Every organization (instance administrators) or the ones you belong to. */
export function OrganizationsList() {
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
