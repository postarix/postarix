import { Button } from '@postarix/ui/components/button';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { errorMessage, importFile } from '@/lib/api';

/**
 * Imports a file exported from another service (Google, Outlook, Apple):
 * events from an .ics file, or contacts from a .vcf file. Already-present
 * events and contacts are skipped.
 */
export function ImportButton({ kind, queryKey }: { kind: 'calendar' | 'contacts'; queryKey: readonly unknown[] }) {
  const input = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const noun = kind === 'calendar' ? 'event' : 'contact';

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await importFile(kind === 'calendar' ? '/calendar/import' : '/contacts/import', file);
      const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
      setStatus(`Imported ${plural(result.imported)}${result.skipped ? `; ${plural(result.skipped)} already there or skipped` : ''}.`);
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      setStatus(`Not imported: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={kind === 'calendar' ? '.ics,text/calendar' : '.vcf,text/vcard,text/x-vcard'}
        onChange={(e) => void upload(e.target.files?.[0])}
      />
      <Button
        variant="ghost"
        size="sm"
        className="justify-start text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden />
        {busy ? 'Importing…' : kind === 'calendar' ? 'Import events (.ics)' : 'Import contacts (.vcf)'}
      </Button>
      {status ? (
        <p role="status" className="px-1.5 text-xs leading-relaxed text-sidebar-muted">
          {status}
        </p>
      ) : null}
    </div>
  );
}
