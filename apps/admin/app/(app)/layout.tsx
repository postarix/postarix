'use client';

import { Button, Spinner, cn } from '@postarix/ui';
import { Building2, LogOut, Mail, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { authClient, useSession } from '@/lib/auth-client';
import { isSuperAdmin, useAllOrganizations, useMyOrganizations } from '@/lib/queries';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const superAdmin = isSuperAdmin(session?.user.role);
  const mine = useMyOrganizations();
  const all = useAllOrganizations(superAdmin);

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);

  if (isPending || !session) {
    return (
      <div className="grid min-h-screen place-items-center text-ink-muted">
        <Spinner />
      </div>
    );
  }

  const orgs = superAdmin ? (all.data ?? []) : (mine.data ?? []);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <Link href="/" className="flex items-center gap-2.5 px-5 py-5">
          <span className="grid size-8 place-items-center rounded-lg bg-accent text-white">
            <Mail className="size-4" aria-hidden />
          </span>
          <span className="font-semibold">Postarix</span>
          {superAdmin ? (
            <span className="ml-auto rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-strong">
              Admin
            </span>
          ) : null}
        </Link>

        <nav aria-label="Organizations" className="flex-1 overflow-y-auto px-3">
          <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-ink-muted">Organizations</p>
          <ul className="space-y-0.5">
            {orgs.map((org) => {
              const active = pathname.startsWith(`/o/${org.id}`);
              return (
                <li key={org.id}>
                  <Link
                    href={`/o/${org.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                      active ? 'bg-accent-soft font-medium text-accent-strong' : 'text-ink hover:bg-surface-muted',
                    )}
                  >
                    <Building2 className="size-4 shrink-0 opacity-70" aria-hidden />
                    <span className="truncate">{org.name}</span>
                  </Link>
                </li>
              );
            })}
            {orgs.length === 0 && !mine.isLoading ? (
              <li className="px-2 py-1.5 text-sm text-ink-muted">No organizations yet</li>
            ) : null}
          </ul>
        </nav>

        <div className="border-t border-border p-3">
          <Link
            href="/account"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink hover:bg-surface-muted"
          >
            <UserRound className="size-4 opacity-70" aria-hidden />
            <span className="truncate">{session.user.email}</span>
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={async () => {
              await authClient.signOut();
              router.replace('/login');
            }}
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-5 py-8 md:px-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
