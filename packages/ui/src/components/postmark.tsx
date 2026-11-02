import { useId } from 'react';
import { cn } from '../lib/utils';

/**
 * The Postarix mark: a postage stamp (perforated edge, postal yellow) carrying
 * an ink "P". Pure SVG, scales with its font size via `className` (size-*).
 */
export function Postmark({ className, title = 'Postarix' }: { className?: string; title?: string }) {
  const id = useId();
  const holes: { cx: number; cy: number }[] = [];
  for (let i = 0; i <= 6; i++) {
    const p = 2 + i * (36 / 6);
    holes.push({ cx: p, cy: 2 }, { cx: p, cy: 38 }, { cx: 2, cy: p }, { cx: 38, cy: p });
  }
  return (
    <svg viewBox="0 0 40 40" role="img" aria-label={title} className={cn('size-8 shrink-0', className)}>
      <defs>
        <mask id={`${id}-perforation`}>
          <rect width="40" height="40" fill="white" />
          {holes.map((h, i) => (
            <circle key={i} cx={h.cx} cy={h.cy} r="1.9" fill="black" />
          ))}
        </mask>
      </defs>
      <rect width="40" height="40" rx="2" fill="var(--stamp)" mask={`url(#${id}-perforation)`} />
      <rect x="6.5" y="6.5" width="27" height="27" rx="1.5" fill="none" stroke="var(--stamp-foreground)" strokeOpacity="0.35" strokeWidth="1" />
      {/* The P: a stem and a bowl, drawn like an envelope flap folding over. */}
      <path d="M14 29V11h7.2a5.6 5.6 0 0 1 0 11.2H14" fill="none" stroke="var(--stamp-foreground)" strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
