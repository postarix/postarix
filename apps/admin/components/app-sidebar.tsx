'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@postarix/ui/components/dropdown-menu';
import { cn } from '@postarix/ui/lib/utils';
import {
  Activity,
  AtSign,
  Ban,
  Building2,
  ChartColumnBig,
  Check,
  ChevronsUpDown,
  Copy,
  FileKey,
  FileText,
  Filter,
  Forward,
  Gauge,
  Globe,
  Inbox,
  KeyRound,
  Languages,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  type LucideIcon,
  Mail,
  Megaphone,
  Palette,
  Plus,
  Route,
  ScrollText,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldX,
  SquareArrowOutUpRight,
  UserCog,
  UserRound,
  Users,
  Waypoints,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { language, languages, setLanguage, t } from '@/lib/i18n';
import type { OrganizationSummary } from '@/lib/types';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** External page, opened in a new tab. */
  external?: boolean;
}

const LAST_ORG = 'postarix-admin-org';

/** The organization sections; members (not admins) see the overview only. */
export function orgNav(orgId: string, isAdmin: boolean): NavItem[] {
  const base = `/o/${orgId}`;
  const all: NavItem[] = [
    { href: base, label: t('Overview'), icon: LayoutDashboard },
    { href: `${base}/domains`, label: t('Domains'), icon: Globe },
    { href: `${base}/mailboxes`, label: t('Mailboxes'), icon: Inbox },
    { href: `${base}/aliases`, label: t('Aliases'), icon: AtSign },
    { href: `${base}/bcc`, label: t('Copies (BCC)'), icon: Copy },
    { href: `${base}/members`, label: t('Members'), icon: Users },
    { href: `${base}/sso`, label: t('Sign-in'), icon: KeyRound },
    { href: `${base}/mail-log`, label: t('Mail log'), icon: ScrollText },
    { href: `${base}/quarantine`, label: t('Quarantine'), icon: ShieldX },
    { href: `${base}/activity`, label: t('Activity'), icon: Activity },
  ];
  return isAdmin ? all : all.slice(0, 1);
}

/** The instance administrators' pages, in groups. */
export const systemGroups: { label: string; items: NavItem[] }[] = [
  {
    label: t('Server'),
    items: [
      { href: '/system/services', label: t('Services'), icon: Server },
      { href: '/system/logs', label: t('Logs'), icon: FileText },
      { href: '/system/rspamd', label: t('Spam filter history'), icon: ChartColumnBig },
      { href: '/system/queue', label: t('Mail queue'), icon: Mail },
    ],
  },
  {
    label: t('Mail policy'),
    items: [
      { href: '/system/routing', label: t('Outgoing routing'), icon: Route },
      { href: '/system/spam', label: t('Spam filter'), icon: ShieldAlert },
      { href: '/system/filters', label: t('Content filters'), icon: Filter },
      { href: '/system/forwarding-hosts', label: t('Forwarding hosts'), icon: Forward },
      { href: '/system/ip-access', label: t('IP access'), icon: Ban },
      { href: '/system/quarantine', label: t('Quarantine'), icon: ShieldX },
      { href: '/system/dkim', label: t('DKIM keys'), icon: FileKey },
    ],
  },
  {
    label: t('Administration'),
    items: [
      { href: '/system/admins', label: t('Administrators'), icon: UserCog },
      { href: '/system/broadcast', label: t('Mail to everyone'), icon: Megaphone },
      { href: '/system/templates', label: t('Templates'), icon: LayoutTemplate },
      { href: '/system/api-keys', label: t('API keys'), icon: Waypoints },
      { href: '/system/customize', label: t('Customize'), icon: Palette },
      { href: '/system/settings', label: t('Settings'), icon: Settings },
    ],
  },
];

export const systemNav: NavItem[] = systemGroups.flatMap((group) => group.items);

export function appsNav(superAdmin: boolean, links: { name: string; url: string }[] = []): NavItem[] {
  return [
    { href: '/', label: t('Webmail'), icon: Mail, external: true },
    ...(superAdmin ? [{ href: '/api/rspamd-ui/', label: t('Rspamd web interface'), icon: Shield, external: true }] : []),
    ...links.map((link) => ({ href: link.url, label: link.name, icon: SquareArrowOutUpRight, external: true })),
  ];
}

/** The organization in view: the one in the address, else the last one opened, else the first. */
export function useCurrentOrg(orgs: OrganizationSummary[]): OrganizationSummary | undefined {
  const pathname = usePathname();
  const fromPath = /^\/o\/([^/]+)/.exec(pathname)?.[1];
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    try {
      if (fromPath) localStorage.setItem(LAST_ORG, fromPath);
      setLast(fromPath ?? localStorage.getItem(LAST_ORG));
    } catch {
      setLast(fromPath ?? null);
    }
  }, [fromPath]);
  const id = fromPath ?? last;
  return orgs.find((o) => o.id === id) ?? orgs[0];
}

function isActive(pathname: string, item: NavItem, exact: boolean): boolean {
  if (item.external) return false;
  return exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: (() => void) | undefined }) {
  const Icon = item.icon;
  const className = cn(
    'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
    'focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none',
    active
      ? 'bg-sidebar-accent font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.07),0_1px_2px_rgb(0_0_0/0.35)]'
      : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-white',
  );
  const content = (
    <>
      <Icon className={cn('size-4 shrink-0', active ? 'text-stamp' : 'text-sidebar-muted group-hover:text-sidebar-foreground')} aria-hidden />
      <span className="truncate">{item.label}</span>
      {item.external ? <SquareArrowOutUpRight className="ml-auto size-3 shrink-0 text-sidebar-muted" aria-hidden /> : null}
    </>
  );
  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" className={className}>
        {content}
        <span className="sr-only">{t('(opens in a new tab)')}</span>
      </a>
    );
  }
  return (
    <Link href={item.href} aria-current={active ? 'page' : undefined} className={className} onClick={onNavigate}>
      {content}
    </Link>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="px-2.5 pt-4 pb-1.5 text-[0.7rem] font-semibold tracking-wide text-sidebar-muted">{label}</p>
      {children}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

/**
 * The navigation rail: the organization in view (with a switcher), its
 * sections, the server's sections for instance administrators, links to the
 * other apps, and the account menu.
 */
export function AppSidebar({
  orgs,
  orgsLoading,
  superAdmin,
  email,
  name,
  productName,
  logo,
  appLinks,
  onCreateOrganization,
  onSignOut,
  onNavigate,
}: {
  orgs: OrganizationSummary[];
  orgsLoading: boolean;
  superAdmin: boolean;
  email: string;
  name: string;
  productName: string;
  logo?: string | undefined;
  appLinks?: { name: string; url: string }[] | undefined;
  onCreateOrganization: () => void;
  onSignOut: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const current = useCurrentOrg(orgs);
  const currentIsAdmin = current ? superAdmin || current.role === 'owner' || current.role === 'admin' : false;

  return (
    <div className="flex h-full flex-col text-sidebar-foreground">
      <div className="px-4 pt-5 pb-3">
        <Link href="/" onClick={onNavigate} className="flex items-center gap-2.5 rounded-md text-white focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none">
          <BrandMark className="size-8" logo={logo} />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[0.95rem] font-semibold tracking-tight">{productName}</span>
            <span className="block text-xs text-sidebar-muted">{superAdmin ? t('Instance administration') : t('Administration')}</span>
          </span>
        </Link>
      </div>

      {/* Organization switcher */}
      <div className="px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar-accent/40 p-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
              aria-label={t('Switch organization')}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-stamp text-xs font-bold text-stamp-foreground">
                {current ? initials(current.name) : <Building2 className="size-4" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white">{current?.name ?? (orgsLoading ? t('Loading…') : t('No organization'))}</span>
                <span className="block truncate text-xs text-sidebar-muted">
                  {current
                    ? `${current.counts.domains} ${current.counts.domains === 1 ? t('domain') : t('domains')} · ${current.counts.mailboxes} ${current.counts.mailboxes === 1 ? t('mailbox') : t('mailboxes')}`
                    : t('Organizations')}
                </span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-sidebar-muted" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t('Organizations')}</DropdownMenuLabel>
            <div className="max-h-72 overflow-y-auto">
              {orgs.map((org) => (
                <DropdownMenuItem key={org.id} asChild>
                  <Link href={`/o/${org.id}`} onClick={onNavigate}>
                    <span className="grid size-6 shrink-0 place-items-center rounded bg-accent text-[0.65rem] font-bold text-ink">{initials(org.name)}</span>
                    <span className="truncate">{org.name}</span>
                    {org.id === current?.id ? <Check className="ml-auto" aria-hidden /> : null}
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/organizations" onClick={onNavigate}>
                <Building2 aria-hidden />
                {t('All organizations')}
              </Link>
            </DropdownMenuItem>
            {superAdmin ? (
              <DropdownMenuItem onSelect={onCreateOrganization}>
                <Plus aria-hidden />
                {t('New organization')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav aria-label={t('Main')} className="scrollbar-sidebar relative mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="space-y-0.5 pt-3">
          <NavLink item={{ href: '/', label: t('Dashboard'), icon: Gauge }} active={pathname === '/'} onNavigate={onNavigate} />
        </div>
        {current ? (
          <Section label={t('Organization')}>
            {orgNav(current.id, currentIsAdmin).map((item, index) => (
              <NavLink key={item.href} item={item} active={isActive(pathname, item, index === 0)} onNavigate={onNavigate} />
            ))}
          </Section>
        ) : null}
        {superAdmin
          ? systemGroups.map((group) => (
              <Section key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <NavLink key={item.href} item={item} active={isActive(pathname, item, false)} onNavigate={onNavigate} />
                ))}
              </Section>
            ))
          : null}
        <Section label={t('Apps')}>
          {appsNav(superAdmin, appLinks).map((item) => (
            <NavLink key={item.href} item={item} active={false} />
          ))}
        </Section>
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none data-[state=open]:bg-sidebar-accent"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold text-white ring-1 ring-sidebar-border">
                {initials(name || email)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white">{name || email}</span>
                <span className="block truncate text-xs text-sidebar-muted">{email}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-sidebar-muted" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-60">
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account" onClick={onNavigate}>
                <UserRound aria-hidden />
                {t('Your account')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Languages aria-hidden />
                {t('Language')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={language} onValueChange={(v) => setLanguage(v as (typeof languages)[number]['code'])}>
                  {languages.map((l) => (
                    <DropdownMenuRadioItem key={l.code} value={l.code}>
                      {l.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOut aria-hidden />
              {t('Sign out')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
