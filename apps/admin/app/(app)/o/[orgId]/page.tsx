'use client';

import { Card, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map(({ key, label, icon: Icon }) => {
        const card = (
          <Card className="h-full gap-2 transition-shadow hover:shadow-md">
            <CardHeader>
              <CardDescription className="flex items-center justify-between">
                {label}
                <Icon className="size-4" aria-hidden />
              </CardDescription>
              <CardTitle className="text-3xl tabular-nums">{org.counts[key]}</CardTitle>
            </CardHeader>
          </Card>
        );
        return isAdmin ? (
          <Link key={key} href={`/o/${orgId}/${key}`} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
            {card}
          </Link>
        ) : (
          <div key={key}>{card}</div>
        );
      })}
    </div>
  );
}
