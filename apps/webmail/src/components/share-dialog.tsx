import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import { Spinner } from '@postarix/ui/components/spinner';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { type ShareAccess, useSetSharing, useSharing } from '@/lib/calendar';

/**
 * Who a calendar or the contacts are shared with. Only people in the same
 * organization can be added; the server checks it.
 */
export function ShareDialog({ kind, id, onClose }: { kind: 'calendars' | 'address-books'; id: string; onClose: () => void }) {
  const sharing = useSharing();
  const save = useSetSharing();
  const collection = (kind === 'calendars' ? sharing.data?.calendars : sharing.data?.addressBooks)?.find((c) => c.id === id);
  const [shares, setShares] = useState<{ email: string; access: ShareAccess }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (collection) setShares(collection.shares);
  }, [collection]);

  const change = (index: number, patch: Partial<{ email: string; access: ShareAccess }>) =>
    setShares((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const what = kind === 'calendars' ? `the calendar “${collection?.name ?? ''}”` : 'your contacts';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    const cleaned = shares.map((s) => ({ email: s.email.trim().toLowerCase(), access: s.access })).filter((s) => s.email);
    setError(null);
    try {
      const result = await save.mutateAsync({ kind, id, shares: cleaned });
      setShares(result.shares);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">{kind === 'calendars' ? 'Share calendar' : 'Share contacts'}</DialogTitle>
          <DialogDescription>People in your organization you add here can see {what}. Those who can edit may also change it.</DialogDescription>
        </DialogHeader>
        {sharing.isPending ? (
          <Spinner />
        ) : (
          <form onSubmit={submit} className="grid gap-3">
            {shares.length === 0 ? <p className="text-sm text-muted-foreground">Not shared with anyone.</p> : null}
            <ul className="grid gap-2" aria-label="People">
              {shares.map((share, index) => (
                <li key={index} className="flex items-center gap-2">
                  <Input
                    type="email"
                    aria-label={`Person ${index + 1}`}
                    placeholder="colleague@example.com"
                    value={share.email}
                    onChange={(e) => change(index, { email: e.target.value })}
                    required
                  />
                  <NativeSelect
                    aria-label={`Access for person ${index + 1}`}
                    value={share.access}
                    onChange={(e) => change(index, { access: e.target.value as ShareAccess })}
                  >
                    <NativeSelectOption value="read">Can see</NativeSelectOption>
                    <NativeSelectOption value="write">Can edit</NativeSelectOption>
                  </NativeSelect>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Stop sharing with person ${index + 1}`}
                    onClick={() => setShares((list) => list.filter((_, i) => i !== index))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setShares((list) => [...list, { email: '', access: 'read' }])}>
                <Plus aria-hidden />
                Add person
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : saved ? (
              <p role="status" className="text-sm text-muted-foreground">
                Sharing saved.
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button type="submit" disabled={save.isPending || !collection}>
                {save.isPending ? <Spinner /> : null}
                Save sharing
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
