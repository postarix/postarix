import { Badge } from '@postarix/ui/components/badge';
import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Entry {
  id: string;
  kind: 'allow' | 'block';
  pattern: string;
}

interface SpamSettings {
  junkScore: number | null;
  rejectScore: number | null;
  entries: Entry[];
}

function scoreFrom(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) throw new Error('Scores are positive numbers');
  return n;
}

/** The person's own spam thresholds and allowed or blocked senders. */
export function SpamDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<SpamSettings | null>(null);
  const [junk, setJunk] = useState('');
  const [reject, setReject] = useState('');
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<'allow' | 'block'>('block');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const data = await api<SpamSettings>('/me/spam');
      setSettings(data);
      setJunk(data.junkScore?.toString() ?? '');
      setReject(data.rejectScore?.toString() ?? '');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  async function saveScores(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api('/me/spam/scores', { method: 'PUT', body: { junkScore: scoreFrom(junk), rejectScore: scoreFrom(reject) } });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api('/me/spam/entries', { method: 'POST', body: { kind, pattern } });
      setPattern('');
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Spam filter')}</DialogTitle>
          <DialogDescription>{t('Every message gets a spam score: the higher, the more likely it is spam.')}</DialogDescription>
        </DialogHeader>
        {!settings ? (
          error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <Spinner />
          )
        ) : (
          <div className="space-y-5">
            <form onSubmit={saveScores} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-sm">
                  <span className="font-medium">{t('Junk from score')}</span>
                  <Input value={junk} onChange={(e) => setJunk(e.target.value)} inputMode="decimal" placeholder={t('Default')} />
                </label>
                <label className="space-y-1 text-sm">
                  <span className="font-medium">{t('Refuse from score')}</span>
                  <Input value={reject} onChange={(e) => setReject(e.target.value)} inputMode="decimal" placeholder={t('Default')} />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{t('Lower scores catch more spam, and more good mail by mistake. Empty: your organization\'s setting.')}</p>
              <div className="flex items-center justify-end gap-3">
                {saved ? <span className="text-sm text-muted-foreground">{t('Saved.')}</span> : null}
                <Button type="submit" variant="outline">{t('Save scores')}</Button>
              </div>
            </form>
            <div className="space-y-3">
              <p className="text-sm font-medium">{t('Senders')}</p>
              <p className="text-xs text-muted-foreground">{t('Blocked senders are refused. Allowed senders skip the spam filter, if their server proves who they are. Use an address or @domain.')}</p>
              <form onSubmit={add} className="flex flex-wrap gap-2">
                <NativeSelect aria-label={t('List')} value={kind} onChange={(e) => setKind(e.target.value as 'allow' | 'block')}>
                  <NativeSelectOption value="block">{t('Block')}</NativeSelectOption>
                  <NativeSelectOption value="allow">{t('Allow')}</NativeSelectOption>
                </NativeSelect>
                <Input aria-label={t('Sender')} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t('news@example.com')} className="min-w-48 flex-1" required />
                <Button type="submit" variant="outline">{t('Add')}</Button>
              </form>
              {settings.entries.length ? (
                <ul className="divide-y rounded-md border">
                  {settings.entries.map((entry) => (
                    <li key={entry.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                      <span className="flex items-center gap-2">
                        <Badge variant={entry.kind === 'allow' ? 'success' : 'destructive'}>{entry.kind === 'allow' ? 'Allow' : 'Block'}</Badge>
                        <span className="font-mono text-xs">{entry.pattern}</span>
                      </span>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${entry.pattern}`}
                        onClick={async () => {
                          try {
                            await api(`/me/spam/entries/${entry.id}`, { method: 'DELETE' });
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
                <p className="text-sm text-muted-foreground">{t('No senders listed.')}</p>
              )}
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
