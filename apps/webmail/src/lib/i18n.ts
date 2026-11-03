import es from './i18n-es';

/**
 * Interface languages. Texts are written in English in the code and looked
 * up in the other languages' dictionaries (English text → translation);
 * anything missing stays in English. The choice is a cookie shared by the
 * admin panel and the webmail; changing it reloads the page.
 */
export const languages = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const;
export type Language = (typeof languages)[number]['code'];

export const LANGUAGE_COOKIE = 'postarix-lang';

const dictionaries: Record<Language, Record<string, string>> = { en: {}, es };

function detect(): Language {
  if (typeof document === 'undefined') return 'en';
  const cookie = document.cookie.match(new RegExp(`(?:^|; )${LANGUAGE_COOKIE}=(\\w+)`))?.[1];
  if (cookie === 'en' || cookie === 'es') return cookie;
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** The language of this page (read once when the app loads). */
export const language: Language = detect();

/** The text in the current language; "{name}" placeholders take `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const translated = dictionaries[language][text] ?? text;
  return vars ? translated.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match)) : translated;
}

export function setLanguage(next: Language): void {
  document.cookie = `${LANGUAGE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}
