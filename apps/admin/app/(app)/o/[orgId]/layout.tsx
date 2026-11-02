'use client';

import { Alert, Spinner, cn } from '@postarix/ui';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { errorMessage } from '@/lib/api';
import { useOrganization } from '@/lib/queries';

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const org = useOrganization(orgId);

  if (org.isLoading) {
    return (
      <div className="grid place-items-center py-20 text-ink-muted">
        <Spinner />
      </div>
    );
  }
  if (org.error || !org.data) return <Alert>{errorMessage(org.error ?? new Error('Organization not found'))}</Alert>;

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
      <p className="mb-1 text-sm text-ink-muted">Organization</p>
      <h1 className="text-2xl font-semibold tracking-tight">{org.data.name}</h1>
      {org.data.viaSuperAdmin ? (
        <p className="mt-1 text-xs text-warning">You are viewing this organization as an instance administrator.</p>
      ) : null}
      <nav aria-label="Organization sections" className="mb-8 mt-5 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((tab) => {
          const active = tab.href === base ? pathname === base : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 text-sm',
                active ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink',
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
