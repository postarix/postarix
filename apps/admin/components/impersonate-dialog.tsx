'use client';

import { Textarea } from '@postarix/ui/components/textarea';
import { FormField } from '@/components/form-field';
import { Notice } from '@/components/notice';
import { FormDialog } from '@/components/system/policy';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

/** "Sign in as": opens the mailbox in the webmail as its owner, for an hour, with a reason that is recorded. */
export function ImpersonateDialog({ orgId, mailbox, onClose }: { orgId: string; mailbox: { id: string; address: string }; onClose: () => void }) {
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('Sign in as {address}').replace('{address}', mailbox.address)}
      description={t('You will see the webmail exactly as its owner does, for up to an hour. You cannot change the account’s password or security.')}
      submitLabel={t('Sign in as')}
      onSubmit={async (data) => {
        await api.post(`/orgs/${orgId}/mailboxes/${mailbox.id}/impersonate`, { reason: String(data.get('reason') ?? '') });
        window.location.assign('/');
      }}
    >
      <Notice tone="warning">
        {t('Reading someone’s mail may require a legitimate reason, and informing them beforehand, under your company’s policy and the law where you work. This access is recorded with your reason, and the organization’s administrators can see it.')}
      </Notice>
      <FormField label={t('Reason')} hint={t('Recorded in the activity log, e.g. "Pending invoices while Ana is on leave".')}>
        {(props) => <Textarea {...props} name="reason" required minLength={5} maxLength={500} rows={3} />}
      </FormField>
    </FormDialog>
  );
}
