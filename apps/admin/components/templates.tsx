'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { t } from '@/lib/i18n';
import { quotaFromGiB, quotaToGiB } from '@/lib/quota';
import type { RateLimit, SpamScores } from '@/lib/types';
import { AppDialog } from './app-dialog';
import { ConfirmDialog } from './confirm';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';
import { RateLimitField, rateLimitFrom } from './rate-limit-field';

export interface Template<S> {
  id: string;
  name: string;
  isDefault: boolean;
  settings: S;
}

export interface DomainTemplateSettings {
  defaultMailboxQuotaBytes?: number | null;
  maxMailboxes?: number | null;
  maxAliases?: number | null;
  maxMailboxQuotaBytes?: number | null;
  totalQuotaBytes?: number | null;
  rateLimit?: RateLimit | null;
  spamScores?: SpamScores;
  mtaStsMode?: 'enforce' | 'testing' | 'none' | null;
}

export interface MailboxTemplateSettings {
  quotaBytes?: number | null;
  allowedProtocols?: ('imap' | 'pop3' | 'smtp' | 'sieve' | 'dav')[];
  tlsRequiredIn?: boolean;
  tlsRequiredOut?: boolean;
  rateLimit?: RateLimit | null;
  spamScores?: SpamScores;
  quarantineNotify?: 'never' | 'hourly' | 'daily' | 'weekly';
}

const PROTOCOLS = [
  { value: 'imap', label: 'IMAP' },
  { value: 'pop3', label: 'POP3' },
  { value: 'smtp', label: 'SMTP' },
  { value: 'sieve', label: 'Sieve' },
  { value: 'dav', label: 'CalDAV/CardDAV' },
] as const;

// --- Reading the forms: an empty field leaves the setting to the usual default. ---

const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();

function countField(data: FormData, name: string): number | undefined {
  const value = text(data, name);
  if (value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('Counts are whole numbers');
  return n;
}

function quotaField(data: FormData, name: string): number | undefined {
  const value = text(data, name);
  return value === '' ? undefined : (quotaFromGiB(value) ?? undefined);
}

function scoreField(data: FormData, name: string): number | null {
  const value = text(data, name);
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Scores are positive numbers');
  return n;
}

function spamFrom(data: FormData): SpamScores | undefined {
  const scores = { junkScore: scoreField(data, 'junkScore'), rejectScore: scoreField(data, 'rejectScore') };
  return scores.junkScore === null && scores.rejectScore === null ? undefined : scores;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function domainSettingsFrom(data: FormData): DomainTemplateSettings {
  const rate = rateLimitFrom(data);
  return compact({
    defaultMailboxQuotaBytes: quotaField(data, 'defaultQuota'),
    maxMailboxes: countField(data, 'maxMailboxes'),
    maxAliases: countField(data, 'maxAliases'),
    maxMailboxQuotaBytes: quotaField(data, 'maxMailboxQuota'),
    totalQuotaBytes: quotaField(data, 'totalQuota'),
    rateLimit: rate ?? undefined,
    spamScores: spamFrom(data),
    mtaStsMode: (text(data, 'mtaStsMode') || undefined) as DomainTemplateSettings['mtaStsMode'],
  });
}

export function mailboxSettingsFrom(data: FormData): MailboxTemplateSettings {
  const rate = rateLimitFrom(data);
  return compact({
    quotaBytes: quotaField(data, 'quota'),
    allowedProtocols: PROTOCOLS.map((p) => p.value).filter((p) => data.get(`tpl-protocol-${p}`) !== null),
    tlsRequiredIn: data.get('tlsRequiredIn') !== null ? true : undefined,
    tlsRequiredOut: data.get('tlsRequiredOut') !== null ? true : undefined,
    rateLimit: rate ?? undefined,
    spamScores: spamFrom(data),
    quarantineNotify: (text(data, 'quarantineNotify') || undefined) as MailboxTemplateSettings['quarantineNotify'],
  });
}

function SpamFields({ scores }: { scores: SpamScores | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField label={t('Junk from score')}>
        {(props) => <Input {...props} name="junkScore" inputMode="decimal" defaultValue={scores?.junkScore ?? ''} />}
      </FormField>
      <FormField label={t('Refuse from score')}>
        {(props) => <Input {...props} name="rejectScore" inputMode="decimal" defaultValue={scores?.rejectScore ?? ''} />}
      </FormField>
    </div>
  );
}

export function DomainTemplateFields({ settings }: { settings: DomainTemplateSettings }) {
  const quota = (v: number | null | undefined) => (v === undefined ? '' : quotaToGiB(v));
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('Mailboxes')}>{(props) => <Input {...props} name="maxMailboxes" inputMode="numeric" defaultValue={settings.maxMailboxes ?? ''} />}</FormField>
        <FormField label={t('Aliases')}>{(props) => <Input {...props} name="maxAliases" inputMode="numeric" defaultValue={settings.maxAliases ?? ''} />}</FormField>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <FormField label={t('Default quota (GB)')}>
          {(props) => <Input {...props} name="defaultQuota" inputMode="decimal" defaultValue={quota(settings.defaultMailboxQuotaBytes)} />}
        </FormField>
        <FormField label={t('Largest quota (GB)')}>
          {(props) => <Input {...props} name="maxMailboxQuota" inputMode="decimal" defaultValue={quota(settings.maxMailboxQuotaBytes)} />}
        </FormField>
        <FormField label={t('Total quota (GB)')}>
          {(props) => <Input {...props} name="totalQuota" inputMode="decimal" defaultValue={quota(settings.totalQuotaBytes)} />}
        </FormField>
      </div>
      <RateLimitField label={t('Sending limit per mailbox')} hint={t('Empty: no limit.')} value={settings.rateLimit ?? null} />
      <SpamFields scores={settings.spamScores} />
      <FormField label={t('MTA-STS policy')}>
        {(props) => (
          <NativeSelect {...props} name="mtaStsMode" defaultValue={settings.mtaStsMode ?? ''} className="w-full">
            <NativeSelectOption value="">{t('The server\'s default')}</NativeSelectOption>
            <NativeSelectOption value="enforce">enforce</NativeSelectOption>
            <NativeSelectOption value="testing">testing</NativeSelectOption>
            <NativeSelectOption value="none">none</NativeSelectOption>
          </NativeSelect>
        )}
      </FormField>
    </>
  );
}

export function MailboxTemplateFields({ settings }: { settings: MailboxTemplateSettings }) {
  const protocols = settings.allowedProtocols ?? PROTOCOLS.map((p) => p.value);
  return (
    <>
      <FormField label={t('Quota (GB)')} hint={t('Empty: the domain\'s default quota.')}>
        {(props) => <Input {...props} name="quota" inputMode="decimal" defaultValue={settings.quotaBytes === undefined ? '' : quotaToGiB(settings.quotaBytes)} />}
      </FormField>
      <div>
        <p className="mb-2 text-sm font-medium">{t('Allowed protocols')}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {PROTOCOLS.map((p) => (
            <Field key={p.value} orientation="horizontal" className="w-auto">
              <Checkbox id={`tpl-protocol-${p.value}`} name={`tpl-protocol-${p.value}`} defaultChecked={protocols.includes(p.value)} />
              <FieldLabel htmlFor={`tpl-protocol-${p.value}`} className="font-normal">
                {p.label}
              </FieldLabel>
            </Field>
          ))}
        </div>
      </div>
      <Field orientation="horizontal">
        <Checkbox id="tpl-tls-in" name="tlsRequiredIn" defaultChecked={settings.tlsRequiredIn ?? false} />
        <FieldLabel htmlFor="tpl-tls-in" className="font-normal">
          {t('Refuse incoming mail from servers that do not use TLS')}
        </FieldLabel>
      </Field>
      <Field orientation="horizontal">
        <Checkbox id="tpl-tls-out" name="tlsRequiredOut" defaultChecked={settings.tlsRequiredOut ?? false} />
        <FieldLabel htmlFor="tpl-tls-out" className="font-normal">
          {t('Send outgoing mail only over TLS')}
        </FieldLabel>
      </Field>
      <RateLimitField label={t('Sending limit')} hint={t('Empty: its domain\'s limit, if any.')} value={settings.rateLimit ?? null} />
      <SpamFields scores={settings.spamScores} />
      <FormField label={t('Quarantine notices')}>
        {(props) => (
          <NativeSelect {...props} name="quarantineNotify" defaultValue={settings.quarantineNotify ?? ''} className="w-full">
            <NativeSelectOption value="">{t('The usual (daily)')}</NativeSelectOption>
            <NativeSelectOption value="never">{t('Never')}</NativeSelectOption>
            <NativeSelectOption value="hourly">{t('Hourly')}</NativeSelectOption>
            <NativeSelectOption value="daily">{t('Daily')}</NativeSelectOption>
            <NativeSelectOption value="weekly">{t('Weekly')}</NativeSelectOption>
          </NativeSelect>
        )}
      </FormField>
    </>
  );
}

/** A short line of what a template sets. */
export function describeSettings(settings: DomainTemplateSettings & MailboxTemplateSettings): string {
  const parts: string[] = [];
  if (typeof settings.maxMailboxes === 'number') parts.push(`${settings.maxMailboxes} ${t('mailboxes')}`);
  if (typeof settings.maxAliases === 'number') parts.push(`${settings.maxAliases} ${t('aliases')}`);
  const quota = settings.quotaBytes ?? settings.defaultMailboxQuotaBytes;
  if (typeof quota === 'number') parts.push(`${formatBytes(quota)} ${t('each')}`);
  if (settings.rateLimit) parts.push(`${settings.rateLimit.messages}/${settings.rateLimit.per}`);
  if (settings.allowedProtocols) parts.push(settings.allowedProtocols.join(', ') || t('webmail only'));
  if (settings.tlsRequiredIn || settings.tlsRequiredOut) parts.push('TLS');
  if (settings.mtaStsMode) parts.push(`MTA-STS ${settings.mtaStsMode}`);
  return parts.join(' · ') || t('Nothing set');
}

/** Templates of one kind, with add, edit and delete. */
export function TemplateList<S extends object>({
  url,
  queryKey,
  description,
  fields,
  read,
}: {
  url: string;
  queryKey: readonly unknown[];
  description: string;
  fields: (settings: S) => ReactNode;
  read: (data: FormData) => S;
}) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey, queryFn: () => api.get<{ data: Template<S>[] }>(url).then((r) => r.data) });
  const [editing, setEditing] = useState<Template<S> | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Template<S> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const body = { name: text(data, 'name'), isDefault: data.get('isDefault') !== null, settings: read(data) };
      if (editing === 'new') await api.post(url, body);
      else if (editing) await api.patch(`${url}/${editing.id}`, body);
      refresh();
      setEditing(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setEditing('new');
          }}
        >
          <Plus aria-hidden />
          {t('New template')}
        </Button>
      </div>
      {list.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : list.error ? (
        <Notice>{errorMessage(list.error)}</Notice>
      ) : list.data?.length ? (
        <ul className="divide-y rounded-md border">
          {list.data.map((template) => (
            <li key={template.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="flex items-center gap-2 font-medium">
                  {template.name}
                  {template.isDefault ? <Badge variant="secondary">{t('Default')}</Badge> : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{describeSettings(template.settings)}</span>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('Edit')}: ${template.name}`}
                  onClick={() => {
                    setError(null);
                    setEditing(template);
                  }}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`${t('Delete')}: ${template.name}`} onClick={() => setDeleting(template)}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('No templates yet.')}</p>
      )}
      {editing ? (
        <AppDialog
          open
          onClose={() => setEditing(null)}
          title={editing === 'new' ? t('New template') : `${t('Edit')}: ${editing.name}`}
          description={t('Empty fields leave the setting as usual.')}
        >
          <form onSubmit={submit}>
            <FieldGroup>
              {error ? <Notice>{error}</Notice> : null}
              <FormField label={t('Name')}>
                {(props) => <Input {...props} name="name" defaultValue={editing === 'new' ? '' : editing.name} required maxLength={100} />}
              </FormField>
              {fields(editing === 'new' ? ({} as S) : editing.settings)}
              <Field orientation="horizontal">
                <Checkbox id="template-default" name="isDefault" defaultChecked={editing === 'new' ? false : editing.isDefault} />
                <FieldLabel htmlFor="template-default" className="font-normal">
                  {t('Use when no other template is chosen')}
                </FieldLabel>
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                  {t('Cancel')}
                </Button>
                <LoadingButton type="submit" loading={pending}>
                  {t('Save')}
                </LoadingButton>
              </DialogFooter>
            </FieldGroup>
          </form>
        </AppDialog>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('Delete this template?')}
        description={t('Domains and mailboxes made with it keep their settings.')}
        onConfirm={async () => {
          if (!deleting) return;
          await api.delete(`${url}/${deleting.id}`);
          refresh();
        }}
      />
    </div>
  );
}
