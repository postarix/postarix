'use client';

import { Button } from '@postarix/ui/components/button';
import { Checkbox } from '@postarix/ui/components/checkbox';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Textarea } from '@postarix/ui/components/textarea';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
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
import { keys, useOrgList } from '@/lib/queries';
import type { Domain, SsoProvider } from '@/lib/types';
import { t } from '@/lib/i18n';

function ProviderDialog({ orgId, domains, onClose }: { orgId: string; domains: Domain[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [protocol, setProtocol] = useState<'oidc' | 'saml'>('oidc');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.post(
        `/orgs/${orgId}/sso`,
        protocol === 'saml'
          ? {
              type: 'saml',
              domainId: String(data.get('domainId')),
              entityId: String(data.get('entityId')).trim(),
              ssoUrl: String(data.get('ssoUrl')).trim(),
              certificate: String(data.get('certificate')),
            }
          : {
              type: 'oidc',
              domainId: String(data.get('domainId')),
              issuer: String(data.get('issuer')).trim(),
              clientId: String(data.get('clientId')),
              clientSecret: String(data.get('clientSecret')),
            },
      );
      await queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'sso') });
      onClose();
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
      title={t('Connect an identity provider')}
      description={t('OpenID Connect or SAML 2.0: Microsoft Entra ID, Google Workspace, Okta, Keycloak, Authentik, ADFS…')}
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Domain')} hint={t('People with a mailbox on this domain sign in through the provider.')}>
            {(props) => (
              <FormSelect {...props} name="domainId" required className="w-full">
                {domains.map((d) => (
                  <FormSelectOption key={d.id} value={d.id}>
                    {d.name}
                  </FormSelectOption>
                ))}
              </FormSelect>
            )}
          </FormField>
          <FormField label={t('Protocol')}>
            {(props) => (
              <FormSelect {...props} value={protocol} onChange={(e) => setProtocol(e.target.value as 'oidc' | 'saml')} className="w-full">
                <FormSelectOption value="oidc">{t('OpenID Connect')}</FormSelectOption>
                <FormSelectOption value="saml">{t('SAML 2.0')}</FormSelectOption>
              </FormSelect>
            )}
          </FormField>
          {protocol === 'oidc' ? (
            <>
              <FormField label={t('Issuer URL')} hint={t('Postarix reads the rest from its /.well-known/openid-configuration.')}>
                {(props) => <Input {...props} name="issuer" type="url" required placeholder="https://login.example.com/realms/acme" />}
              </FormField>
              <FormField label={t('Client ID')}>{(props) => <Input {...props} name="clientId" required autoComplete="off" />}</FormField>
              <FormField label={t('Client secret')} hint={t('Stored on the server and never shown again.')}>
                {(props) => <Input {...props} name="clientSecret" type="password" required autoComplete="off" />}
              </FormField>
            </>
          ) : (
            <>
              <FormField label={t('Identity provider identifier')} hint={t('Its entity ID, also called Identifier or Issuer.')}>
                {(props) => <Input {...props} name="entityId" required placeholder="https://sts.windows.net/…/" autoComplete="off" />}
              </FormField>
              <FormField label={t('Sign-in URL')} hint={t('Where people are sent to sign in (SAML single sign-on URL).')}>
                {(props) => <Input {...props} name="ssoUrl" type="url" required placeholder="https://login.example.com/saml2" />}
              </FormField>
              <FormField label={t('Signing certificate')} hint={t('The certificate (Base64 or PEM) the provider signs its answers with.')}>
                {(props) => <Textarea {...props} name="certificate" required rows={5} className="font-mono text-xs" />}
              </FormField>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <LoadingButton type="submit" loading={pending}>{t('Connect provider')}</LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}

/** The organization's rule on second factors (authenticator app or passkey). */
function SecondFactorRule({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const key = ['org', orgId, 'security'];
  const security = useQuery({ queryKey: key, queryFn: () => api.get<{ requireSecondFactor: boolean }>(`/orgs/${orgId}/security`) });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function change(requireSecondFactor: boolean) {
    setPending(true);
    setError(null);
    try {
      queryClient.setQueryData(key, await api.put(`/orgs/${orgId}/security`, { requireSecondFactor }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="second-factor-title" className="mb-6 rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h2 id="second-factor-title" className="text-base font-semibold">{t('Two-step sign-in')}</h2>
            <p className="text-sm text-muted-foreground">{t('Ask everyone in the organization for an authenticator app or a passkey. Until they set one up they can only open their account settings, and mail apps need app passwords.')}</p>
          </div>
          {error ? <Notice>{error}</Notice> : null}
          {security.isLoading ? (
            <Skeleton className="h-5 w-64" />
          ) : (
            <div className="flex items-center gap-2">
              <Checkbox
                id="require-second-factor"
                checked={security.data?.requireSecondFactor ?? false}
                disabled={pending || !security.data}
                onCheckedChange={(v) => void change(v === true)}
              />
              <label htmlFor="require-second-factor" className="text-sm">{t('Require two-step sign-in for everyone')}</label>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function SsoPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const queryClient = useQueryClient();
  const providers = useOrgList<SsoProvider>(orgId, 'sso');
  const domains = useOrgList<Domain>(orgId, 'domains');
  const taken = new Set(providers.data?.map((p) => p.domain));
  const available = domains.data?.filter((d) => d.status === 'active' && !taken.has(d.name)) ?? [];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SsoProvider | null>(null);

  return (
    <>
      <PageHeader
        title={t('Sign-in')}
        description={t('How people sign in to webmail and this console: two-step sign-in, and single sign-on with your company account. Mail apps keep using app passwords.')}
        actions={
          <Button onClick={() => setAdding(true)} disabled={available.length === 0}>
            <Plus aria-hidden />{t('Connect provider')}</Button>
        }
      />
      <SecondFactorRule orgId={orgId} />
      {providers.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : providers.error ? (
        <Notice>{errorMessage(providers.error)}</Notice>
      ) : providers.data?.length ? (
        <ul className="grid gap-4">
          {providers.data.map((provider) => (
            <li key={provider.id} data-testid={`sso-${provider.domain}`} className="rounded-xl border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold">{provider.domain}</h3>
                  <p className="truncate text-sm text-muted-foreground">{provider.issuer}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(provider)}>
                  <Trash2 aria-hidden />{t('Disconnect')}</Button>
              </div>
              {provider.type === 'saml' ? (
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
                  <dt className="text-muted-foreground">{t('Identifier (entity ID)')}</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{provider.entityId}</code>
                    <CopyButton value={provider.entityId ?? ''} />
                  </dd>
                  <dt className="text-muted-foreground">{t('Reply URL (ACS)')}</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{provider.callbackUrl}</code>
                    <CopyButton value={provider.callbackUrl} />
                  </dd>
                  <dt className="text-muted-foreground">{t('Certificate expires')}</dt>
                  <dd>{provider.certificateExpiresAt ? new Date(provider.certificateExpiresAt).toLocaleDateString() : 'Unknown'}</dd>
                </dl>
              ) : (
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
                  <dt className="text-muted-foreground">{t('Redirect URI')}</dt>
                  <dd className="flex min-w-0 items-center gap-1">
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{provider.callbackUrl}</code>
                    <CopyButton value={provider.callbackUrl} />
                  </dd>
                  <dt className="text-muted-foreground">{t('Client ID')}</dt>
                  <dd className="truncate">{provider.clientId}</dd>
                </dl>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={KeyRound}
          title={t('No identity provider yet')}
          description={
            domains.data?.some((d) => d.status === 'active')
              ? 'Connect your company’s identity provider so people sign in with the account they already have.'
              : 'Verify a domain first; single sign-on is set up per domain.'
          }
        />
      )}
      {adding ? <ProviderDialog orgId={orgId} domains={available} onClose={() => setAdding(false)} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Disconnect the provider for ${removing?.domain ?? ''}?`}
        description={t('People on this domain sign in with their mailbox password again.')}
        confirmLabel={t('Disconnect')}
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`/orgs/${orgId}/sso/${removing.id}`);
          await queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'sso') });
        }}
      />
    </>
  );
}
