import { Card } from '@postarix/ui/components/card';
import { Table } from '@postarix/ui/components/table';
import type { ReactNode } from 'react';

/** A shadcn Table inside a card, for the resource lists. */
export function ListTable({ children }: { children: ReactNode }) {
  return (
    <Card className="py-0">
      <Table>{children}</Table>
    </Card>
  );
}
