// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { fmt, langOf } from './lang.js';

describe('langOf', () => {
  it('is Dutch for nl and nl-BE, English for everything else', () => {
    expect(langOf('nl')).toBe('nl');
    expect(langOf('nl-BE')).toBe('nl');
    expect(langOf('NL-nl')).toBe('nl');
    expect(langOf('en-US')).toBe('en');
    expect(langOf('de')).toBe('en');
    expect(langOf(undefined)).toBe('en');
  });
});

describe('fmt', () => {
  it('uses the decimal sign of the language', () => {
    expect(fmt(1.234, 2, 'nl')).toBe('1,23');
    expect(fmt(1.234, 2, 'en')).toBe('1.23');
    expect(fmt(12, 0, 'nl')).toBe('12');
  });

  it('prints negative numbers with a hyphen-minus and never -0', () => {
    expect(fmt(-2.5, 1, 'nl')).toBe('-2,5');
    expect(fmt(-0.001, 1, 'en')).toBe('0.0');
    expect(fmt(-0, 0, 'nl')).toBe('0');
  });

  it('prints infinity as the infinity sign', () => {
    expect(fmt(Infinity, 1, 'en')).toBe('∞');
    expect(fmt(-Infinity, 1, 'en')).toBe('-∞');
  });
});
