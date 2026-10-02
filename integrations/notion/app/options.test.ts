// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  EMPTY_INDEX,
  hostOptionValue,
  indexTags,
  lensOptionValue,
  optionColour,
  optionIds,
  optionSlug,
} from './options.js';

const index = indexTags([
  {
    subject: 'atomic:t1',
    id: 'o1',
    name: 'Done',
    color: '#x',
    shortname: 'done',
  },
  {
    subject: 'atomic:t2',
    id: 'o2',
    name: 'Docs',
    color: '#x',
    shortname: 'docs',
  },
]);

describe('option tags', () => {
  it('slugs the option name for the Tag shortname, with a fallback on the id', () => {
    expect(optionSlug('In progress', 'x')).toBe('in-progress');
    expect(optionSlug('Café  déjà-vu!', 'x')).toBe('cafe-deja-vu');
    expect(optionSlug('日本語', 'b1f5-0001')).toBe('option-b1f5-0001');
    expect(optionSlug('', '')).toBe('option-untitled');
  });

  it('maps Notion’s colour names to a hex, default for the unknown', () => {
    expect(optionColour('blue')).toMatch(/^#[0-9A-F]{6}$/);
    expect(optionColour('gray')).toBe(optionColour('default'));
    expect(optionColour('teal')).toBe(optionColour('default'));
  });
});

describe('option codec (host cell <-> lens value)', () => {
  it('reads Tag subjects as option ids, and a raw id (a 0.3.0 cell) as itself', () => {
    expect(optionIds(['atomic:t2', 'atomic:t1'], index)).toEqual(['o2', 'o1']);
    expect(optionIds('o3', index)).toEqual(['o3']);
    expect(optionIds(['atomic:t1', 'o3'], index)).toEqual(['o1', 'o3']);
    expect(optionIds(undefined, index)).toEqual([]);
    expect(optionIds('', index)).toEqual([]);
    expect(optionIds(['atomic:t1', 7, null], index)).toEqual(['o1']);
  });

  it('gives a single-option column one id, or the list when the cell holds more', () => {
    expect(lensOptionValue('single', ['atomic:t1'], index)).toBe('o1');
    expect(lensOptionValue('single', [], index)).toBeUndefined();
    expect(
      lensOptionValue('single', ['atomic:t1', 'atomic:t2'], index),
    ).toEqual(['o1', 'o2']);
    expect(lensOptionValue('multiple', ['atomic:t1'], index)).toEqual(['o1']);
    expect(lensOptionValue('multiple', undefined, index)).toEqual([]);
  });

  it('writes option ids as Tag subjects, keeps a multi-select’s empty list, and refuses an id without a Tag', () => {
    expect(hostOptionValue('o1', index)).toEqual(['atomic:t1']);
    expect(hostOptionValue(['o2', 'o1'], index)).toEqual([
      'atomic:t2',
      'atomic:t1',
    ]);
    expect(hostOptionValue([], index)).toEqual([]);
    expect(hostOptionValue(undefined, index)).toBeUndefined();
    expect(() => hostOptionValue('o3', index)).toThrow(
      /No tag for Notion option o3/,
    );
    expect(() => hostOptionValue('o1', EMPTY_INDEX)).toThrow(/No tag/);
  });
});
