import type { Contact } from '@postarix/jmap-client';
import { Button } from '@postarix/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@postarix/ui/components/dialog';
import { Field, FieldGroup, FieldLabel } from '@postarix/ui/components/field';
import { Input } from '@postarix/ui/components/input';
import { Spinner } from '@postarix/ui/components/spinner';
import { Textarea } from '@postarix/ui/components/textarea';
import { Plus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '@/lib/api';
import { type ContactInput, useSaveContact } from '@/lib/contacts';

const blank: ContactInput = { firstName: '', lastName: '', company: '', jobTitle: '', notes: '', emails: [{ type: 'personal', value: '' }], phones: [{ type: 'mobile', value: '' }] };

function ListField({
  label,
  type,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  type: 'email' | 'tel';
  items: { type: string; value: string }[];
  onChange: (items: { type: string; value: string }[]) => void;
  placeholder: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {items.map((item, index) => (
        <div key={index} className="flex gap-2">
          <Input
            type={type}
            aria-label={`${label} ${index + 1}`}
            value={item.value}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)))}
          />
          {items.length > 1 ? (
            <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onClick={() => onChange(items.filter((_, i) => i !== index))}>
              <X aria-hidden />
            </Button>
          ) : null}
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...items, { type: items[0]?.type ?? 'other', value: '' }])}>
        <Plus aria-hidden />
        Add another
      </Button>
    </fieldset>
  );
}

export function ContactDialog({ contact, onClose, onSaved }: { contact: Contact | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [input, setInput] = useState<ContactInput>(() =>
    contact
      ? {
          firstName: contact.firstName,
          lastName: contact.lastName,
          company: contact.company,
          jobTitle: contact.jobTitle,
          notes: contact.notes,
          emails: contact.emails.length ? contact.emails : blank.emails,
          phones: contact.phones.length ? contact.phones : blank.phones,
        }
      : blank,
  );
  const [error, setError] = useState<string | null>(null);
  const save = useSaveContact();
  const set = (patch: Partial<ContactInput>) => setInput((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.firstName.trim() && !input.lastName.trim() && !input.company.trim() && !input.emails.some((e) => e.value.trim())) {
      return setError('Give the contact a name, a company or an email address.');
    }
    setError(null);
    try {
      onSaved(await save.mutateAsync({ id: contact?.id ?? null, input }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">{contact ? 'Edit contact' : 'New contact'}</DialogTitle>
          <DialogDescription className="sr-only">Contact details</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="contact-first">First name</FieldLabel>
                <Input id="contact-first" value={input.firstName} onChange={(e) => set({ firstName: e.target.value })} autoFocus />
              </Field>
              <Field>
                <FieldLabel htmlFor="contact-last">Last name</FieldLabel>
                <Input id="contact-last" value={input.lastName} onChange={(e) => set({ lastName: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="contact-company">Company</FieldLabel>
                <Input id="contact-company" value={input.company} onChange={(e) => set({ company: e.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="contact-title">Job title</FieldLabel>
                <Input id="contact-title" value={input.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} />
              </Field>
            </div>
            <ListField label="Email" type="email" items={input.emails} onChange={(emails) => set({ emails })} placeholder="name@example.com" />
            <ListField label="Phone" type="tel" items={input.phones} onChange={(phones) => set({ phones })} placeholder="+57 300 000 0000" />
            <Field>
              <FieldLabel htmlFor="contact-notes">Notes</FieldLabel>
              <Textarea id="contact-notes" rows={3} value={input.notes} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Spinner /> : null}
                Save contact
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
