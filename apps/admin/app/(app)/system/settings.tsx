'use client';

import { Checkbox } from '@postarix/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Textarea } from '@postarix/ui/components/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { api, errorMessage } from '@/lib/api';

interface InstanceSettings {
  signIn: { maxFailures: number; lockMinutes: number };
  passwords: { minLength: number; requireMixed: boolean };
  quota: { warnAtPercent: number };
  branding: { productName: string; loginMessage: string; announcement: string; supportUrl: string };
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

const int = (data: FormData, name: string) => Number(String(data.get(name) ?? '').trim());

/** Settings of the whole server: sign-in protection, passwords, quota warnings and branding. */
export function SettingsTab() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['system', 'settings'], queryFn: () => api.get<InstanceSettings>('/system/settings') });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await api.put('/system/settings', {
        signIn: { maxFailures: int(data, 'maxFailures'), lockMinutes: int(data, 'lockMinutes') },
        passwords: { minLength: int(data, 'minLength'), requireMixed: data.get('requireMixed') !== null },
        quota: { warnAtPercent: int(data, 'warnAtPercent') },
        branding: {
          productName: String(data.get('productName') ?? ''),
          loginMessage: String(data.get('loginMessage') ?? ''),
          announcement: String(data.get('announcement') ?? ''),
          supportUrl: String(data.get('supportUrl') ?? ''),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['system', 'settings'] });
      await queryClient.invalidateQueries({ queryKey: ['branding'] });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  if (settings.isLoading) return <Skeleton className="h-96 w-full rounded-xl" />;
  if (settings.error || !settings.data) return <Notice>{errorMessage(settings.error)}</Notice>;
  const s = settings.data;

  return (
    <form onSubmit={submit} className="max-w-2xl">
      <FieldGroup>
        {error ? <Notice>{error}</Notice> : null}
        <Section title="Sign-in protection" description="For the web and mail apps alike. App passwords are never locked.">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Failed passwords before locking">
              {(props) => <Input {...props} name="maxFailures" type="number" min={3} max={100} defaultValue={s.signIn.maxFailures} required />}
            </FormField>
            <FormField label="Locked for (minutes)">
              {(props) => <Input {...props} name="lockMinutes" type="number" min={1} max={1440} defaultValue={s.signIn.lockMinutes} required />}
            </FormField>
          </div>
        </Section>
        <Section title="Passwords" description="For new passwords: mailboxes created here, resets and changes.">
          <FormField label="Minimum length">
            {(props) => <Input {...props} name="minLength" type="number" min={12} max={128} defaultValue={s.passwords.minLength} required />}
          </FormField>
          <Field orientation="horizontal">
            <Checkbox id="requireMixed" name="requireMixed" defaultChecked={s.passwords.requireMixed} />
            <FieldLabel htmlFor="requireMixed" className="font-normal">
              Require three of: lowercase, uppercase, digits, symbols
            </FieldLabel>
          </Field>
        </Section>
        <Section title="Mailbox quota" description="People are told by mail when their mailbox fills up.">
          <FormField label="Warn when full at (percent)" hint="0: never.">
            {(props) => <Input {...props} name="warnAtPercent" type="number" min={0} max={100} defaultValue={s.quota.warnAtPercent} required />}
          </FormField>
        </Section>
        <Section title="Branding" description="What people see on the sign-in pages and while signed in.">
          <FormField label="Name">
            {(props) => <Input {...props} name="productName" defaultValue={s.branding.productName} maxLength={60} required />}
          </FormField>
          <FormField label="Sign-in message" hint="E.g. who to contact for help.">
            {(props) => <Textarea {...props} name="loginMessage" rows={2} defaultValue={s.branding.loginMessage} maxLength={500} />}
          </FormField>
          <FormField label="Announcement" hint="Shown to everyone signed in to the webmail and the admin panel. Empty: none.">
            {(props) => <Textarea {...props} name="announcement" rows={2} defaultValue={s.branding.announcement} maxLength={500} />}
          </FormField>
          <FormField label="Help page">
            {(props) => <Input {...props} name="supportUrl" type="url" defaultValue={s.branding.supportUrl} placeholder="https://" />}
          </FormField>
        </Section>
        <div className="flex items-center gap-3">
          <LoadingButton type="submit" loading={pending}>
            Save settings
          </LoadingButton>
          {saved ? <span className="text-sm text-muted-foreground">Saved. Every server applies it within a few seconds.</span> : null}
        </div>
      </FieldGroup>
    </form>
  );
}
