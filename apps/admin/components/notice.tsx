import { Alert, AlertDescription, AlertTitle } from '@postarix/ui/components/alert';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

const icons = { destructive: CircleAlert, success: CircleCheck, warning: TriangleAlert } as const;

/** A shadcn Alert with the icon that matches its tone. */
export function Notice({
  tone = 'destructive',
  title,
  children,
}: {
  tone?: keyof typeof icons;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const Icon = icons[tone];
  return (
    <Alert variant={tone}>
      <Icon aria-hidden />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? <AlertDescription>{children}</AlertDescription> : null}
    </Alert>
  );
}
