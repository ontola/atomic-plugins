// @wc-ignore-file
/** UI strings, Dutch and English. The language is the browser's; English by default. */

const nl = {
  title: 'Atomic Education',
  starter: 'Laad startboom',
  starterBusy: 'Startboom laden...',
  empty:
    'Een leerboom toont vaardigheden, wat je ervoor nodig hebt en de lessen erbij. Laad de startboom voor wiskunde en natuurkunde, of voeg zelf vaardigheden toe aan de tabel.',
  unusable:
    'Deze tabel bevat geen vaardigheden (klasse skill-v1). Voeg deze app toe aan een tabel van die klasse.',
  error: 'Kon Atomic Education niet laden',
  retry: 'Opnieuw proberen',
  next: 'Volgende logische stappen',
  nextForGoal: 'Volgende stappen richting je doel',
  nothingNext: 'Niets meer te adviseren: alles is beheerst.',
  emptyTitle: 'Nog geen vaardigheden',
  progress: (n: number, total: number) => `${n} van ${total} beheerst`,
  level: (n: number) => `Niveau ${n}`,
  scrollHint: 'Veeg opzij voor de rest van de boom.',
  start: 'Start',
  openLesson: 'Open',
  notLinked: 'nog niet gekoppeld',
  link: 'Koppel',
  linkLabel: 'Koppel een resource of link',
  linkPlaceholder: 'Plak een resource of link',
  badLink: 'Dat is geen resource (did:) of link (https://).',
  mastered: 'Beheerst',
  available: 'Beschikbaar',
  locked: 'Nog niet aan de beurt',
  advisory: 'Dit is advies: je kunt deze vaardigheid gewoon openen en leren.',
  firstAdvised: 'Eerst aan te raden',
  recommended: 'Helpt ook',
  lessons: 'Lessen',
  noLessons: 'Nog geen lessen voor deze vaardigheid.',
  noMaterial: 'nog geen materiaal',
  minutes: 'min',
  iMaster: 'Ik beheers dit',
  noLonger: 'Niet meer beheerst',
  pathTo: 'Pad naar dit doel',
  clearPath: 'Wis pad',
  path: 'Pad naar',
  steps: 'stappen',
  pickSkill: 'Kies een vaardigheid in de boom.',
  open: 'Open als resource',
  denied:
    'Geen toestemming om de tabel te bewerken, dus de startboom is niet geladen.',
  failed: 'Opslaan is niet gelukt. Probeer het opnieuw.',
  loaded: (n: number) => `Startboom geladen: ${n} nieuwe vaardigheden.`,
  cycles: (n: number) =>
    `${n} afhankelijkheid(en) negeren we, want ze vormen een kringloop.`,
  missing: (n: number) =>
    `${n} verwijzing(en) naar onbekende vaardigheden genegeerd.`,
  formats: {
    video: 'Video',
    text: 'Tekst',
    interactive: 'Interactief',
    exercise: 'Oefening',
    live: 'Live',
    tour: 'Rondleiding',
  } as Record<string, string>,
};

const en: typeof nl = {
  title: 'Atomic Education',
  starter: 'Load starter tree',
  starterBusy: 'Loading starter tree...',
  empty:
    'A learning tree shows skills, what each one needs and the lessons for it. Load the mathematics and physics starter tree, or add skills to the table yourself.',
  unusable:
    'This table holds no skills (class skill-v1). Add this app to a table of that class.',
  error: 'Could not load Atomic Education',
  retry: 'Try again',
  next: 'Next logical steps',
  nextForGoal: 'Next steps toward your goal',
  nothingNext: 'Nothing left to advise: everything is mastered.',
  emptyTitle: 'No skills yet',
  progress: (n: number, total: number) => `${n} of ${total} mastered`,
  level: (n: number) => `Level ${n}`,
  scrollHint: 'Swipe sideways for the rest of the tree.',
  start: 'Start',
  openLesson: 'Open',
  notLinked: 'not linked yet',
  link: 'Link',
  linkLabel: 'Link a resource or URL',
  linkPlaceholder: 'Paste a resource or link',
  badLink: 'That is not a resource (did:) or a link (https://).',
  mastered: 'Mastered',
  available: 'Available',
  locked: 'Not yet due',
  advisory: 'This is advice: you can open and learn this skill anyway.',
  firstAdvised: 'Advised first',
  recommended: 'Also helps',
  lessons: 'Lessons',
  noLessons: 'No lessons for this skill yet.',
  noMaterial: 'no material yet',
  minutes: 'min',
  iMaster: 'I master this',
  noLonger: 'No longer mastered',
  pathTo: 'Path to this goal',
  clearPath: 'Clear path',
  path: 'Path to',
  steps: 'steps',
  pickSkill: 'Pick a skill in the tree.',
  open: 'Open as resource',
  denied:
    'No permission to edit the table, so the starter tree was not loaded.',
  failed: 'Saving failed. Try again.',
  loaded: (n: number) => `Starter tree loaded: ${n} new skills.`,
  cycles: (n: number) =>
    `${n} dependency(ies) ignored because they form a cycle.`,
  missing: (n: number) => `${n} reference(s) to unknown skills ignored.`,
  formats: {
    video: 'Video',
    text: 'Text',
    interactive: 'Interactive',
    exercise: 'Exercise',
    live: 'Live',
    tour: 'Tour',
  },
};

export type Strings = typeof nl;

export const stringsFor = (language: string | undefined): Strings =>
  language?.toLowerCase().startsWith('nl') ? nl : en;

export const FORMAT_ICON: Record<string, string> = {
  video: '\u{1F3AC}',
  text: '\u{1F4C4}',
  interactive: '\u25B6\uFE0E',
  exercise: '\u{270F}\u{FE0F}',
  live: '\u{1F465}',
  tour: '\u{1F9ED}',
};
