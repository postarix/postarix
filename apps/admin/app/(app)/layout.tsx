'use client';

import { Badge } from '@postarix/ui/components/badge';
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
import { Building2, LogOut, Menu, UserRound } from 'lucide-react';
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
    router.replace('/login');
  };

  const brand = (
    <Link href="/" className="flex items-center gap-2.5">
      <BrandMark />
      <span className="font-semibold">Postarix</span>
      {superAdmin ? (
        <Badge variant="secondary" className="ml-1 uppercase">
          Admin
        </Badge>
      ) : null}
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <div className="px-5 py-5">{brand}</div>

        <nav aria-label="Organizations" className="flex-1 overflow-y-auto px-3">
          <p className="px-2 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Organizations</p>
          <ul className="space-y-0.5">
            {orgs.map((org) => {
              const active = pathname.startsWith(`/o/${org.id}`);
              return (
                <li key={org.id}>
                  <Link
                    href={`/o/${org.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                        : 'hover:bg-sidebar-accent/60',
                    )}
                  >
                    <Building2 className="size-4 shrink-0 opacity-70" aria-hidden />
                    <span className="truncate">{org.name}</span>
                  </Link>
                </li>
              );
            })}
            {orgs.length === 0 && !mine.isLoading ? (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">No organizations yet</li>
            ) : null}
          </ul>
        </nav>

        <div className="border-t p-3">
          <Link
            href="/account"
            aria-current={pathname === '/account' ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent/60',
              pathname === '/account' && 'bg-sidebar-accent font-medium',
            )}
          >
            <UserRound className="size-4 opacity-70" aria-hidden />
            <span className="truncate">{session.user.email}</span>
          </Link>
          <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={signOut}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Small screens: the sidebar becomes a menu. */}
        <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur md:hidden">
          {brand}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open menu">
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

        <main className="min-w-0 flex-1 px-4 py-8 md:px-10">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
