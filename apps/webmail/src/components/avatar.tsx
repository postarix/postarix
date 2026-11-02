import { cn } from '@postarix/ui/lib/utils';

/** Tints derived from the post palette; picked by a hash of the address so a person keeps their colour. */
const TINTS = [
  'bg-[#dfe6f7] text-[#1e2a52]',
  'bg-[#fff0bf] text-[#5c4300]',
  'bg-[#f6dcda] text-[#7a1f1a]',
  'bg-[#d9efe4] text-[#14533a]',
  'bg-[#e8e0f5] text-[#3f2a6b]',
  'bg-[#dcecf4] text-[#174a63]',
];

function hash(value: string): number {
  let h = 0;
  for (const char of value) h = (h * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function initials(name: string): string {
  const words = name.replace(/[<>"@].*$/, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return name.slice(0, 1).toUpperCase() || '?';
  return ((words[0]![0] ?? '') + (words.length > 1 ? (words.at(-1)![0] ?? '') : '')).toUpperCase();
}

export function Avatar({ name, email, className }: { name: string; email: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold', TINTS[hash(email.toLowerCase()) % TINTS.length], className)}
    >
      {initials(name || email)}
    </span>
  );
}
