import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Copy, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

interface TemporaryAddress {
  id: string;
  address: string;
  note: string;
  expiresAt: string;
}

const LIFETIMES = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '1 week' },
  { hours: 24 * 30, label: '1 month' },
  { hours: 24 * 365, label: '1 year' },
];

/** Throwaway addresses that deliver to the person's mailbox until they expire. */
export function TemporaryAddressesDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<TemporaryAddress[] | null>(null);
  const [hours, setHours] = useState(24 * 7);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setList((await api<{ data: TemporaryAddress[] }>('/me/temporary-addresses')).data);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api('/me/temporary-addresses', { method: 'POST', body: { hours, note } });
      setNote('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Temporary addresses')}</DialogTitle>
          <DialogDescription>
            {t('Give a shop or a newsletter an address of its own: mail to it reaches you until it expires, and then it stops working.')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={create} className="flex flex-wrap gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('What for (optional)')} className="min-w-40 flex-1" maxLength={100} />
          <NativeSelect aria-label={t('Works for')} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {LIFETIMES.map((l) => (
              <NativeSelectOption key={l.hours} value={l.hours}>
                {t(l.label)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="submit">{t('Create')}</Button>
        </form>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!list ? (
          error ? null : <Spinner />
        ) : list.length ? (
          <ul className="divide-y rounded-md border">
            {list.map((item) => (
              <li key={item.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{item.address}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.note ? `${item.note} · ` : ''}
                    {t('until {date}', { date: new Date(item.expiresAt).toLocaleString() })}
                  </p>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={t('Copy')} onClick={() => void navigator.clipboard.writeText(item.address)}>
                  <Copy aria-hidden />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('Delete')}
                  onClick={async () => {
                    try {
                      await api(`/me/temporary-addresses/${item.id}`, { method: 'DELETE' });
                      await load();
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t('None yet.')}</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
