'use client';

import { Card } from '@postarix/ui';
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
    { key: 'domains', label: 'Domains', icon: Globe, href: 'domains' },
    { key: 'mailboxes', label: 'Mailboxes', icon: Inbox, href: 'mailboxes' },
    { key: 'aliases', label: 'Aliases', icon: AtSign, href: 'aliases' },
    { key: 'members', label: 'Members', icon: Users, href: 'members' },
  ] as const;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map(({ key, label, icon: Icon, href }) => {
        const content = (
          <Card className="p-5">
            <div className="flex items-center justify-between text-ink-muted">
              <span className="text-sm">{label}</span>
              <Icon className="size-4" aria-hidden />
            </div>
            <p className="mt-2 text-3xl font-semibold">{org.counts[key]}</p>
          </Card>
        );
        return isAdmin ? (
          <Link key={key} href={`/o/${orgId}/${href}`} className="transition-opacity hover:opacity-90">
            {content}
          </Link>
        ) : (
          <div key={key}>{content}</div>
        );
      })}
    </div>
  );
}
