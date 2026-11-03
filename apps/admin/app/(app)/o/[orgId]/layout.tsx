'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Notice } from '@/components/notice';
import { errorMessage } from '@/lib/api';
import { useOrganization } from '@/lib/queries';
import { t } from '@/lib/i18n';

export default function OrganizationLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
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

  // The sections are in the sidebar; the breadcrumb names the organization.
  return (
    <div>
      {org.data.viaSuperAdmin ? (
        <div className="mb-4">
          <Badge variant="warning">{t('Instance administrator access')}</Badge>
        </div>
      ) : null}
      {children}
    </div>
  );
}
