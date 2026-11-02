'use client';

import { Button, Input } from '@postarix/ui';
import { Eye, EyeOff, Wand2 } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';

/** 20 random characters (~117 bits) from an unambiguous alphabet. */
export function generatePassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let out = '';
  for (const byte of bytes) {
    // Rejection sampling keeps the distribution uniform.
    if (byte < Math.floor(256 / ALPHABET.length) * ALPHABET.length) out += ALPHABET[byte % ALPHABET.length];
    if (out.length === length) break;
  }
  return out.length === length ? out : generatePassword(length);
}

export function PasswordInput({
  value,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex gap-2">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        minLength={12}
        maxLength={256}
        autoComplete="new-password"
        className="font-mono"
      />
      <Button variant="secondary" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible((v) => !v)}>
        {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </Button>
      <Button
        variant="secondary"
        aria-label="Generate password"
        onClick={() => {
          onChange(generatePassword());
          setVisible(true);
        }}
      >
        <Wand2 className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
