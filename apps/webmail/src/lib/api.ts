/** Calls to the Postarix API's own (non-JMAP) mail endpoints. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new ApiError(response.status, typeof data.message === 'string' ? data.message : response.statusText);
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

/** Sends a calendar (.ics) or contacts (.vcf) file to one of the API's import routes. */
export async function importFile(path: '/calendar/import' | '/contacts/import', file: File): Promise<ImportResult> {
  if (file.size > 10 * 1024 * 1024) throw new ApiError(413, 'The file is larger than 10 MB');
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': path === '/calendar/import' ? 'text/calendar' : 'text/vcard' },
    body: await file.text(),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) throw new ApiError(response.status, typeof data.message === 'string' ? data.message : response.statusText);
  return data as unknown as ImportResult;
}
