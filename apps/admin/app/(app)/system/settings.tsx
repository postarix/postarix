'use client';

import { Button } from '@postarix/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Textarea } from '@postarix/ui/components/textarea';
import { cn } from '@postarix/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

export interface InstanceSettings {
  signIn: { maxFailures: number; lockMinutes: number };
  passwords: { minLength: number; requireMixed: boolean };
  impersonation: { allowOrgAdmins: boolean };
  quota: { warnAtPercent: number; sender: string; subject: string; template: string };
  quarantine: {
    retentionDays: number | null;
    maxBytes: number;
    notifyMaxScore: number | null;
    redirectTo: string;
    bccTo: string;
    sender: string;
    subject: string;
    releaseFormat: 'original' | 'attachment';
    excludedDomains: string[];
  };
  branding: {
    productName: string;
    loginMessage: string;
    announcement: string;
    announcementLevel: 'info' | 'important' | 'urgent';
    supportUrl: string;
    footer: string;
    logo: string;
    appLinks: { name: string; url: string }[];
    hidePasswordSignIn: boolean;
  };
}

type Change = { [K in keyof InstanceSettings]?: Partial<InstanceSettings[K]> };

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="gap-5">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>{children}</FieldGroup>
      </CardContent>
    </Card>
  );
}

const int = (data: FormData, name: string) => Number(String(data.get(name) ?? '').trim());
const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
/** Empty: null. */
const optionalNumber = (data: FormData, name: string) => (text(data, name) === '' ? null : Number(text(data, name)));

/** Loads the settings and saves the part `build` returns from the form. */
function SettingsForm({ build, children }: { build: (data: FormData) => Change; children: (s: InstanceSettings) => ReactNode }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['system', 'settings'], queryFn: () => api.get<InstanceSettings>('/system/settings') });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await api.put('/system/settings', build(new FormData(event.currentTarget)));
      await queryClient.invalidateQueries({ queryKey: ['system', 'settings'] });
      await queryClient.invalidateQueries({ queryKey: ['branding'] });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  if (settings.isLoading) return <Skeleton className="h-96 w-full max-w-3xl rounded-xl" />;
  if (settings.error || !settings.data) return <Notice>{errorMessage(settings.error)}</Notice>;

  return (
    <form onSubmit={submit} className="max-w-3xl space-y-4">
      {error ? <Notice>{error}</Notice> : null}
      {children(settings.data)}
      <div className="sticky bottom-0 -mx-1 flex items-center gap-3 bg-background/90 px-1 py-3 backdrop-blur">
        <LoadingButton type="submit" loading={pending}>
          {t('Save settings')}
        </LoadingButton>
        {saved ? <span className="text-sm text-muted-foreground">{t('Saved. Every server applies it within a few seconds.')}</span> : null}
      </div>
    </form>
  );
}

/** Sign-in protection, passwords and the quota notice. */
export function SettingsTab() {
  return (
    <SettingsForm
      build={(data) => ({
        signIn: { maxFailures: int(data, 'maxFailures'), lockMinutes: int(data, 'lockMinutes') },
        passwords: { minLength: int(data, 'minLength'), requireMixed: data.get('requireMixed') !== null },
        impersonation: { allowOrgAdmins: data.get('allowOrgAdmins') !== null },
        quota: { warnAtPercent: int(data, 'warnAtPercent'), sender: text(data, 'quotaSender'), subject: text(data, 'quotaSubject'), template: String(data.get('quotaTemplate') ?? '') },
      })}
    >
      {(s) => (
        <>
          <Section title={t('Sign-in protection')} description={t('For the web and mail apps alike. App passwords are never locked. Locked accounts are listed under IP access.')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('Failed passwords before locking')}>
                {(props) => <Input {...props} name="maxFailures" type="number" min={3} max={100} defaultValue={s.signIn.maxFailures} required />}
              </FormField>
              <FormField label={t('Locked for (minutes)')}>
                {(props) => <Input {...props} name="lockMinutes" type="number" min={1} max={1440} defaultValue={s.signIn.lockMinutes} required />}
              </FormField>
            </div>
          </Section>
          <Section title={t('Passwords')} description={t('For new passwords: mailboxes created here, resets and changes.')}>
            <FormField label={t('Minimum length')}>
              {(props) => <Input {...props} name="minLength" type="number" min={12} max={128} defaultValue={s.passwords.minLength} required className="sm:max-w-40" />}
            </FormField>
            <Field orientation="horizontal">
              <Checkbox id="requireMixed" name="requireMixed" defaultChecked={s.passwords.requireMixed} />
              <FieldLabel htmlFor="requireMixed" className="font-normal">
                {t('Require three of: lowercase, uppercase, digits, symbols')}
              </FieldLabel>
            </Field>
          </Section>
          <Section
            title={t('Sign in as a mailbox')}
            description={t('Instance administrators can open someone’s mailbox from the Mailboxes page, with two-step verification and a reason. Every access is recorded in the organization’s activity.')}
          >
            <Field orientation="horizontal">
              <Checkbox id="allowOrgAdmins" name="allowOrgAdmins" defaultChecked={s.impersonation.allowOrgAdmins} />
              <FieldLabel htmlFor="allowOrgAdmins" className="font-normal">
                {t('Also the owners and admins of each organization, in their organization’s mailboxes')}
              </FieldLabel>
            </Field>
          </Section>
          <Section title={t('Mailbox quota notice')} description={t('People are told by mail when their mailbox fills up, and again a week later if it still is.')}>
            <FormField label={t('Warn when full at (percent)')} hint={t('0: never.')}>
              {(props) => <Input {...props} name="warnAtPercent" type="number" min={0} max={100} defaultValue={s.quota.warnAtPercent} required className="sm:max-w-40" />}
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('Sender')} hint={t('Empty: the server’s system address.')}>
                {(props) => <Input {...props} name="quotaSender" type="email" defaultValue={s.quota.sender} />}
              </FormField>
              <FormField label={t('Subject')} hint={t('Empty: “Your mailbox is 90% full”.')}>
                {(props) => <Input {...props} name="quotaSubject" defaultValue={s.quota.subject} maxLength={200} />}
              </FormField>
            </div>
            <FormField label={t('Text')} hint={t('Placeholders: {address}, {percent}, {used}, {quota}. Empty: the default text.')}>
              {(props) => <Textarea {...props} name="quotaTemplate" rows={5} defaultValue={s.quota.template} maxLength={5000} />}
            </FormField>
          </Section>
        </>
      )}
    </SettingsForm>
  );
}

const MB = 1024 * 1024;

/** How refused spam is kept, announced and released. */
export function QuarantineSettings() {
  return (
    <SettingsForm
      build={(data) => ({
        quarantine: {
          retentionDays: optionalNumber(data, 'retentionDays'),
          maxBytes: Math.round(Number(text(data, 'maxMegabytes') || 0) * MB),
          notifyMaxScore: optionalNumber(data, 'notifyMaxScore'),
          redirectTo: text(data, 'redirectTo'),
          bccTo: text(data, 'bccTo'),
          sender: text(data, 'sender'),
          subject: text(data, 'subject'),
          releaseFormat: text(data, 'releaseFormat') === 'attachment' ? 'attachment' : 'original',
          excludedDomains: text(data, 'excludedDomains')
            .split(/[\s,]+/)
            .filter(Boolean),
        },
      })}
    >
      {(s) => (
        <>
          <Section title={t('Keeping')} description={t('Mail the spam filter refuses is kept for its recipients, who can release it from the webmail.')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('Kept for (days)')} hint={t('Empty: the server default (30).')}>
                {(props) => <Input {...props} name="retentionDays" type="number" min={1} max={365} defaultValue={s.quarantine.retentionDays ?? ''} />}
              </FormField>
              <FormField label={t('Largest message kept (MB)')} hint={t('Larger ones are refused without being kept. 0: keep none.')}>
                {(props) => <Input {...props} name="maxMegabytes" type="number" min={0} max={100} step="0.1" defaultValue={+(s.quarantine.maxBytes / MB).toFixed(1)} required />}
              </FormField>
            </div>
            <FormField label={t('Never kept for these domains')} hint={t('Domain names, one per line: their refused mail is just refused.')}>
              {(props) => <Textarea {...props} name="excludedDomains" rows={3} defaultValue={s.quarantine.excludedDomains.join('\n')} className="font-mono text-xs" />}
            </FormField>
          </Section>
          <Section title={t('Notices')} description={t('People choose how often they hear about held mail (hourly, daily, weekly or never) in the webmail.')}>
            <FormField label={t('No notice above this spam score')} hint={t('Obvious spam is kept but never announced. Empty: always announce.')}>
              {(props) => <Input {...props} name="notifyMaxScore" type="number" min={0} max={1000} step="0.5" defaultValue={s.quarantine.notifyMaxScore ?? ''} className="sm:max-w-40" />}
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('Sender')} hint={t('Empty: the server’s system address.')}>
                {(props) => <Input {...props} name="sender" type="email" defaultValue={s.quarantine.sender} />}
              </FormField>
              <FormField label={t('Subject')} hint={t('Placeholders: {count}, {address}.')}>
                {(props) => <Input {...props} name="subject" defaultValue={s.quarantine.subject} maxLength={200} placeholder={t('{count} held as spam')} />}
              </FormField>
              <FormField label={t('Send every notice to')} hint={t('Instead of the recipients, e.g. a help desk. Empty: the recipients.')}>
                {(props) => <Input {...props} name="redirectTo" type="email" defaultValue={s.quarantine.redirectTo} />}
              </FormField>
              <FormField label={t('Blind copy of every notice to')}>
                {(props) => <Input {...props} name="bccTo" type="email" defaultValue={s.quarantine.bccTo} />}
              </FormField>
            </div>
          </Section>
          <Section title={t('Releasing')} description={t('What reaches the inbox when someone releases a held message.')}>
            <FormField label={t('Released mail arrives')}>
              {(props) => (
                <FormSelect {...props} name="releaseFormat" defaultValue={s.quarantine.releaseFormat} className="w-full sm:max-w-sm">
                  <FormSelectOption value="original">{t('As it was sent')}</FormSelectOption>
                  <FormSelectOption value="attachment">{t('Attached to a short note from the server')}</FormSelectOption>
                </FormSelect>
              )}
            </FormField>
          </Section>
        </>
      )}
    </SettingsForm>
  );
}

const LOGO_MAX = 200 * 1024;

function LogoField({ initial }: { initial: string }) {
  const [logo, setLogo] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field>
      <FieldLabel>{t('Logo')}</FieldLabel>
      <input type="hidden" name="logo" value={logo} />
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid size-16 place-items-center rounded-xl border bg-sidebar p-2">
          <BrandMark className="size-10" logo={logo} />
        </span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" asChild>
            <label className="cursor-pointer">
              <ImageUp aria-hidden />
              {t('Upload')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  if (file.size > LOGO_MAX) return setError(t('Use an image of at most 200 KB.'));
                  setError(null);
                  const reader = new FileReader();
                  reader.onload = () => setLogo(String(reader.result));
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          </Button>
          {logo ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setLogo('')}>
              {t('Use the Postarix stamp')}
            </Button>
          ) : null}
        </div>
      </div>
      <p className={cn('text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? t('PNG, JPEG, WebP or SVG, at most 200 KB; square works best. Shown in the panel, the webmail and the sign-in pages.')}
      </p>
    </Field>
  );
}

function AppLinksField({ initial }: { initial: { name: string; url: string }[] }) {
  const [links, setLinks] = useState(initial.length ? initial : []);
  const update = (index: number, change: Partial<{ name: string; url: string }>) =>
    setLinks((current) => current.map((link, i) => (i === index ? { ...link, ...change } : link)));
  return (
    <Field>
      <FieldLabel>{t('More apps')}</FieldLabel>
      <p className="text-sm text-muted-foreground">{t('Links in the Apps menus of the panel and the webmail, e.g. your help desk or file sharing.')}</p>
      <input type="hidden" name="appLinks" value={JSON.stringify(links.filter((l) => l.name.trim() && l.url.trim()))} />
      <div className="space-y-2">
        {links.map((link, index) => (
          <div key={index} className="flex gap-2">
            <Input aria-label={t('Name')} placeholder={t('Name')} value={link.name} maxLength={40} onChange={(e) => update(index, { name: e.target.value })} className="w-40" />
            <Input aria-label={t('Address')} placeholder="https://" type="url" value={link.url} onChange={(e) => update(index, { url: e.target.value })} className="flex-1" />
            <Button type="button" size="icon" variant="ghost" aria-label={t('Remove')} onClick={() => setLinks((current) => current.filter((_, i) => i !== index))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      {links.length < 12 ? (
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setLinks((current) => [...current, { name: '', url: '' }])}>
          <Plus aria-hidden />
          {t('Add a link')}
        </Button>
      ) : null}
    </Field>
  );
}

/** Name, logo, sign-in page, announcement and app links. */
export function CustomizeSettings() {
  return (
    <SettingsForm
      build={(data) => ({
        branding: {
          productName: text(data, 'productName'),
          logo: String(data.get('logo') ?? ''),
          loginMessage: text(data, 'loginMessage'),
          footer: text(data, 'footer'),
          hidePasswordSignIn: data.get('hidePasswordSignIn') !== null,
          announcement: text(data, 'announcement'),
          announcementLevel: text(data, 'announcementLevel') as InstanceSettings['branding']['announcementLevel'],
          supportUrl: text(data, 'supportUrl'),
          appLinks: JSON.parse(String(data.get('appLinks') ?? '[]')) as { name: string; url: string }[],
        },
      })}
    >
      {(s) => (
        <>
          <Section title={t('Identity')} description={t('What people see in the page titles, the panel and the webmail.')}>
            <FormField label={t('Name')}>
              {(props) => <Input {...props} name="productName" defaultValue={s.branding.productName} maxLength={60} required className="sm:max-w-sm" />}
            </FormField>
            <LogoField initial={s.branding.logo} />
          </Section>
          <Section title={t('Sign-in pages')} description={t('The panel’s and the webmail’s.')}>
            <FormField label={t('Sign-in message')} hint={t('E.g. who to contact for help.')}>
              {(props) => <Textarea {...props} name="loginMessage" rows={2} defaultValue={s.branding.loginMessage} maxLength={500} />}
            </FormField>
            <FormField label={t('Footer')} hint={t('A line at the bottom, e.g. your company and its legal notice.')}>
              {(props) => <Textarea {...props} name="footer" rows={2} defaultValue={s.branding.footer} maxLength={500} />}
            </FormField>
            <Field orientation="horizontal">
              <Checkbox id="hidePasswordSignIn" name="hidePasswordSignIn" defaultChecked={s.branding.hidePasswordSignIn} />
              <FieldLabel htmlFor="hidePasswordSignIn" className="font-normal">
                {t('Only single sign-on and passkeys (the password form stays reachable with ?password=1)')}
              </FieldLabel>
            </Field>
          </Section>
          <Section title={t('Announcement')} description={t('Shown to everyone signed in to the webmail and the panel, e.g. planned maintenance.')}>
            <FormField label={t('Text')} hint={t('Empty: none.')}>
              {(props) => <Textarea {...props} name="announcement" rows={2} defaultValue={s.branding.announcement} maxLength={500} />}
            </FormField>
            <FormField label={t('Level')}>
              {(props) => (
                <FormSelect {...props} name="announcementLevel" defaultValue={s.branding.announcementLevel} className="w-full sm:max-w-xs">
                  <FormSelectOption value="info">{t('Information')}</FormSelectOption>
                  <FormSelectOption value="important">{t('Important')}</FormSelectOption>
                  <FormSelectOption value="urgent">{t('Urgent')}</FormSelectOption>
                </FormSelect>
              )}
            </FormField>
          </Section>
          <Section title={t('Links')} description={t('Where people get help, and other apps of yours.')}>
            <FormField label={t('Help page')}>
              {(props) => <Input {...props} name="supportUrl" type="url" defaultValue={s.branding.supportUrl} placeholder="https://" />}
            </FormField>
            <AppLinksField initial={s.branding.appLinks} />
          </Section>
        </>
      )}
    </SettingsForm>
  );
}
