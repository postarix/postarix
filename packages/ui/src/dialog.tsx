import { type ReactNode, useEffect, useRef } from 'react';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Modal dialog on top of the native <dialog> element (focus trap, Esc, backdrop). */
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-[var(--radius-card)] border border-border bg-surface p-0 text-ink shadow-xl',
        'backdrop:bg-black/40 backdrop:backdrop-blur-[1px]',
        className,
      )}
    >
      {open ? (
        <div className="p-6">
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
