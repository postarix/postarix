'use client';

import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
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

function ProviderDialog({ orgId, domains, onClose }: { orgId: string; domains: Domain[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/sso`, {
        domainId: String(data.get('domainId')),
        issuer: String(data.get('issuer')).trim(),
        clientId: String(data.get('clientId')),
        clientSecret: String(data.get('clientSecret')),
      });
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
      title="Connect an identity provider"
      description="Any OpenID Connect provider works: Microsoft Entra ID, Google Workspace, Okta, Keycloak, Authentik…"
    >
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label="Domain" hint="People with a mailbox on this domain sign in through the provider.">
            {(props) => (
              <NativeSelect {...props} name="domainId" required className="w-full">
                {domains.map((d) => (
                  <NativeSelectOption key={d.id} value={d.id}>
                    {d.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Issuer URL" hint="Postarix reads the rest from its /.well-known/openid-configuration.">
            {(props) => <Input {...props} name="issuer" type="url" required placeholder="https://login.example.com/realms/acme" />}
          </FormField>
          <FormField label="Client ID">{(props) => <Input {...props} name="clientId" required autoComplete="off" />}</FormField>
          <FormField label="Client secret" hint="Stored on the server and never shown again.">
            {(props) => <Input {...props} name="clientSecret" type="password" required autoComplete="off" />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <LoadingButton type="submit" loading={pending}>
              Connect provider
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
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
        title="Single sign-on"
        description="Let people sign in to webmail and this console with your company account. Mail apps keep using app passwords."
        actions={
          <Button onClick={() => setAdding(true)} disabled={available.length === 0}>
            <Plus aria-hidden />
            Connect provider
          </Button>
        }
      />
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
                  <h3 className="font-display text-lg font-semibold">{provider.domain}</h3>
                  <p className="truncate text-sm text-muted-foreground">{provider.issuer}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRemoving(provider)}>
                  <Trash2 aria-hidden />
                  Disconnect
                </Button>
              </div>
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Redirect URI</dt>
                <dd className="flex min-w-0 items-center gap-1">
                  <code className="truncate rounded bg-muted px-1.5 py-0.5 text-xs">{provider.callbackUrl}</code>
                  <CopyButton value={provider.callbackUrl} />
                </dd>
                <dt className="text-muted-foreground">Client ID</dt>
                <dd className="truncate">{provider.clientId}</dd>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={KeyRound}
          title="No identity provider yet"
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
        description="People on this domain sign in with their mailbox password again."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          if (!removing) return;
          await api.delete(`/orgs/${orgId}/sso/${removing.id}`);
          await queryClient.invalidateQueries({ queryKey: keys.orgPart(orgId, 'sso') });
        }}
      />
    </>
  );
}
