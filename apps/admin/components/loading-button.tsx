import { Button } from '@postarix/ui/components/button';
import { Spinner } from '@postarix/ui/components/spinner';
import type { ComponentProps } from 'react';

/** shadcn Button that shows a spinner and is disabled while an action runs. */
export function LoadingButton({
  loading = false,
  disabled,
  children,
  ...props
}: ComponentProps<typeof Button> & { loading?: boolean }) {
  return (
    <Button disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <Spinner /> : null}
      {children}
    </Button>
  );
}
