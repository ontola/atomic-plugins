// @wc-ignore-file
/** UI strings of the lens app, Dutch and English. The language is the browser's; English unless it starts with nl. */
import { langOf } from '../shared/lang.js';

const nl = {
  title: 'Lenzen',
  intro:
    'Sleep het voorwerp en de brandpunten. De drie hoofdstralen laten zien waar het beeld ontstaat.',
  scene:
    'Een lens op de hoofdas met een voorwerp, drie hoofdstralen en het beeld. Sleep het voorwerp of een brandpunt, of gebruik de pijltjestoetsen.',
  kind: 'Soort lens',
  convex: 'Bol (positief)',
  concave: 'Hol (negatief)',
  sliderV: 'Voorwerpsafstand v',
  sliderF: 'Brandpuntsafstand |f|',
  sliderH: 'Voorwerpshoogte',
  valueV: 'Voorwerpsafstand v',
  valueB: 'Beeldafstand b',
  valueF: 'Brandpuntsafstand f',
  valueN: 'Vergroting N = b/v',
  valueHeight: 'Beeldhoogte',
  formulaTitle: 'Lensformule',
  perCm: 'per cm',
  rays: 'Hoofdstralen',
  ray1: 'Straal 1: evenwijdig aan de hoofdas',
  ray2: 'Straal 2: door het optisch midden',
  ray3: 'Straal 3: gericht op het brandpunt',
  virtualLine: 'Stippellijn: verlengde, het licht lijkt daarvandaan te komen',
  object: 'Voorwerp',
  image: 'Beeld',
  focus: 'Brandpunt',
  hint: 'Sleep het voorwerp (afstand en hoogte) en de brandpunten, of kies ze met Tab en verplaats ze met de pijltjestoetsen. Houd Shift ingedrukt voor kleine stappen.',
  signs:
    'Tekens: b > 0 is een reëel beeld (achter de lens), b < 0 een virtueel beeld (aan de kant van het voorwerp). Een holle lens heeft f < 0.',
  objectLabel: (v: string, h: string) =>
    `Voorwerp, afstand v is ${v} cm, hoogte ${h} cm. Pijl links of rechts verandert de afstand, omhoog of omlaag de hoogte.`,
  focusLabel: (side: 'object' | 'image', f: string) =>
    `Brandpunt aan de ${side === 'object' ? 'kant van het voorwerp' : 'andere kant'}, |f| is ${f} cm. Pijl links of rechts verandert de brandpuntsafstand.`,
  real: 'reëel',
  virtual: 'virtueel',
  inverted: 'omgekeerd',
  upright: 'rechtop',
  enlarged: 'vergroot',
  reduced: 'verkleind',
  same: 'even groot',
  describe: (kind: string, orient: string, size: string, n: string) =>
    `Het beeld is ${kind}, ${orient} en ${size} (N = ${n}).`,
  atFocus:
    'Het voorwerp staat in het brandpunt: na de lens lopen de stralen evenwijdig. Er is geen beeld; het ligt op oneindig.',
  far: 'Het beeld ligt buiten het getekende gebied.',
};

export type Strings = typeof nl;

const en: Strings = {
  title: 'Lenses',
  intro:
    'Drag the object and the focal points. The three principal rays show where the image forms.',
  scene:
    'A lens on the optical axis with an object, three principal rays and the image. Drag the object or a focal point, or use the arrow keys.',
  kind: 'Type of lens',
  convex: 'Convex (converging)',
  concave: 'Concave (diverging)',
  sliderV: 'Object distance v',
  sliderF: 'Focal length |f|',
  sliderH: 'Object height',
  valueV: 'Object distance v',
  valueB: 'Image distance b',
  valueF: 'Focal length f',
  valueN: 'Magnification N = b/v',
  valueHeight: 'Image height',
  formulaTitle: 'Lens formula',
  perCm: 'per cm',
  rays: 'Principal rays',
  ray1: 'Ray 1: parallel to the axis',
  ray2: 'Ray 2: through the optical centre',
  ray3: 'Ray 3: aimed at the focal point',
  virtualLine: 'Dotted line: extension, the light seems to come from there',
  object: 'Object',
  image: 'Image',
  focus: 'Focal point',
  hint: 'Drag the object (distance and height) and the focal points, or pick them with Tab and move them with the arrow keys. Hold Shift for small steps.',
  signs:
    'Signs: b > 0 is a real image (behind the lens), b < 0 a virtual image (on the object side). A concave lens has f < 0.',
  objectLabel: (v: string, h: string) =>
    `Object, distance v is ${v} cm, height ${h} cm. Left or right arrow changes the distance, up or down the height.`,
  focusLabel: (side: 'object' | 'image', f: string) =>
    `Focal point on the ${side === 'object' ? 'object side' : 'other side'}, |f| is ${f} cm. Left or right arrow changes the focal length.`,
  real: 'real',
  virtual: 'virtual',
  inverted: 'inverted',
  upright: 'upright',
  enlarged: 'enlarged',
  reduced: 'reduced',
  same: 'the same size',
  describe: (kind: string, orient: string, size: string, n: string) =>
    `The image is ${kind}, ${orient} and ${size} (N = ${n}).`,
  atFocus:
    'The object stands in the focal point: behind the lens the rays run parallel. There is no image; it is at infinity.',
  far: 'The image lies outside the drawn area.',
};

export const stringsFor = (language: string | undefined): Strings =>
  langOf(language) === 'nl' ? nl : en;
