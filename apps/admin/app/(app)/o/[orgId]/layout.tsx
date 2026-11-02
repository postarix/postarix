'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { cn } from '@postarix/ui/lib/utils';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Notice } from '@/components/notice';
import { errorMessage } from '@/lib/api';
import { useOrganization } from '@/lib/queries';

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const org = useOrganization(orgId);

  if (org.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-9 w-full max-w-xl" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (org.error || !org.data) return <Notice>{errorMessage(org.error ?? new Error('Organization not found'))}</Notice>;

  const isAdmin = org.data.role === 'owner' || org.data.role === 'admin';
  const base = `/o/${orgId}`;
  const tabs = [
    { href: base, label: 'Overview' },
    ...(isAdmin
      ? [
          { href: `${base}/domains`, label: 'Domains' },
          { href: `${base}/mailboxes`, label: 'Mailboxes' },
          { href: `${base}/aliases`, label: 'Aliases' },
          { href: `${base}/members`, label: 'Members' },
          { href: `${base}/activity`, label: 'Activity' },
        ]
      : []),
  ];

  return (
    <div>
      <p className="text-sm text-muted-foreground">Organization</p>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">{org.data.name}</h1>
        {org.data.viaSuperAdmin ? <Badge variant="warning">Instance administrator access</Badge> : null}
      </div>
      {/* Each section is its own page; the active one is underlined. */}
      <nav aria-label="Organization sections" className="mt-5 mb-8 flex max-w-full gap-6 overflow-x-auto border-b">
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative -mb-px border-b-2 pt-1 pb-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                'focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
