import { Input } from '@postarix/ui/components/input';
import { FormSelect, FormSelectOption } from '@postarix/ui/components/select';
import type { Domain } from '@/lib/types';
import { FormField } from './form-field';
import { t } from '@/lib/i18n';

/** "local part @ domain" inputs, for new mailboxes and aliases. */
export function AddressFields({
  domains,
  placeholder,
  anyAddress = false,
}: {
  domains: Domain[];
  placeholder: string;
  /** Every address of the domain (a catch-all): the local part is left empty. */
  anyAddress?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
      <FormField label={t('Address')}>
        {(props) =>
          anyAddress ? (
            <Input {...props} name="localPart" value="" placeholder={t('any address')} disabled />
          ) : (
            <Input {...props} name="localPart" placeholder={placeholder} required autoFocus />
          )
        }
      </FormField>
      <span className="pb-2 text-muted-foreground">@</span>
      <FormField label={t('Domain')}>
        {(props) => (
          <FormSelect {...props} name="domainId" required>
            {domains.map((d) => (
              <FormSelectOption key={d.id} value={d.id}>
                {d.name}
              </FormSelectOption>
            ))}
          </FormSelect>
        )}
      </FormField>
    </div>
  );
}
