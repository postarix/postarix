'use client';

import { InstanceDashboard } from '@/components/dashboard/instance-dashboard';
import { useSession } from '@/lib/auth-client';
import { isSuperAdmin } from '@/lib/queries';
import { OrganizationsList } from './organizations/list';

export default function HomePage() {
  const { data: session } = useSession();
  return isSuperAdmin(session?.user.role) ? <InstanceDashboard /> : <OrganizationsList />;
}
