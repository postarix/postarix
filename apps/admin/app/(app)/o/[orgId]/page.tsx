'use client';

import { AtSign, Globe, Inbox, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useOrganization } from '@/lib/queries';

export default function OverviewPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const { data: org } = useOrganization(orgId);
  if (!org) return null;
  const isAdmin = org.role === 'owner' || org.role === 'admin';
  const stats = [
    { key: 'domains', label: 'Domains', icon: Globe },
    { key: 'mailboxes', label: 'Mailboxes', icon: Inbox },
    { key: 'aliases', label: 'Aliases', icon: AtSign },
    { key: 'members', label: 'Members', icon: Users },
  ] as const;

  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card lg:grid-cols-4">
      {stats.map(({ key, label, icon: Icon }) => {
        const card = (
          <div className="flex h-full items-center gap-4 p-5 transition-colors hover:bg-accent/40">
            <span className="grid size-10 place-items-center rounded-full bg-stamp-soft text-stamp-foreground dark:text-stamp">
              <Icon className="size-5" aria-hidden />
            </span>
            <span>
              <span className="block font-display text-3xl leading-none font-semibold tabular-nums">{org.counts[key]}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{label}</span>
            </span>
          </div>
        );
        return isAdmin ? (
          <Link key={key} href={`/o/${orgId}/${key}`} className="border-r border-b last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset lg:border-b-0">
            {card}
          </Link>
        ) : (
          <div key={key} className="border-r border-b last:border-r-0 lg:border-b-0">
            {card}
          </div>
        );
      })}
    </div>
  );
}
