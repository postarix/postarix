import { cn } from '../lib/utils';

/**
 * The Postarix mark: an envelope folded from a yellow tile, in ink. Pure SVG;
 * size it with `className` (size-*).
 */
export function Postmark({ className, title = 'Postarix' }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 32 32" role="img" aria-label={title} className={cn('size-8 shrink-0', className)}>
      <rect width="32" height="32" rx="8" fill="var(--stamp)" />
      <rect x="7" y="10" width="18" height="13" rx="2.5" fill="none" stroke="var(--stamp-foreground)" strokeWidth="2.2" />
      <path d="M8 11.5l8 6 8-6" fill="none" stroke="var(--stamp-foreground)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
