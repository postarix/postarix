'use client';

import { Button } from '@postarix/ui/components/button';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={`${label}: ${value.slice(0, 40)}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span className="sr-only sm:not-sr-only">{copied ? 'Copied' : label}</span>
    </Button>
  );
}
