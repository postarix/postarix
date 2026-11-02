import { Input } from '@postarix/ui/components/input';
import { cn } from '@postarix/ui/lib/utils';
import { useId, useMemo, useState } from 'react';
import { contactName, useContacts } from '@/lib/contacts';
import { formatRecipient, splitRecipients } from '@/lib/format';
import { Avatar } from './avatar';

/**
 * A comma-separated address field that suggests contacts for the address
 * being typed (arrow keys and Enter, or click).
 */
export function RecipientInput({
  id,
  value,
  onChange,
  autoFocus,
  placeholder,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** Classes for the text field. */
  className?: string;
}) {
  const contacts = useContacts();
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);

  const token = splitRecipients(value).at(-1)!.trim().toLocaleLowerCase();
  const suggestions = useMemo(() => {
    if (token.length < 2) return [];
    const already = new Set(value.toLocaleLowerCase().split(/[,;<>\s]+/));
    const out: { name: string; email: string }[] = [];
    for (const contact of contacts.data ?? []) {
      const name = contactName(contact);
      for (const e of contact.emails) {
        if (already.has(e.value.toLocaleLowerCase())) continue;
        if (name.toLocaleLowerCase().includes(token) || e.value.toLocaleLowerCase().includes(token)) out.push({ name, email: e.value });
      }
      if (out.length >= 6) break;
    }
    return out;
  }, [contacts.data, token, value]);
  const open = focused && suggestions.length > 0;

  const pick = (s: { name: string; email: string }) => {
    const parts = splitRecipients(value);
    parts[parts.length - 1] = ` ${formatRecipient(s.name, s.email)}`;
    onChange(`${parts.join(',').replace(/^\s+/, '')}, `);
    setActive(0);
  };

  return (
    <div className="relative flex-1">
      <Input
        id={id}
        className={className}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            pick(suggestions[active]!);
          } else if (e.key === 'Escape') {
            setFocused(false);
          }
        }}
      />
      {open ? (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg">
          {suggestions.map((s, i) => (
            <li
              key={s.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5', i === active && 'bg-accent')}
            >
              <Avatar name={s.name} email={s.email} className="size-7 text-[0.65rem]" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{s.email}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
