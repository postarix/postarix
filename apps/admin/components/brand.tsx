import { Postmark } from '@postarix/ui/components/postmark';

/** The server's logo (System → Customize), or the Postarix stamp. */
export function BrandMark({ className = 'size-8', logo }: { className?: string; logo?: string | undefined }) {
  if (logo) {
    // A data: URL the instance administrator uploaded.
    return <img src={logo} alt="" className={`${className} object-contain`} />;
  }
  return <Postmark className={className} />;
}
