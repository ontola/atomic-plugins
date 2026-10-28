// @wc-ignore-file
/** UI strings of the spring app, Dutch and English. The language is the browser's; English unless it starts with nl. */
import { langOf } from '../shared/lang.js';

const nl = {
  title: 'Trillingen',
  intro:
    'Een massa aan een veer. Stel m, C, de amplitude en de demping in en volg de uitwijking u(t).',
  figure:
    'Een massa aan een veer. De stippellijn is de evenwichtsstand, u = 0. Sleep de massa omhoog of omlaag om de amplitude te kiezen.',
  plot: 'Grafiek van de uitwijking u in cm tegen de tijd t in seconden',
  sliderM: 'Massa m',
  sliderC: 'Veerconstante C',
  sliderA: 'Amplitude A',
  sliderD: 'Demping c',
  start: 'Start',
  pause: 'Pauze',
  restart: 'Opnieuw',
  speed: 'Snelheid',
  valueT: 'Periode T = 2π√(m/C)',
  valueMeasured: 'Gemeten periode',
  valueF: 'Frequentie f = 1/T',
  valueTime: 'Tijd t',
  valueU: 'Uitwijking u',
  notYet: 'nog niet (wacht op twee keer door nul omhoog)',
  regimeNone: 'Zonder demping: de amplitude blijft constant.',
  regimeUnder: (td: string) =>
    `Ondergedempt: de amplitude neemt af en de periode is iets langer, ${td} s.`,
  regimeCritical:
    'Kritisch gedempt: er is geen trilling meer, de massa kruipt naar de evenwichtsstand.',
  regimeOver:
    'Overgedempt: er is geen trilling, de massa kruipt langzaam naar de evenwichtsstand.',
  formula: (m: string, C: string, T: string) =>
    `T = 2π√(m/C) = 2π√(${m}/${C}) = ${T} s`,
  measuredNote:
    'Gemeten: de tijd tussen twee keer dat u van negatief naar positief door nul gaat.',
  hint: 'Sleep de massa omhoog of omlaag, of kies hem met Tab en gebruik pijl omhoog of omlaag. Spatie start of pauzeert. Houd Shift ingedrukt voor kleine stappen.',
  massLabel: (m: string, a: string) =>
    `Massa van ${m} kg, amplitude ${a} cm. Pijl omhoog of omlaag verandert de amplitude, spatie start of pauzeert.`,
  axisT: 't (s)',
  axisU: 'u (cm)',
  envelope: 'Stippellijn: de afnemende amplitude',
  periodMark: 'T',
  m: 'kg',
  C: 'N/m',
  c: 'kg/s',
};

export type Strings = typeof nl;

const en: Strings = {
  title: 'Oscillations',
  intro:
    'A mass on a spring. Set m, C, the amplitude and the damping, and follow the displacement u(t).',
  figure:
    'A mass on a spring. The dashed line is the rest position, u = 0. Drag the mass up or down to choose the amplitude.',
  plot: 'Graph of the displacement u in cm against the time t in seconds',
  sliderM: 'Mass m',
  sliderC: 'Spring constant C',
  sliderA: 'Amplitude A',
  sliderD: 'Damping c',
  start: 'Start',
  pause: 'Pause',
  restart: 'Restart',
  speed: 'Speed',
  valueT: 'Period T = 2π√(m/C)',
  valueMeasured: 'Measured period',
  valueF: 'Frequency f = 1/T',
  valueTime: 'Time t',
  valueU: 'Displacement u',
  notYet: 'not yet (waiting for two upward zero crossings)',
  regimeNone: 'Without damping the amplitude stays constant.',
  regimeUnder: (td: string) =>
    `Underdamped: the amplitude shrinks and the period is a little longer, ${td} s.`,
  regimeCritical:
    'Critically damped: no oscillation, the mass creeps to the rest position.',
  regimeOver:
    'Overdamped: no oscillation, the mass creeps slowly to the rest position.',
  formula: (m: string, C: string, T: string) =>
    `T = 2π√(m/C) = 2π√(${m}/${C}) = ${T} s`,
  measuredNote:
    'Measured: the time between two moments u passes zero going from negative to positive.',
  hint: 'Drag the mass up or down, or pick it with Tab and use the up or down arrow. Space starts or pauses. Hold Shift for small steps.',
  massLabel: (m: string, a: string) =>
    `Mass of ${m} kg, amplitude ${a} cm. Up or down arrow changes the amplitude, space starts or pauses.`,
  axisT: 't (s)',
  axisU: 'u (cm)',
  envelope: 'Dotted line: the shrinking amplitude',
  periodMark: 'T',
  m: 'kg',
  C: 'N/m',
  c: 'kg/s',
};

export const stringsFor = (language: string | undefined): Strings =>
  langOf(language) === 'nl' ? nl : en;
