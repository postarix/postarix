import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId } from 'react';
import { cn } from './cn';

const control =
  'w-full rounded-[var(--radius-control)] border border-border bg-surface px-3 text-sm text-ink ' +
  'placeholder:text-ink-muted/70 transition-colors focus:border-accent focus:outline-none ' +
  'disabled:opacity-60 aria-[invalid=true]:border-danger';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, 'h-10', className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, 'h-10 pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (props: { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => ReactNode;
}

/** Label + control + hint/error, wired for accessibility. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children({
        id,
        ...(error ? { 'aria-invalid': true } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
