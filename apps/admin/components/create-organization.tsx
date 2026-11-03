'use client';

import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { FormField } from '@/components/form-field';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { authClient } from '@/lib/auth-client';
import { t } from '@/lib/i18n';
import { keys } from '@/lib/queries';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function CreateOrganizationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    setPending(true);
    setError(null);
    const { data, error: createError } = await authClient.organization.create({
      name,
      slug: `${slugify(name) || 'org'}-${crypto.randomUUID().slice(0, 6)}`,
      keepCurrentActiveOrganization: true,
    });
    setPending(false);
    if (createError || !data) return setError(createError?.message ?? 'Could not create the organization');
    await queryClient.invalidateQueries({ queryKey: keys.myOrgs });
    await queryClient.invalidateQueries({ queryKey: keys.allOrgs });
    onClose();
    router.push(`/o/${data.id}`);
  }

  return (
    <AppDialog open={open} onClose={onClose} title={t('New organization')} description={t('A company, a family or a single person.')}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          <FormField label={t('Name')}>{(props) => <Input {...props} name="name" required maxLength={100} autoFocus />}</FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t('Cancel')}</Button>
            <LoadingButton type="submit" loading={pending}>{t('Create')}</LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}
