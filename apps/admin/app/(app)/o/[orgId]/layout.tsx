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
        <h1 className="text-2xl font-semibold tracking-tight">{org.data.name}</h1>
        {org.data.viaSuperAdmin ? <Badge variant="warning">Instance administrator access</Badge> : null}
      </div>
      {/* Navigation styled like shadcn Tabs: each section is its own page. */}
      <nav
        aria-label="Organization sections"
        className="mt-5 mb-8 inline-flex max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-[3px] text-muted-foreground"
      >
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                active ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground',
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
