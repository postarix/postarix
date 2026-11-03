'use client';

import { Button } from '@postarix/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@postarix/ui/components/dropdown-menu';
import { Spinner } from '@postarix/ui/components/spinner';
import { cn } from '@postarix/ui/lib/utils';
import { Building2, LogOut, Menu, Server, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { BrandMark } from '@/components/brand';
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
      <div className="grid min-h-screen place-items-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const orgs = superAdmin ? (all.data ?? []) : (mine.data ?? []);
  const signOut = async () => {
    await authClient.signOut();
    // A full page load drops every cached query, so nothing of this session
    // stays in memory for whoever uses the browser next.
    window.location.assign('/admin/login');
  };

  const brand = (
    <Link href="/" className="flex items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none">
      <BrandMark className="size-8" />
      <span className="leading-tight">
        <span className="block text-[0.95rem] font-semibold tracking-tight">Postarix</span>
        <span className="block text-xs text-sidebar-muted">{superAdmin ? 'Instance administration' : 'Administration'}</span>
      </span>
    </Link>
  );

  return (
    <div className="flex h-screen bg-sidebar">
      <aside className="hidden h-screen w-60 shrink-0 flex-col text-sidebar-foreground md:flex">
        <div className="px-5 pt-5 pb-4 text-white">{brand}</div>

        <nav aria-label="Organizations" className="flex-1 overflow-y-auto px-3">
          <p className="px-2 pt-2 pb-1.5 text-xs font-medium text-sidebar-muted">Organizations</p>
          <ul className="space-y-0.5">
            {orgs.map((org) => {
              const active = pathname.startsWith(`/o/${org.id}`);
              return (
                <li key={org.id}>
                  <Link
                    href={`/o/${org.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none',
                      active
                        ? 'bg-sidebar-accent font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_1px_2px_rgb(0_0_0/0.35)]'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white',
                    )}
                  >
                    <Building2 className={cn('size-4 shrink-0', active ? 'text-stamp' : 'text-sidebar-muted')} aria-hidden />
                    <span className="truncate">{org.name}</span>
                  </Link>
                </li>
              );
            })}
            {orgs.length === 0 && !mine.isLoading ? (
              <li className="px-2 py-1.5 text-sm text-sidebar-muted">No organizations yet</li>
            ) : null}
          </ul>
        </nav>

        <div className="p-3">
          {superAdmin ? (
            <Link
              href="/system"
              aria-current={pathname === '/system' ? 'page' : undefined}
              className={cn(
                'mb-1 flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors hover:bg-sidebar-accent/60 hover:text-white',
                pathname === '/system' && 'bg-sidebar-accent font-medium text-white',
              )}
            >
              <Server className="size-4 text-sidebar-muted" aria-hidden />
              System
            </Link>
          ) : null}
          <Link
            href="/account"
            aria-current={pathname === '/account' ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors hover:bg-sidebar-accent/60 hover:text-white',
              pathname === '/account' && 'bg-sidebar-accent font-medium text-white',
            )}
          >
            <UserRound className="size-4 text-sidebar-muted" aria-hidden />
            <span className="truncate">{session.user.email}</span>
          </Link>
          <Button variant="ghost" size="sm" className="mt-1 w-full justify-start text-sidebar-foreground/85 hover:bg-sidebar-accent/50 hover:text-white" onClick={signOut}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        {/* Small screens: the sidebar becomes a menu. */}
        <header className="sticky top-0 z-10 flex items-center justify-between bg-sidebar px-4 py-3 text-white md:hidden">
          {brand}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="text-white hover:bg-sidebar-accent hover:text-white" aria-label="Open menu">
                <Menu aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {orgs.map((org) => (
                <DropdownMenuItem key={org.id} asChild>
                  <Link href={`/o/${org.id}`}>
                    <Building2 aria-hidden />
                    <span className="truncate">{org.name}</span>
                  </Link>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {superAdmin ? (
                <DropdownMenuItem asChild>
                  <Link href="/system">
                    <Server aria-hidden />
                    System
                  </Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <Link href="/account">
                  <UserRound aria-hidden />
                  Your account
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={signOut}>
                <LogOut aria-hidden />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto bg-background px-4 py-8 md:rounded-xl md:px-10 md:shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_8px_30px_rgb(0_0_0/0.25)]">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
