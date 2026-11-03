import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Item {
  id: string;
  envelopeFrom: string;
  fromHeader: string;
  subject: string;
  score: number;
  createdAt: string;
}

type Notify = 'never' | 'hourly' | 'daily' | 'weekly';

/** Mail the spam filter refused for the person: release it to the inbox, or delete it. */
export function QuarantineDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [notify, setNotify] = useState<Notify>('daily');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await api<{ data: Item[]; notify: Notify }>('/me/quarantine');
      setItems(data.data);
      setNotify(data.notify);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const act = async (id: string, release: boolean) => {
    setBusy(id);
    setError(null);
    try {
      await api(`/me/quarantine/${id}${release ? '/release' : ''}`, { method: release ? 'POST' : 'DELETE' });
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Quarantine')}</DialogTitle>
          <DialogDescription>{t('Mail the spam filter refused for you, kept for a few weeks. Release a message that is not spam to get it in your inbox.')}</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!items ? (
          error ? null : <Spinner />
        ) : items.length ? (
          <ul className="divide-y rounded-md border">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.subject || '(no subject)'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.fromHeader || item.envelopeFrom || '(no sender)'} · {new Date(item.createdAt).toLocaleString()}{' '}{t('· score')}{' '}
                    {item.score.toFixed(1)}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(item.id, true)}>
                  {busy === item.id ? <Spinner /> : null}{t('Release')}</Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${item.subject}`} disabled={busy !== null} onClick={() => void act(item.id, false)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('Nothing in quarantine.')}</p>
        )}
        <label className="flex items-center gap-3 text-sm">
          <span>{t('Tell me about new items')}</span>
          <FormSelect
            value={notify}
            onChange={async (e) => {
              const every = e.target.value as Notify;
              setNotify(every);
              try {
                await api('/me/quarantine/notify', { method: 'PUT', body: { every } });
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            <FormSelectOption value="never">{t('Never')}</FormSelectOption>
            <FormSelectOption value="hourly">{t('Hourly')}</FormSelectOption>
            <FormSelectOption value="daily">{t('Daily')}</FormSelectOption>
            <FormSelectOption value="weekly">{t('Weekly')}</FormSelectOption>
          </FormSelect>
        </label>
        <DialogFooter>
          <Button onClick={onClose}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
