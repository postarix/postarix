import { Input } from '@postarix/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@postarix/ui/components/native-select';
import type { RateLimit } from '@/lib/types';
import { FormField } from './form-field';

const periods: { value: RateLimit['per']; label: string }[] = [
  { value: 'second', label: 'per second' },
  { value: 'minute', label: 'per minute' },
  { value: 'hour', label: 'per hour' },
  { value: 'day', label: 'per day' },
];

/** "N messages per period" inputs; read them back with rateLimitFrom(). */
export function RateLimitField({ label, hint, value }: { label: string; hint: string; value: RateLimit | null }) {
  return (
    <FormField label={label} hint={hint}>
      {(props) => (
        <div className="flex gap-2">
          <Input {...props} name="rateMessages" inputMode="numeric" placeholder="No limit" defaultValue={value?.messages ?? ''} />
          <NativeSelect name="ratePer" defaultValue={value?.per ?? 'hour'} aria-label={`${label}: period`}>
            {periods.map((p) => (
              <NativeSelectOption key={p.value} value={p.value}>
                {p.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
    </FormField>
  );
}

export function rateLimitFrom(data: FormData): RateLimit | null {
  const text = String(data.get('rateMessages') ?? '').trim();
  if (text === '') return null;
  const messages = Number(text);
  if (!Number.isInteger(messages) || messages < 1) throw new Error('The sending limit must be a whole number of messages');
  return { messages, per: String(data.get('ratePer')) as RateLimit['per'] };
}
