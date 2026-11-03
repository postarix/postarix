'use client';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import type { ReactNode } from 'react';

/** A controlled shadcn Dialog with a title and optional description. */
export function AppDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {/* Radix warns without a description; an empty one keeps it quiet. */}
          <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? title}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
