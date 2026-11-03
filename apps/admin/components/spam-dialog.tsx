'use client';

import { Button } from '@postarix/ui/components/button';
import { DialogFooter } from '@postarix/ui/components/dialog';
import { FieldGroup } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Separator } from '@postarix/ui/components/separator';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '@/lib/api';
import type { SpamScores } from '@/lib/types';
import { AppDialog } from './app-dialog';
import { FormField } from './form-field';
import { LoadingButton } from './loading-button';
import { Notice } from './notice';
import { SpamLists } from './spam-lists';

function scoreFrom(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error('Scores are positive numbers');
  return n;
}

/** Spam thresholds and allow/block lists of a domain or a mailbox. */
export function SpamDialog({
  title,
  inherited,
  scores,
  saveScores,
  lists,
  onClose,
}: {
  title: string;
  /** What an empty field means, e.g. "the domain's" or "the server's". */
  inherited: string;
  scores: SpamScores;
  saveScores: (scores: SpamScores) => Promise<void>;
  lists: Parameters<typeof SpamLists>[0];
  onClose: () => void;
}) {
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
      await saveScores({ junkScore: scoreFrom(data.get('junkScore')), rejectScore: scoreFrom(data.get('rejectScore')) });
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <AppDialog open onClose={onClose} title={title} description="Every message gets a spam score: the higher, the more likely spam.">
      <div className="space-y-5">
        <form onSubmit={submit}>
          <FieldGroup>
            {error ? <Notice>{error}</Notice> : null}
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Junk from score" hint={`Empty: ${inherited} (6 by default).`}>
                {(props) => <Input {...props} name="junkScore" inputMode="decimal" defaultValue={scores.junkScore ?? ''} />}
              </FormField>
              <FormField label="Refuse from score" hint={`Empty: ${inherited} (15 by default).`}>
                {(props) => <Input {...props} name="rejectScore" inputMode="decimal" defaultValue={scores.rejectScore ?? ''} />}
              </FormField>
            </div>
            <DialogFooter>
              {saved ? <span className="mr-auto self-center text-sm text-muted-foreground">Saved.</span> : null}
              <LoadingButton type="submit" variant="outline" loading={pending}>
                Save scores
              </LoadingButton>
            </DialogFooter>
          </FieldGroup>
        </form>
        <Separator />
        <SpamLists {...lists} />
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </div>
    </AppDialog>
  );
}
