'use client';

import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@postarix/ui/components/card';
import { Skeleton } from '@postarix/ui/components/skeleton';
import { Switch } from '@postarix/ui/components/switch';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { AppDialog } from '@/components/app-dialog';
import { ConfirmDialog } from '@/components/confirm';
import { LoadingButton } from '@/components/loading-button';
import { Notice } from '@/components/notice';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

/** A list under /api/system/<path>, and a way to reload it. */
export function useSystemList<T>(path: string) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['system', path], queryFn: () => api.get<{ data: T[] }>(`/system/${path}`).then((r) => r.data) });
  return { ...query, refresh: () => queryClient.invalidateQueries({ queryKey: ['system', path] }) };
}

/** Turns an entry on or off (PATCH { enabled }). */
export function EnabledSwitch({ url, enabled, label, onDone }: { url: string; enabled: boolean; label: string; onDone: () => unknown }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2" title={error ?? undefined}>
      <Switch
        checked={enabled}
        disabled={pending}
        aria-label={label}
        onCheckedChange={async (value) => {
          setPending(true);
          setError(null);
          try {
            await api.patch(url, { enabled: value });
            await onDone();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      />
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

/** A delete button that asks first. */
export function RemoveButton({ url, title, description, onDone }: { url: string; title: string; description?: string; onDone: () => unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={t('Delete')} onClick={() => setOpen(true)}>
        <Trash2 aria-hidden />
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description ?? ''}
        onConfirm={async () => {
          await api.delete(url);
          await onDone();
        }}
      />
    </>
  );
}

/** A card holding a list: its loading, error and empty states. */
export function ListCard<T>({
  title,
  description,
  action,
  query,
  empty,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  query: { isLoading: boolean; error: unknown; data?: T[] | undefined };
  empty: ReactNode;
  children: (rows: T[]) => ReactNode;
}) {
  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription className="max-w-2xl">{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className="px-0">
        {query.isLoading ? (
          <Skeleton className="mx-6 h-24" />
        ) : query.error ? (
          <div className="px-6">
            <Notice>{errorMessage(query.error)}</Notice>
          </div>
        ) : query.data?.length ? (
          children(query.data)
        ) : (
          <p className="px-6 text-sm text-muted-foreground">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** A dialog with a form; it closes when `onSubmit` succeeds and shows its error otherwise. */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  onSubmit: (data: FormData) => Promise<unknown>;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(new FormData(event.currentTarget));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }
  if (!open) return null;
  return (
    <AppDialog open onClose={onClose} title={title} {...(description ? { description } : {})}>
      <form onSubmit={submit}>
        <FieldGroup>
          {error ? <Notice>{error}</Notice> : null}
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <LoadingButton type="submit" loading={pending}>
              {submitLabel}
            </LoadingButton>
          </DialogFooter>
        </FieldGroup>
      </form>
    </AppDialog>
  );
}
