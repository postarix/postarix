import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import type { Domain } from '@/lib/types';
import { FormField } from './form-field';

/** "local part @ domain" inputs, for new mailboxes and aliases. */
export function AddressFields({ domains, placeholder }: { domains: Domain[]; placeholder: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
      <FormField label="Address">{(props) => <Input {...props} name="localPart" placeholder={placeholder} required autoFocus />}</FormField>
      <span className="pb-2 text-muted-foreground">@</span>
      <FormField label="Domain">
        {(props) => (
          <NativeSelect {...props} name="domainId" required>
            {domains.map((d) => (
              <NativeSelectOption key={d.id} value={d.id}>
                {d.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </FormField>
    </div>
  );
}
