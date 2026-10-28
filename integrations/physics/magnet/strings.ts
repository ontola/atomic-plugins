// @wc-ignore-file
/** UI strings of the magnet app, Dutch and English. The language is the browser's; English unless it starts with nl. */
import { langOf } from '../shared/lang.js';

const nl = {
  title: 'Magneten',
  intro:
    'Sleep de magneten en het kompas. De veldlijnen lopen buiten de magneet van de noordpool naar de zuidpool.',
  scene:
    'Een of twee staafmagneten met veldlijnen en een kompas. Sleep een magneet of het kompas, of gebruik de pijltjestoetsen.',
  count: 'Aantal magneten',
  one: '1',
  two: '2',
  background: 'Achtergrond',
  none: 'Geen',
  filings: 'IJzervijlsel',
  strength: 'Veldsterkte',
  lines: 'Veldlijnen tonen',
  angle1: 'Hoek van magneet 1',
  angle2: 'Hoek van magneet 2',
  flip: 'Keer magneet 2 om',
  reset: 'Opnieuw beginnen',
  north: 'N',
  south: 'Z',
  northPole: 'noordpool',
  southPole: 'zuidpool',
  magnet: (i: number) => `Magneet ${i}`,
  magnetLabel: (i: number, x: string, y: string, deg: string) =>
    `Magneet ${i}, midden op x ${x}, y ${y}, hoek ${deg} graden. Pijltjestoetsen verplaatsen, Shift en pijl links of rechts draait.`,
  rotateLabel: (i: number) =>
    `Draai magneet ${i}. Pijl links of rechts verandert de hoek, Shift voor kleine stappen.`,
  compass: 'Kompas',
  compassLabel: (x: string, y: string) =>
    `Kompas op x ${x}, y ${y}. De rode naaldpunt wijst langs het veld. Pijltjestoetsen verplaatsen het kompas.`,
  hint: 'Sleep een magneet aan zijn midden, draai hem met het ronde handvat, en sleep het kompas door het veld. Met Tab kies je een onderdeel en met de pijltjestoetsen verplaats je het. Houd Shift ingedrukt voor kleine stappen.',
  fieldAtCompass: 'Veld bij het kompas',
  relative: 'relatief',
  direction: 'Richting van het veld',
  degrees: 'graden',
  legendN: 'Noordpool (rood)',
  legendS: 'Zuidpool (blauw)',
  legendNeedle:
    'De rode punt van het kompas wijst langs het veld, van noord naar zuid',
  attract: 'Aantrekking',
  repel: 'Afstoting',
  noForce: 'Geen merkbare kracht tussen de magneten',
  facing: (a: string, b: string, d: string) =>
    `Dichtstbijzijnde polen: de ${a} van magneet 1 en de ${b} van magneet 2, ${d} cm van elkaar.`,
  force: 'Kracht op elke magneet (relatief)',
  attractWhy: 'Ongelijke polen trekken elkaar aan.',
  repelWhy: 'Gelijke polen stoten elkaar af.',
  singleHint:
    'Zet er een tweede magneet bij om aantrekking en afstoting te zien.',
};

export type Strings = typeof nl;

const en: Strings = {
  title: 'Magnets',
  intro:
    'Drag the magnets and the compass. Outside the magnet the field lines run from the north pole to the south pole.',
  scene:
    'One or two bar magnets with field lines and a compass. Drag a magnet or the compass, or use the arrow keys.',
  count: 'Number of magnets',
  one: '1',
  two: '2',
  background: 'Background',
  none: 'None',
  filings: 'Iron filings',
  strength: 'Field strength',
  lines: 'Show field lines',
  angle1: 'Angle of magnet 1',
  angle2: 'Angle of magnet 2',
  flip: 'Flip magnet 2',
  reset: 'Start over',
  north: 'N',
  south: 'S',
  northPole: 'north pole',
  southPole: 'south pole',
  magnet: (i: number) => `Magnet ${i}`,
  magnetLabel: (i: number, x: string, y: string, deg: string) =>
    `Magnet ${i}, centre at x ${x}, y ${y}, angle ${deg} degrees. Arrow keys move it, Shift with left or right arrow turns it.`,
  rotateLabel: (i: number) =>
    `Turn magnet ${i}. Left or right arrow changes the angle, Shift for small steps.`,
  compass: 'Compass',
  compassLabel: (x: string, y: string) =>
    `Compass at x ${x}, y ${y}. The red needle tip points along the field. Arrow keys move the compass.`,
  hint: 'Drag a magnet by its middle, turn it with the round handle, and drag the compass through the field. Pick a part with Tab and move it with the arrow keys. Hold Shift for small steps.',
  fieldAtCompass: 'Field at the compass',
  relative: 'relative',
  direction: 'Direction of the field',
  degrees: 'degrees',
  legendN: 'North pole (red)',
  legendS: 'South pole (blue)',
  legendNeedle:
    'The red tip of the compass points along the field, from north to south',
  attract: 'Attraction',
  repel: 'Repulsion',
  noForce: 'No noticeable force between the magnets',
  facing: (a: string, b: string, d: string) =>
    `Closest poles: the ${a} of magnet 1 and the ${b} of magnet 2, ${d} cm apart.`,
  force: 'Force on each magnet (relative)',
  attractWhy: 'Unlike poles attract.',
  repelWhy: 'Like poles repel.',
  singleHint: 'Add a second magnet to see attraction and repulsion.',
};

export const stringsFor = (language: string | undefined): Strings =>
  langOf(language) === 'nl' ? nl : en;
