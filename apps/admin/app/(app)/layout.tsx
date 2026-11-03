'use client';

import { Button } from '@postarix/ui/components/button';
import { Sheet, SheetContent, SheetTitle } from '@postarix/ui/components/sheet';
import { Spinner } from '@postarix/ui/components/spinner';
import { cn } from '@postarix/ui/lib/utils';
import { ChevronRight, Info, Menu, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { AppSidebar, orgNav, systemNav } from '@/components/app-sidebar';
import { CreateOrganizationDialog } from '@/components/create-organization';
import { authClient, useSession } from '@/lib/auth-client';
import { t } from '@/lib/i18n';
import { isSuperAdmin, useAllOrganizations, useBranding, useMyOrganizations } from '@/lib/queries';
import type { OrganizationSummary } from '@/lib/types';

/** "Organization › Mailboxes", "Server › Logs"… for the top bar. */
function useBreadcrumbs(orgs: OrganizationSummary[]): { label: string; href?: string }[] {
  const pathname = usePathname();
  if (pathname === '/') return [{ label: t('Dashboard') }];
  const org = /^\/o\/([^/]+)/.exec(pathname);
  if (org) {
    const found = orgs.find((o) => o.id === org[1]);
    const crumbs: { label: string; href?: string }[] = [{ label: found?.name ?? t('Organization'), href: `/o/${org[1]}` }];
    const section = orgNav(org[1]!, true)
      .slice(1)
      .find((item) => pathname.startsWith(item.href));
    if (section) crumbs.push({ label: section.label });
    else crumbs[0] = { label: crumbs[0]!.label };
    return crumbs;
  }
  if (pathname.startsWith('/system')) {
    const section = systemNav.find((item) => pathname.startsWith(item.href));
    return [{ label: t('Server'), href: '/system/services' }, ...(section ? [{ label: section.label }] : [])];
  }
  if (pathname.startsWith('/organizations')) return [{ label: t('Organizations') }];
  if (pathname.startsWith('/account')) return [{ label: t('Your account') }];
  return [];
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const superAdmin = isSuperAdmin(session?.user.role);
  const mine = useMyOrganizations();
  const all = useAllOrganizations(superAdmin);
  const branding = useBranding();
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isPending && !session) router.replace('/login');
  }, [isPending, session, router]);
  useEffect(() => setMenuOpen(false), [pathname]);

  const orgs = superAdmin ? (all.data ?? []) : (mine.data ?? []);
  const crumbs = useBreadcrumbs(orgs);

  if (isPending || !session) {
    return (
      <div className="grid min-h-screen place-items-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  const signOut = async () => {
    await authClient.signOut();
    // A full page load drops every cached query, so nothing of this session
    // stays in memory for whoever uses the browser next.
    window.location.assign('/admin/login');
  };

  const sidebar = (onNavigate?: () => void) => (
    <AppSidebar
      orgs={orgs}
      orgsLoading={superAdmin ? all.isLoading : mine.isLoading}
      superAdmin={superAdmin}
      email={session.user.email}
      name={session.user.name}
      productName={branding.data?.productName || t('Postarix')}
      onCreateOrganization={() => setCreating(true)}
      onSignOut={() => void signOut()}
      {...(onNavigate ? { onNavigate } : {})}
    />
  );
  const announcement = branding.data?.announcement;

  return (
    <div className="flex h-screen bg-sidebar">
      <aside className="hidden h-screen w-64 shrink-0 md:block">{sidebar()}</aside>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" showClose={false} className="w-72 border-sidebar-border bg-sidebar p-0">
          <SheetTitle className="sr-only">{t('Menu')}</SheetTitle>
          {sidebar(() => setMenuOpen(false))}
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-xl md:shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_8px_30px_rgb(0_0_0/0.25)]">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/60 px-4 backdrop-blur md:px-8">
            <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t('Open menu')} onClick={() => setMenuOpen(true)}>
              <Menu aria-hidden />
            </Button>
            <nav aria-label={t('Breadcrumb')} className="min-w-0 flex-1">
              <ol className="flex min-w-0 items-center gap-1.5 text-sm">
                {crumbs.map((crumb, i) => (
                  <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
                    {crumb.href && i < crumbs.length - 1 ? (
                      <Link href={crumb.href} className="truncate text-muted-foreground transition-colors hover:text-foreground">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span className={cn('truncate', i === crumbs.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground')} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                        {crumb.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          </header>
          {announcement ? (
            <div role="status" className="flex items-start gap-2 border-b bg-stamp-soft px-4 py-2.5 text-sm md:px-8">
              {branding.data?.announcementLevel === 'info' ? (
                <Info className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
              ) : (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <span>{announcement}</span>
            </div>
          ) : null}
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
      <CreateOrganizationDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
