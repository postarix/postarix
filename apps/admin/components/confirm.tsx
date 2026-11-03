'use client';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@postarix/ui/components/alert-dialog';
import { type ReactNode, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';
import { t } from '@/lib/i18n';

/** shadcn AlertDialog for destructive actions; stays open and shows the error if the action fails. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <Notice>{error}</Notice> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('Cancel')}</AlertDialogCancel>
          <LoadingButton
            variant="destructive"
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setPending(false);
              }
            }}
          >
            {confirmLabel}
          </LoadingButton>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
