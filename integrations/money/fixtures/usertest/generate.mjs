#!/usr/bin/env node
/**
 * Writes the sample bank statements for moderated user testing (#196), so a
 * tester can try the Money app without showing their own bank export:
 *
 *   node integrations/money/fixtures/usertest/generate.mjs           # write
 *   node integrations/money/fixtures/usertest/generate.mjs --check   # compare
 *
 * Everything here is invented: the studio, its account number
 * (NL00BANK0000000000, not a valid IBAN), the counterparties and the
 * references. `usertest/catalog.mjs` copies the written files to the catalog
 * host's `samples/money/`; `../../usertest-samples.test.ts` parses them.
 *
 * - `acme-studio-2026-08.mt940` and `acme-studio-2026-08.camt053.xml`: the
 *   same 31 bookings from 1 August to 15 September 2026, once per format.
 * - `acme-studio-2026-09.mt940`: 1 to 30 September, 25 bookings. The first
 *   ten (1 to 15 September) are the same bookings with the same bank
 *   references, so importing it after the first file adds only the 15 new
 *   ones.
 *
 * It includes a refund, a payment in US dollars (booked in euros, with the
 * dollar amount and rate in the description), a direct debit with a long
 * bank description over several lines, and a pending card payment in the
 * camt.053 file, which is left out of the booked balances.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ACCOUNT = 'NL00BANK0000000000';
const HOLDER = 'Acme Studio';

/**
 * [booking date, amount in cents (negative is out), MT940 code, counterparty,
 * description lines]. The bank reference is derived from the date and order.
 */
const BOOKINGS = [
  [
    '2026-08-03',
    -185000,
    'NTRF',
    'De Werkplaats Verhuur BV',
    ['Huur augustus 2026 unit 4'],
  ],
  [
    '2026-08-03',
    -1499,
    'NDDT',
    'Pixelboard BV',
    ['Pixelboard Team abonnement augustus'],
  ],
  [
    '2026-08-04',
    242000,
    'NTRF',
    'Bakkerij Zonnig BV',
    ['Factuur AS-2026-031 huisstijl'],
  ],
  [
    '2026-08-05',
    -4235,
    'NTRF',
    'Koffiebranderij De Boon',
    ['Bonen kantoor 3 kg'],
  ],
  [
    '2026-08-06',
    -2890,
    'NMSC',
    'NS Reizigers',
    ['Treinkaartje Utrecht-Rotterdam v.v.'],
  ],
  [
    '2026-08-07',
    -64000,
    'NTRF',
    'Lotte Visser',
    ['Freelance illustratie juli 2026'],
  ],
  [
    '2026-08-10',
    -3950,
    'NDDT',
    'Belnet Mobiel',
    ['Mobiel abonnement augustus'],
  ],
  [
    '2026-08-11',
    -4512,
    'NTRF',
    'Fontfoundry Inc.',
    ['Font licence Halcyon Sans, 2 seats', 'USD 49.00 rate 0.9208 EUR 45.12'],
  ],
  [
    '2026-08-12',
    96800,
    'NTRF',
    'Stichting Groen Plein',
    ['Factuur AS-2026-032 website onderhoud'],
  ],
  [
    '2026-08-13',
    -1875,
    'NMSC',
    'Drukkerij Kleur & Co',
    ['Visitekaartjes proefdruk'],
  ],
  [
    '2026-08-14',
    -11834,
    'NDDT',
    'Verzekeraar Veilig NV',
    [
      'SEPA Incasso algemeen doorlopend',
      'Incassant: NL00ZZZ000000000000',
      'Machtiging: VV-2024-118833 bedrijfsaansprakelijkheid',
      'Omschrijving: Premie bedrijfsaansprakelijkheidsverzekering',
      'periode 01-08-2026 t/m 31-08-2026 polis 4410-2291-07',
      'IBAN: NL00BANK0000000099 Kenmerk: 2026081400118833',
    ],
  ],
  ['2026-08-17', -2450, 'NMSC', 'Lunchroom Het Plein', ['Lunch klantoverleg']],
  [
    '2026-08-18',
    1875,
    'NTRF',
    'Drukkerij Kleur & Co',
    ['Terugbetaling proefdruk, dubbel gefactureerd'],
  ],
  [
    '2026-08-19',
    -899,
    'NDDT',
    'Hostly Hosting',
    ['Webhosting acmestudio.example augustus'],
  ],
  [
    '2026-08-20',
    363000,
    'NTRF',
    'Fietsenmaker Snel VOF',
    ['Factuur AS-2026-033 webshop fase 1'],
  ],
  [
    '2026-08-21',
    -7680,
    'NMSC',
    'Bouwmarkt Hamer',
    ['Kantoorspullen en verlichting'],
  ],
  [
    '2026-08-24',
    -52000,
    'NTRF',
    'Ravi Brouwer',
    ['Freelance development juli 2026'],
  ],
  ['2026-08-25', -1250, 'NMSC', 'Bank', ['Kosten zakelijke rekening augustus']],
  [
    '2026-08-27',
    72600,
    'NTRF',
    'Theater De Kleine Zaal',
    ['Factuur AS-2026-034 affiches seizoen'],
  ],
  [
    '2026-08-28',
    -27500,
    'NTRF',
    'Belastingdienst',
    ['Betalingskenmerk 0000 0000 0000 0001 btw Q2'],
  ],
  ['2026-08-31', -3100, 'NMSC', 'Tankstation Noord', ['Tanken bestelauto']],
  // 1 to 15 September: in both files.
  [
    '2026-09-01',
    -185000,
    'NTRF',
    'De Werkplaats Verhuur BV',
    ['Huur september 2026 unit 4'],
  ],
  [
    '2026-09-01',
    -1499,
    'NDDT',
    'Pixelboard BV',
    ['Pixelboard Team abonnement september'],
  ],
  [
    '2026-09-02',
    151250,
    'NTRF',
    'Bakkerij Zonnig BV',
    ['Factuur AS-2026-035 verpakkingen'],
  ],
  [
    '2026-09-03',
    -2890,
    'NMSC',
    'NS Reizigers',
    ['Treinkaartje Utrecht-Amsterdam v.v.'],
  ],
  [
    '2026-09-07',
    -64000,
    'NTRF',
    'Lotte Visser',
    ['Freelance illustratie augustus 2026'],
  ],
  [
    '2026-09-08',
    -3950,
    'NDDT',
    'Belnet Mobiel',
    ['Mobiel abonnement september'],
  ],
  ['2026-09-09', -1640, 'NMSC', 'Lunchroom Het Plein', ['Lunch team']],
  [
    '2026-09-10',
    48400,
    'NTRF',
    'Stichting Groen Plein',
    ['Factuur AS-2026-036 nieuwsbrief'],
  ],
  [
    '2026-09-14',
    -899,
    'NDDT',
    'Hostly Hosting',
    ['Webhosting acmestudio.example september'],
  ],
  [
    '2026-09-15',
    -4235,
    'NTRF',
    'Koffiebranderij De Boon',
    ['Bonen kantoor 3 kg'],
  ],
  // 16 to 30 September: only in the second file.
  [
    '2026-09-16',
    211750,
    'NTRF',
    'Fietsenmaker Snel VOF',
    ['Factuur AS-2026-037 webshop fase 2'],
  ],
  ['2026-09-17', -5990, 'NMSC', 'Kantoorwinkel Pen', ['Printerpapier en inkt']],
  [
    '2026-09-18',
    -52000,
    'NTRF',
    'Ravi Brouwer',
    ['Freelance development augustus 2026'],
  ],
  [
    '2026-09-21',
    -11834,
    'NDDT',
    'Verzekeraar Veilig NV',
    [
      'SEPA Incasso algemeen doorlopend',
      'Incassant: NL00ZZZ000000000000',
      'Machtiging: VV-2024-118833 bedrijfsaansprakelijkheid',
      'Omschrijving: Premie bedrijfsaansprakelijkheidsverzekering',
      'periode 01-09-2026 t/m 30-09-2026 polis 4410-2291-07',
      'IBAN: NL00BANK0000000099 Kenmerk: 2026092100118833',
    ],
  ],
  ['2026-09-22', -2450, 'NMSC', 'Lunchroom Het Plein', ['Lunch klantoverleg']],
  [
    '2026-09-23',
    60500,
    'NTRF',
    'Theater De Kleine Zaal',
    ['Factuur AS-2026-038 programmaboekje'],
  ],
  ['2026-09-24', -3100, 'NMSC', 'Tankstation Noord', ['Tanken bestelauto']],
  [
    '2026-09-25',
    -1250,
    'NMSC',
    'Bank',
    ['Kosten zakelijke rekening september'],
  ],
  [
    '2026-09-25',
    -14900,
    'NTRF',
    'Opleidingen Online BV',
    ['Cursus typografie, 1 deelnemer'],
  ],
  [
    '2026-09-28',
    30250,
    'NTRF',
    'Huisartsenpraktijk Lindeboom',
    ['Factuur AS-2026-039 bewegwijzering'],
  ],
  [
    '2026-09-29',
    -8000,
    'NTRF',
    'Ravi Brouwer',
    ['Onkosten treinreizen september'],
  ],
  [
    '2026-09-30',
    -2190,
    'NMSC',
    'Koffiebar Station',
    ['Koffie en broodjes workshop'],
  ],
  [
    '2026-09-30',
    -6050,
    'NDDT',
    'Belnet Internet',
    ['Zakelijk internet september'],
  ],
  ['2026-09-30', -3500, 'NTRF', 'Lotte Visser', ['Reiskosten augustus']],
  ['2026-09-30', -1499, 'NMSC', 'Webwinkel Kabel', ['USB-C kabels 3 stuks']],
];

const OPENING = 841250; // 1 August 2026, in cents

/** Bookings with their bank reference, in order. */
const ALL = (() => {
  const perDay = new Map();

  return BOOKINGS.map(([date, cents, code, party, lines]) => {
    const n = (perDay.get(date) ?? 0) + 1;
    perDay.set(date, n);
    const reference = `ACME${date.replaceAll('-', '')}${String(n).padStart(2, '0')}`;

    return { date, cents, code, party, lines, reference };
  });
})();

const between = (from, to) => ALL.filter(b => b.date >= from && b.date <= to);
const balanceBefore = date =>
  OPENING + ALL.filter(b => b.date < date).reduce((t, b) => t + b.cents, 0);
const total = rows => rows.reduce((t, b) => t + b.cents, 0);

const euros = (cents, separator) => {
  const abs = Math.abs(cents);

  return `${Math.floor(abs / 100)}${separator}${String(abs % 100).padStart(2, '0')}`;
};

const yymmdd = date => date.slice(2).replaceAll('-', '');
const mmdd = date => date.slice(5).replaceAll('-', '');
const sign = cents => (cents < 0 ? 'D' : 'C');

/** One MT940 statement. Narrative lines are at most 65 characters. */
function mt940({ number, from, to }) {
  const rows = between(from, to);
  const opening = balanceBefore(from);
  const closing = opening + total(rows);
  const lines = [
    `:20:ACME${yymmdd(to)}`,
    `:25:${ACCOUNT}`,
    `:28C:${number}/1`,
    `:60F:${sign(opening)}${yymmdd(from)}EUR${euros(opening, ',')}`,
  ];

  for (const b of rows) {
    lines.push(
      `:61:${yymmdd(b.date)}${mmdd(b.date)}${sign(b.cents)}${euros(b.cents, ',')}${b.code}NONREF//${b.reference}`,
    );
    const narrative = [b.party, ...b.lines];
    for (const line of narrative)
      if (line.length > 65) throw new Error(`MT940 line too long: ${line}`);
    lines.push(`:86:${narrative[0]}`, ...narrative.slice(1));
  }

  lines.push(`:62F:${sign(closing)}${yymmdd(to)}EUR${euros(closing, ',')}`);

  return lines.join('\r\n') + '\r\n';
}

const xml = text =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** One camt.053 statement, plus a pending entry outside the balances. */
function camt053({ number, from, to }) {
  const rows = between(from, to);
  const opening = balanceBefore(from);
  const closing = opening + total(rows);
  const bal = (code, cents, date) => `      <Bal>
        <Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="EUR">${euros(cents, '.')}</Amt>
        <CdtDbtInd>${cents < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Dt><Dt>${date}</Dt></Dt>
      </Bal>`;

  const entry = b => {
    const out = b.cents < 0;
    const party = out
      ? `<Cdtr><Nm>${xml(b.party)}</Nm></Cdtr>`
      : `<Dbtr><Nm>${xml(b.party)}</Nm></Dbtr>`;
    const family =
      b.code === 'NDDT'
        ? '<Domn><Cd>PMNT</Cd><Fmly><Cd>IDDT</Cd><SubFmlyCd>ESDD</SubFmlyCd></Fmly></Domn>'
        : b.code === 'NMSC'
          ? '<Domn><Cd>PMNT</Cd><Fmly><Cd>CCRD</Cd><SubFmlyCd>POSD</SubFmlyCd></Fmly></Domn>'
          : `<Domn><Cd>PMNT</Cd><Fmly><Cd>${out ? 'ICDT' : 'RCDT'}</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn>`;

    return `      <Ntry>
        <Amt Ccy="EUR">${euros(b.cents, '.')}</Amt>
        <CdtDbtInd>${out ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>${b.date}</Dt></BookgDt>
        <ValDt><Dt>${b.date}</Dt></ValDt>
        <AcctSvcrRef>${b.reference}</AcctSvcrRef>
        <BkTxCd>${family}</BkTxCd>
        <NtryDtls>
          <TxDtls>
            <Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
            <RltdPties>${party}</RltdPties>
            <RmtInf>${b.lines.map(l => `<Ustrd>${xml(l)}</Ustrd>`).join('')}</RmtInf>
          </TxDtls>
        </NtryDtls>
      </Ntry>`;
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>ACME-CAMT-${number}</MsgId>
      <CreDtTm>${to}T06:00:00</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>ACME-${number}</Id>
      <ElctrncSeqNb>${number}</ElctrncSeqNb>
      <CreDtTm>${to}T06:00:00</CreDtTm>
      <Acct>
        <Id><IBAN>${ACCOUNT}</IBAN></Id>
        <Ccy>EUR</Ccy>
        <Ownr><Nm>${HOLDER}</Nm></Ownr>
      </Acct>
${bal('OPBD', opening, from)}
${bal('CLBD', closing, to)}
${rows.map(entry).join('\n')}
      <Ntry>
        <Amt Ccy="EUR">23.80</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>PDNG</Sts>
        <ValDt><Dt>${to}</Dt></ValDt>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}

const FIRST = { number: '8', from: '2026-08-01', to: '2026-09-15' };
const SECOND = { number: '9', from: '2026-09-01', to: '2026-09-30' };

/** File name -> contents. */
export const FILES = {
  'acme-studio-2026-08.mt940': mt940(FIRST),
  'acme-studio-2026-08.camt053.xml': camt053(FIRST),
  'acme-studio-2026-09.mt940': mt940(SECOND),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = 0;

  for (const [name, text] of Object.entries(FILES)) {
    const file = join(here, name);

    if (!check) {
      writeFileSync(file, text);
      console.info(`wrote ${name}`);
      continue;
    }

    let current = '';

    try {
      current = readFileSync(file, 'utf8');
    } catch {}

    if (current !== text) {
      stale++;
      console.error(`${name} is out of date; run generate.mjs`);
    }
  }

  if (stale) process.exit(1);
}
