// @wc-ignore-file
/** Language choice and number formatting shared by the three physics apps. */

export type Lang = 'nl' | 'en';

/** Dutch when the browser language starts with `nl`, English otherwise (as the other drive apps do). */
export const langOf = (language: string | undefined): Lang =>
  language?.toLowerCase().startsWith('nl') ? 'nl' : 'en';

/**
 * A number with a fixed count of decimals and the language's decimal sign.
 * Uses a plain hyphen-minus, never a dash character, and prints "0" for -0.
 */
export function fmt(x: number, digits: number, lang: Lang): string {
  if (Number.isNaN(x)) return '?';
  if (!Number.isFinite(x)) return x < 0 ? '-∞' : '∞';
  const text = x.toFixed(digits);
  const clean = /^-0(\.0*)?$/.test(text) ? text.slice(1) : text;

  return lang === 'nl' ? clean.replace('.', ',') : clean;
}
