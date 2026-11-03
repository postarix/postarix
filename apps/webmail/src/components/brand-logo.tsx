import { Postmark } from '@postarix/ui/components/postmark';
import { cn } from '@postarix/ui/lib/utils';

/** The server's logo (set by its administrators), or the Postarix stamp. */
export function BrandLogo({ logo, className }: { logo?: string | undefined; className?: string }) {
  if (logo) return <img src={logo} alt="" className={cn('object-contain', className)} />;
  return <Postmark className={className} />;
}
