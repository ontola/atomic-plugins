// @wc-ignore-file
/**
 * The sample statements moderated user testing serves to testers (#196,
 * `fixtures/usertest/`): they are current with their generator, both readers
 * accept them, the two formats hold the same bookings, and the second file
 * overlaps the first only by bank reference.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FILES } from './fixtures/usertest/generate.mjs';
import { entries } from './identity';
import { parseBankStatement } from './statement';

const read = (name: string) =>
  readFileSync(new URL(`./fixtures/usertest/${name}`, import.meta.url), 'utf8');

describe('user-testing sample statements', () => {
  it('are what generate.mjs writes', () => {
    for (const [name, text] of Object.entries(FILES as Record<string, string>))
      expect(read(name), name).toBe(text);
  });

  it('parse and reconcile in both formats, with the same bookings', () => {
    const mt940 = parseBankStatement(read('acme-studio-2026-08.mt940'));
    const camt = parseBankStatement(read('acme-studio-2026-08.camt053.xml'));
    expect(mt940.format).toBe('mt940');
    expect(camt.format).toBe('camt053');

    const [a] = mt940.statements;
    const [b] = camt.statements;
    expect(a.account).toBe('NL00BANK0000000000');
    expect([a.start, a.end, a.opening, a.closing]).toEqual([
      '2026-08-01',
      '2026-09-15',
      '8412.5',
      '11783.88',
    ]);
    expect([b.start, b.end, b.opening, b.closing]).toEqual([
      a.start,
      a.end,
      a.opening,
      a.closing,
    ]);
    // The pending camt.053 entry is left out.
    expect(b.transactions).toHaveLength(31);
    expect(
      a.transactions.map(t => [t.date, t.amount, t.bankReference]),
    ).toEqual(b.transactions.map(t => [t.date, t.amount, t.bankReference]));
    expect(a.transactions.find(t => t.amount === '18.75')?.description).toMatch(
      /Terugbetaling/,
    );
    expect(
      a.transactions.find(t => t.description.includes('USD 49.00'))?.amount,
    ).toBe('-45.12');
    expect(
      a.transactions
        .find(t => t.description.includes('Machtiging'))
        ?.description.split('\n').length,
    ).toBe(7);
  });

  it('overlap by bank reference: the September file adds 15 bookings', () => {
    const first = parseBankStatement(read('acme-studio-2026-08.mt940'));
    const second = parseBankStatement(read('acme-studio-2026-09.mt940'));
    const known = new Set(
      entries(first.format, first.statements).map(e => e.identity),
    );
    const next = entries(second.format, second.statements);
    expect(next).toHaveLength(25);
    expect(next.filter(e => !known.has(e.identity))).toHaveLength(15);
    expect(second.statements[0].opening).toBe('12428.51');
  });
});
