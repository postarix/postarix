'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { useSession } from '@/lib/auth-client';
import { isSuperAdmin } from '@/lib/queries';

/** Every System page is for instance administrators only (the API checks it too). */
export default function SystemLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: session } = useSession();
  const allowed = isSuperAdmin(session?.user.role);
  useEffect(() => {
    if (session && !allowed) router.replace('/');
  }, [session, allowed, router]);
  return allowed ? <>{children}</> : null;
}
