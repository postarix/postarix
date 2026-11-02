import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { useLabels, useMailboxes } from '@/lib/mail';
import { type MailFilter, useMailSettings, useSaveMailSettings } from '@/lib/mail-settings';

const FIELDS: { value: MailFilter['field']; label: string }[] = [
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To or Cc' },
  { value: 'subject', label: 'Subject' },
];
const ACTIONS: { value: MailFilter['action']; label: string }[] = [
  { value: 'move', label: 'Move to folder' },
  { value: 'label', label: 'Add label' },
  { value: 'markRead', label: 'Mark as read' },
  { value: 'delete', label: 'Move to Trash' },
];

/** Rules for arriving mail, kept on the mail server for this mailbox. */
export function FiltersDialog({ onClose }: { onClose: () => void }) {
  const current = useMailSettings(true);
  const save = useSaveMailSettings();
  const mailboxes = useMailboxes();
  const labels = useLabels();
  const [filters, setFilters] = useState<MailFilter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (current.data) setFilters(current.data.filters ?? []);
  }, [current.data]);

  // Folders a filter can move mail to (their full names, as Sieve uses them).
  const folders = (mailboxes.data ?? []).filter((m) => m.role !== 'drafts' && m.role !== 'trash' && m.role !== 'inbox').map((m) => m.name);
  const change = (index: number, patch: Partial<MailFilter>) => setFilters((list) => list.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const cleaned = filters.map((f) => ({
      field: f.field,
      contains: f.contains.trim(),
      action: f.action,
      ...(f.action === 'move' ? { folder: f.folder } : {}),
      ...(f.action === 'label' ? { keyword: f.keyword } : {}),
    }));
    if (cleaned.some((f) => !f.contains)) return setError('Each filter needs some text to look for.');
    if (cleaned.some((f) => (f.action === 'move' && !f.folder) || (f.action === 'label' && !f.keyword))) return setError('Choose a folder or label for each filter.');
    if (!current.data) return;
    setError(null);
    try {
      await save.mutateAsync({ filters: cleaned, vacation: current.data.vacation, forwarding: current.data.forwarding });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Filters</DialogTitle>
          <DialogDescription>Sort arriving mail automatically. Only the first matching move applies.</DialogDescription>
        </DialogHeader>
        {current.isPending ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {filters.length === 0 ? <p className="rounded-md bg-muted px-3 py-6 text-center text-sm text-muted-foreground">No filters yet.</p> : null}
            <ol className="space-y-2" aria-label="Filters">
              {filters.map((filter, index) => (
                <li key={index} className="grid items-center gap-2 rounded-lg border p-2 sm:grid-cols-[8rem_1fr_10rem_10rem_auto]">
                  <NativeSelect aria-label={`Filter ${index + 1}: field`} value={filter.field} onChange={(e) => change(index, { field: e.target.value as MailFilter['field'] })}>
                    {FIELDS.map((f) => (
                      <NativeSelectOption key={f.value} value={f.value}>
                        {f.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Input aria-label={`Filter ${index + 1}: contains`} placeholder="contains…" value={filter.contains} maxLength={200} onChange={(e) => change(index, { contains: e.target.value })} />
                  <NativeSelect aria-label={`Filter ${index + 1}: action`} value={filter.action} onChange={(e) => change(index, { action: e.target.value as MailFilter['action'] })}>
                    {ACTIONS.map((a) => (
                      <NativeSelectOption key={a.value} value={a.value}>
                        {a.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {filter.action === 'move' ? (
                    <NativeSelect aria-label={`Filter ${index + 1}: folder`} value={filter.folder ?? ''} onChange={(e) => change(index, { folder: e.target.value })}>
                      <NativeSelectOption value="">Folder…</NativeSelectOption>
                      {folders.map((name) => (
                        <NativeSelectOption key={name} value={name}>
                          {name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : filter.action === 'label' ? (
                    <NativeSelect aria-label={`Filter ${index + 1}: label`} value={filter.keyword ?? ''} onChange={(e) => change(index, { keyword: e.target.value })}>
                      <NativeSelectOption value="">Label…</NativeSelectOption>
                      {(labels.data ?? []).map((l) => (
                        <NativeSelectOption key={l.keyword} value={l.keyword}>
                          {l.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    <span />
                  )}
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove filter ${index + 1}`} onClick={() => setFilters((list) => list.filter((_, i) => i !== index))}>
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
            <Button type="button" variant="outline" size="sm" disabled={filters.length >= 50} onClick={() => setFilters((list) => [...list, { field: 'from', contains: '', action: 'move' }])}>
              <Plus aria-hidden />
              Add filter
            </Button>
            {current.data?.otherFiltersActive ? (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">Filters set up in a mail app are active. Saving here turns them off.</p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : saved ? (
              <p role="status" className="text-sm text-muted-foreground">
                Saved.
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Spinner /> : null}
                Save filters
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
