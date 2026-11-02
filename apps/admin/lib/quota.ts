const GIB = 1024 ** 3;

/** Converts a GiB text field to bytes; empty means unlimited. */
export function quotaFromGiB(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const gib = Number(trimmed);
  if (!Number.isFinite(gib) || gib <= 0) throw new Error('Quota must be a positive number of GB');
  return Math.round(gib * GIB);
}

export function quotaToGiB(bytes: number | null): string {
  return bytes === null ? '' : String(Number((bytes / GIB).toFixed(2)));
}
