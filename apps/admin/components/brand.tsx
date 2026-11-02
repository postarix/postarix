import { Mail } from 'lucide-react';

export function BrandMark({ className = 'size-8' }: { className?: string }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground ${className}`}>
      <Mail className="size-[55%]" aria-hidden />
    </span>
  );
}
