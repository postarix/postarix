'use client';

import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Textarea } from '@postarix/ui/components/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Eye, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { t } from '@/lib/i18n';
import { keys, useOrgList } from '@/lib/queries';
import type { ConnectedApp, Mailbox, Supervision } from '@/lib/types';

const SCOPES: { value: ConnectedApp['scopes'][number]; label: string; hint: string }[] = [
  { value: 'mail.read', label: t('Read mail'), hint: t('Folders, messages and unread counts.') },
  { value: 'mail.write', label: t('Change mail'), hint: t('Mark, move, delete and save drafts.') },
  { value: 'mail.send', label: t('Send mail'), hint: t('As the person, from their addresses and shared mailboxes.') },
  { value: 'mail.supervise', label: t('Supervise'), hint: t('Let people with the right read others’ mailboxes, with a reason. Also needs supervision turned on below.') },
];

/** The secret, shown once after creating or rotating it. */
function SecretNotice({ clientId, secret, onClose }: { clientId: string; secret: string; onClose: () => void }) {
  return (
    <AppDialog open onClose={onClose} title={t('Copy the secret now')} description={t('It is not shown again. Keep it on the application’s server only, never in a browser.')}>
      <dl className="grid gap-3 text-sm">
        <dt className="text-muted-foreground">{t('Client ID')}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{clientId}</code>
          <CopyButton value={clientId} />
        </dd>
        <dt className="text-muted-foreground">{t('Client secret')}</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{secret}</code>
          <CopyButton value={secret} />
        </dd>
      </dl>
      <DialogFooter>
        <Button onClick={onClose}>{t('Done')}</Button>
      </DialogFooter>
    </AppDialog>
  );
}

function AppDialogForm({ orgId, onClose, onCreated }: { orgId: string; onClose: () => void; onCreated: (clientId: string, secret: string | null) => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [keyMode, setKeyMode] = useState<'secret' | 'jwksUri' | 'jwks'>('secret');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const lines = (name: string) =>
        String(data.get(name) ?? '')
          .split(/[\s,;]+/)
          .map((v) => v.trim())
          .filter(Boolean);
      let jwks: unknown = null;
      if (keyMode === 'jwks') {
        try {
          jwks = JSON.parse(String(data.get('jwks') ?? ''));
        } catch {
          throw new Error(t('The keys must be a JSON key set: {"keys": [...]}'));
        }
      }
      const expires = String(data.get('expiresAt') ?? '');
      const created = await api.post<ConnectedApp & { clientSecret: string | null }>(`/orgs/${orgId}/apps`, {
        name: String(data.get('name') ?? ''),
        identityIssuer: String(data.get('identityIssuer') ?? ''),
        scopes: SCOPES.map((s) => s.value).filter((s) => data.get(`scope-${s}`) !== null),
        allowedIps: lines('allowedIps'),
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        jwksUri: keyMode === 'jwksUri' ? String(data.get('jwksUri') ?? '') : null,
        jwks,
        requirePrivateKeyJwt: keyMode !== 'secret',
        allowUserIdSubjects: data.get('allowUserIdSubjects') !== null,
      });
      void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'apps') });
      onCreated(created.clientId, created.clientSecret);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t('Connect an application')}
      description={t('A helpdesk, CRM or intranet that shows your people their mail. It asks for short tokens that act as one person at a time; it never chooses mailboxes.')}
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Name')}>{(props) => <Input {...props} name="name" required maxLength={100} placeholder={t('Helpdesk')} />}</FormField>
          <FormField
            label={t('Identity issuer')}
            hint={t('The name the application uses for itself: people are linked to it with their Identities (their id in the application).')}
          >
            {(props) => <Input {...props} name="identityIssuer" required maxLength={500} placeholder="https://helpdesk.example.com" />}
          </FormField>
          <Field>
            <FieldLabel>{t('It may')}</FieldLabel>
            <div className="grid gap-2">
              {SCOPES.map((scope) => (
                <Field key={scope.value} orientation="horizontal" className="items-start">
                  <Checkbox id={`scope-${scope.value}`} name={`scope-${scope.value}`} defaultChecked={scope.value === 'mail.read'} />
                  <div className="grid gap-0.5">
                    <FieldLabel htmlFor={`scope-${scope.value}`} className="font-normal">{scope.label}</FieldLabel>
                    <p className="text-xs text-muted-foreground">{scope.hint}</p>
                  </div>
                </Field>
              ))}
            </div>
          </Field>
          <FormField label={t('How it proves who it is')}>
            {(props) => (
              <FormSelect {...props} value={keyMode} onChange={(e) => setKeyMode(e.target.value as typeof keyMode)} className="w-full">
                <FormSelectOption value="secret">{t('A secret (shown once)')}</FormSelectOption>
                <FormSelectOption value="jwksUri">{t('Signed assertions, keys at a URL (private_key_jwt)')}</FormSelectOption>
                <FormSelectOption value="jwks">{t('Signed assertions, keys pasted here (private_key_jwt)')}</FormSelectOption>
              </FormSelect>
            )}
          </FormField>
          {keyMode === 'jwksUri' ? (
            <FormField label={t('JWKS URL')} hint={t('https, on a public address.')}>
              {(props) => <Input {...props} name="jwksUri" type="url" required placeholder="https://helpdesk.example.com/.well-known/jwks.json" />}
            </FormField>
          ) : keyMode === 'jwks' ? (
            <FormField label={t('Public keys (JWKS)')}>{(props) => <Textarea {...props} name="jwks" required rows={4} className="font-mono text-xs" />}</FormField>
          ) : null}
          <FormField label={t('Only from these addresses')} hint={t('IP addresses or networks, one per line. Empty: anywhere.')}>
            {(props) => <Textarea {...props} name="allowedIps" rows={2} className="font-mono" placeholder="203.0.113.10" />}
          </FormField>
          <FormField label={t('Stops working on')} hint={t('Empty: never.')}>
            {(props) => <Input {...props} name="expiresAt" type="date" />}
          </FormField>
          <Field orientation="horizontal">
            <Checkbox id="app-user-ids" name="allowUserIdSubjects" />
            <FieldLabel htmlFor="app-user-ids" className="font-normal">{t('It may also name people by their Postarix user id (not only those linked to it)')}</FieldLabel>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <LoadingButton type="submit" loading={pending}>{t('Connect')}</LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

/** Supervision: off by default; who may supervise; recent supervisions. */
function SupervisionSection({ orgId, people }: { orgId: string; people: Mailbox[] }) {
  const queryClient = useQueryClient();
  const key = ['org', orgId, 'supervision'];
  const state = useQuery({ queryKey: key, queryFn: () => api.get<Supervision>(`/orgs/${orgId}/supervision`) });
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      void queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const data = state.data;
  const supervisorIds = new Set(data?.supervisors.map((s) => s.userId));
  const candidates = people.filter((p) => p.userId && !supervisorIds.has(p.userId));
  const nameOf = (userId: string) => people.find((p) => p.userId === userId)?.address ?? userId;

  return (
    <section aria-labelledby="supervision-title" className="mt-8 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <Eye className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h2 id="supervision-title" className="text-base font-semibold">{t('Supervision')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('Applications with “Supervise” can let the people below read someone’s own mailbox (never a shared one, never an instance administrator’s): read-only, for an hour at most, with a reason, recorded here and in Activity. Check what your law requires first.')}
            </p>
          </div>
          {error ? <Notice>{error}</Notice> : null}
          {state.isLoading || !data ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox id="supervision-enabled" checked={data.enabled} onCheckedChange={(v) => void run(() => api.put(`/orgs/${orgId}/supervision`, { enabled: v === true, notify: data.notify }))} />
                  <label htmlFor="supervision-enabled" className="text-sm">{t('Allow supervision')}</label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox id="supervision-notify" checked={data.notify} onCheckedChange={(v) => void run(() => api.put(`/orgs/${orgId}/supervision`, { enabled: data.enabled, notify: v === true }))} />
                  <label htmlFor="supervision-notify" className="text-sm">{t('Tell the person by mail each time')}</label>
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">{t('May supervise')}</p>
                {data.supervisors.length ? (
                  <ul className="mb-3 divide-y rounded-md border">
                    {data.supervisors.map((s) => (
                      <li key={s.userId} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="truncate">{s.displayName ? `${s.displayName} <${s.address}>` : s.address}</span>
                        <Button size="icon-sm" variant="ghost" aria-label={`${t('Remove')}: ${s.address}`} onClick={() => void run(() => api.delete(`/orgs/${orgId}/supervision/supervisors/${encodeURIComponent(s.userId)}`))}>
                          <Trash2 aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-3 text-sm text-muted-foreground">{t('Nobody yet. Being an owner or administrator does not include it.')}</p>
                )}
                {candidates.length ? (
                  <div className="flex gap-2">
                    <FormSelect aria-label={t('Person')} value={adding} onChange={(e) => setAdding(e.target.value)} className="min-w-0 flex-1">
                      <FormSelectOption value="">{t('Choose a person…')}</FormSelectOption>
                      {candidates.map((p) => (
                        <FormSelectOption key={p.userId} value={p.userId!}>
                          {p.address}
                        </FormSelectOption>
                      ))}
                    </FormSelect>
                    <Button variant="outline" disabled={!adding} onClick={() => void run(() => api.put(`/orgs/${orgId}/supervision/supervisors/${encodeURIComponent(adding)}`, {})).then(() => setAdding(''))}>
                      {t('Add')}
                    </Button>
                  </div>
                ) : null}
              </div>
              {data.recent.length ? (
                <div>
                  <p className="mb-2 text-sm font-medium">{t('Recent supervision')}</p>
                  <ul className="divide-y rounded-md border text-sm">
                    {data.recent.map((g) => (
                      <li key={g.id} className="px-3 py-2">
                        <p>
                          <span className="font-medium">{nameOf(g.supervisorId)}</span> → <span className="font-medium">{nameOf(g.subjectId)}</span>{' '}
                          <span className="text-muted-foreground">({g.app}, {formatDate(g.createdAt)})</span>
                        </p>
                        <p className="text-muted-foreground">{g.reason}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default function AppsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const apps = useOrgList<ConnectedApp>(orgId, 'apps');
  const mailboxes = useOrgList<Mailbox>(orgId, 'mailboxes');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ clientId: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ConnectedApp | null>(null);
  const [deleting, setDeleting] = useState<ConnectedApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'apps') });
  const people = (mailboxes.data ?? []).filter((m) => m.kind === 'person' && m.userId);

  async function rotate(app: ConnectedApp) {
    setError(null);
    try {
      const result = await api.post<{ clientSecret: string }>(`/orgs/${orgId}/apps/${app.id}/secret`, {});
      setSecret({ clientId: app.clientId, secret: result.clientSecret });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title={t('Applications')}
        description={t('Other applications that show your people their mail (a helpdesk, a CRM, an intranet), and supervision. See the integration guide in the documentation.')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />{t('Connect an application')}</Button>
        }
      />
      {error ? <Notice>{error}</Notice> : null}
      {apps.isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : apps.error ? (
        <Notice>{errorMessage(apps.error)}</Notice>
      ) : apps.data?.length ? (
        <ul className="grid gap-4">
          {apps.data.map((app) => {
            const expired = app.expiresAt !== null && new Date(app.expiresAt).getTime() < Date.now();
            return (
              <li key={app.id} className="rounded-xl border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-base font-semibold">
                      {app.name}
                      {app.revokedAt ? <Badge variant="secondary">{t('Revoked')}</Badge> : expired ? <Badge variant="warning">{t('Expired')}</Badge> : null}
                    </h3>
                    <p className="truncate text-sm text-muted-foreground">{app.identityIssuer}</p>
                  </div>
                  <div className="flex gap-1">
                    {!app.revokedAt && app.hasSecret ? (
                      <Button variant="ghost" size="sm" onClick={() => void rotate(app)}>
                        <RefreshCw aria-hidden />{t('New secret')}</Button>
                    ) : null}
                    {!app.revokedAt ? (
                      <Button variant="ghost" size="sm" onClick={() => setRevoking(app)}>
                        <Ban aria-hidden />{t('Revoke')}</Button>
                    ) : null}
                    <Button variant="ghost" size="icon-sm" aria-label={`${t('Delete')} ${app.name}`} onClick={() => setDeleting(app)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </div>
                <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
                  <dt className="text-muted-foreground">{t('Client ID')}</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{app.clientId}</code>
                    <CopyButton value={app.clientId} />
                  </dd>
                  <dt className="text-muted-foreground">{t('It may')}</dt>
                  <dd className="flex flex-wrap gap-1">
                    {app.scopes.map((s) => (
                      <Badge key={s} variant="secondary">{SCOPES.find((x) => x.value === s)?.label ?? s}</Badge>
                    ))}
                  </dd>
                  <dt className="text-muted-foreground">{t('Proves who it is with')}</dt>
                  <dd>{app.requirePrivateKeyJwt ? (app.jwksUri ?? t('Its keys (pasted)')) : t('A secret')}</dd>
                  <dt className="text-muted-foreground">{t('From')}</dt>
                  <dd className="truncate">{app.allowedIps.length ? app.allowedIps.join(', ') : t('Anywhere')}</dd>
                  <dt className="text-muted-foreground">{t('Last used')}</dt>
                  <dd>{app.lastUsedAt ? formatDate(app.lastUsedAt) : t('Never')}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={Plug} title={t('No applications yet')} description={t('Connect one to let it show your people their mail, with their own rights.')} />
      )}
      <SupervisionSection orgId={orgId} people={people} />
      {creating ? (
        <AppDialogForm
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={(clientId, clientSecret) => {
            setCreating(false);
            if (clientSecret) setSecret({ clientId, secret: clientSecret });
          }}
        />
      ) : null}
      {secret ? <SecretNotice clientId={secret.clientId} secret={secret.secret} onClose={() => setSecret(null)} /> : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`${t('Revoke')} ${revoking?.name ?? ''}?`}
        description={t('It stops working at once: its tokens, its secret and its requests in progress.')}
        confirmLabel={t('Revoke')}
        onConfirm={async () => {
          if (revoking) await api.post(`/orgs/${orgId}/apps/${revoking.id}/revoke`, {});
          refresh();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`${t('Delete')} ${deleting?.name ?? ''}?`}
        description={t('It stops working at once, and its supervision records go with it.')}
        confirmLabel={t('Delete')}
        onConfirm={async () => {
          if (deleting) await api.delete(`/orgs/${orgId}/apps/${deleting.id}`);
          refresh();
        }}
      />
    </>
  );
}
