import { Button } from '@postarix/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@postarix/ui/components/dropdown-menu';
import { Postmark } from '@postarix/ui/components/postmark';
import { cn } from '@postarix/ui/lib/utils';
import { CalendarDays, ChevronsUpDown, Download, Inbox, LogOut, ListFilter, MailCheck, Menu, Settings, UsersRound, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { useRoute } from '@/lib/router';
import { Avatar } from './avatar';
import { FiltersDialog } from './filters-dialog';
import { MailImportDialog } from './mail-import-dialog';
import { MailSettingsDialog } from './mail-settings-dialog';

const APPS = [
  { name: 'mailbox', label: 'Mail', href: '/', icon: Inbox },
  { name: 'calendar', label: 'Calendar', href: '/calendar', icon: CalendarDays },
  { name: 'contacts', label: 'Contacts', href: '/contacts', icon: UsersRound },
] as const;

/**
 * The frame of every screen: a slab of ink on the left with the stamp, the
 * switch between Mail, Calendar and Contacts, the current app's navigation
 * and the account. On small screens it slides in from a top bar.
 */
export function AppShell({ email, name, nav, children }: { email: string; name: string; nav?: ReactNode; children: ReactNode }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const routeKey = JSON.stringify(route);
  useEffect(() => setOpen(false), [routeKey]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  const signOut = async () => {
    await authClient.signOut();
    window.location.assign('/login');
  };

  const sidebar = (
    <div className="flex h-full flex-col gap-5 px-3 pt-4 pb-3">
      <a data-nav href="/" className="flex items-center gap-2.5 rounded-md px-2 py-1 focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none">
        <Postmark className="size-7" />
        <span className="text-[1.05rem] leading-none font-semibold tracking-tight text-white">Postarix</span>
      </a>

      <nav aria-label="Apps" className="grid grid-cols-3 gap-0.5 rounded-lg bg-black/25 p-0.5 shadow-[inset_0_1px_2px_rgb(0_0_0/0.4)] ring-1 ring-white/[0.05]">
        {APPS.map(({ name: app, label, href, icon: Icon }) => {
          const active = route.name === app;
          return (
            <a
              key={app}
              data-nav
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center gap-1 rounded-md py-1.5 text-[0.7rem] font-medium transition-colors',
                'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none',
                active ? 'bg-sidebar-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_1px_3px_rgb(0_0_0/0.4)]' : 'text-sidebar-muted hover:text-white',
              )}
            >
              <Icon className={cn('size-4', active ? 'text-stamp' : 'opacity-80')} aria-hidden />
              {label}
            </a>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1">{nav}</div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
          >
            <Avatar name={name} email={email} className="size-8 rounded-lg" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-white">{name || email}</span>
              <span className="block truncate text-xs text-sidebar-muted">{email}</span>
            </span>
            <ChevronsUpDown className="size-4 text-sidebar-muted" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-60">
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setFiltersOpen(true)}>
            <ListFilter aria-hidden />
            Filters
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
            <MailCheck aria-hidden />
            Automatic reply and forwarding
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>
            <Download aria-hidden />
            Import mail from another account
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="/admin/account">
              <Settings aria-hidden />
              Security and app passwords
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="flex h-full bg-sidebar">
      <aside className="hidden w-60 shrink-0 text-sidebar-foreground md:block">{sidebar}</aside>

      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="relative h-full w-72 max-w-[85vw] bg-sidebar text-sidebar-foreground shadow-2xl">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 bg-sidebar px-2 py-2 text-white md:hidden">
          <Button variant="ghost" size="icon-sm" className="text-white hover:bg-sidebar-accent hover:text-white" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)}>
            {open ? <X aria-hidden /> : <Menu aria-hidden />}
          </Button>
          <Postmark className="size-6" />
          <span className="font-semibold tracking-tight">Postarix</span>
        </header>
        {settingsOpen ? <MailSettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
        {filtersOpen ? <FiltersDialog onClose={() => setFiltersOpen(false)} /> : null}
        {importOpen ? <MailImportDialog onClose={() => setImportOpen(false)} /> : null}
        <main className="min-h-0 flex-1 overflow-hidden bg-card md:my-2 md:mr-2 md:rounded-xl md:shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_8px_30px_rgb(0_0_0/0.25)]">
          {children}
        </main>
      </div>
    </div>
  );
}
