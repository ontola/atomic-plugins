// The session page's languages and texts. To add a language: add it to
// LANGS (a BCP 47 tag the browser's speech recognizer and synthesizer know)
// and a full entry to TEXT, then add it to LANGUAGES in
// ../moderator/server.mjs, which tells the moderator which language to speak.
// Session plans stay in English; the moderator translates as it speaks.
//
// Texts marked HTML are set with innerHTML: constants from this file only.

export const LANGS = [
  { code: 'en-US', short: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'nl-NL', short: 'nl', name: 'Nederlands', flag: '🇳🇱' },
];

export const DEFAULT_LANG = 'en-US';

/** A turn is sent sooner after words that make it a question. Chrome's
 * recognizer adds no punctuation, so questions are recognized by words. */
export const QUESTION = {
  'en-US':
    /\b(how|what|where|why|which|who|when|can you|could you|should i|do i|is it|is there|are there)\b/i,
  'nl-NL':
    /\b(hoe|wat|waar|waarom|welke|wie|wanneer|kun je|kunt u|kan ik|moet ik|is het|is er|zijn er)\b/i,
};

export const TEXT = {
  'en-US': {
    title: 'Try something new in Atomic',
    languageLabel: 'Language',
    // HTML
    intro: `<p>
        Thanks for helping! For about 25 minutes you'll try a new part of
        Atomic while a voice moderator (Claude, an AI) asks you what you see
        and think. There are no wrong answers: we are testing the app, not
        you.
      </p>
      <ul>
        <li>Find a quiet place where you can talk, and put on headphones.</li>
        <li>Use Chrome or Edge on a laptop or desktop.</li>
        <li>
          When you start, a second window opens with your own empty Atomic
          drive. Put it next to this one; keep this window open.
        </li>
        <li>
          When Chrome asks what to share, choose your
          <strong>entire screen</strong>, so the moderator sees the Atomic
          window too.
        </li>
      </ul>`,
    unsupported:
      "This browser can't do speech recognition. You can still type your answers, or open this page in Chrome or Edge to talk.",
    // HTML
    consent: `<p><strong>What is recorded and where it goes</strong></p>
      <ul>
        <li>
          Your screen (the window or screen you choose to share) and your
          microphone are recorded and stored on our test server.
        </li>
        <li>
          Your browser turns your speech into text; Chrome does this through
          Google's speech service.
        </li>
        <li>
          That text (or what you type instead), a screenshot of your shared screen at each turn, and the
          app's error log are sent to Anthropic's Claude API to decide what
          the moderator says next.
        </li>
        <li>
          If what you test connects your own accounts (for example Google
          Calendar), the imported data is stored on the test server too. You can disconnect
          afterwards.
        </li>
        <li>
          The recordings are only used to improve Atomic and are deleted
          after analysis.
        </li>
      </ul>`,
    plan: 'What do you want to test?',
    name: 'Your first name (optional)',
    sessionLanguage:
      'The session is in English. You can switch the language at the top of this page at any time.',
    agree: 'I agree to the recording and processing described above.',
    start: 'Start the session',
    ask: 'Ask the moderator',
    askHint: 'or just pause after a question',
    end: 'End the session',
    you: 'You',
    youTyped: 'You (typed)',
    typedLabel:
      "Can't talk out loud, or is the microphone not working? Type your answer here instead.",
    typedPlaceholder: 'Type your answer…',
    send: 'Send',
    sendHint: 'Enter sends; Shift+Enter starts a new line.',
    recording: '● recording',
    noVoice:
      'This browser has no English voice, so the moderator may sound odd.',
    status: {
      starting: 'Starting…',
      thinking: 'Thinking…',
      speaking: 'Speaking…',
      listening: 'Listening…',
      noAnswer:
        'The moderator is not answering. Keep going; it will try again.',
      yourTurn: 'Your turn: type below.',
      micTyping: 'The microphone is not working here. Type your answers below.',
      saving: 'Saving the recording…',
      ended: 'Thank you! The session has ended; you can close both windows.',
    },
    errors: {
      noCode: 'This page needs the invite link you received.',
      notAllowed:
        'The session needs screen sharing. Please allow it and try again.',
      cannotStart: message =>
        `Could not start the session (${message}). Is the invite link complete?`,
    },
  },

  'nl-NL': {
    title: 'Probeer iets nieuws in Atomic',
    languageLabel: 'Taal',
    // HTML
    intro: `<p>
        Bedankt voor je hulp! Ongeveer 25 minuten lang probeer je een nieuw
        deel van Atomic, terwijl een gespreksleider (Claude, een AI) je met
        een stem vraagt wat je ziet en denkt. Er zijn geen foute antwoorden:
        we testen de app, niet jou.
      </p>
      <ul>
        <li>Zoek een rustige plek waar je kunt praten, en zet een koptelefoon op.</li>
        <li>Gebruik Chrome of Edge op een laptop of desktop.</li>
        <li>
          Als je begint, opent een tweede venster met je eigen lege
          Atomic-drive. Zet het naast dit venster; laat dit venster open.
        </li>
        <li>
          Als Chrome vraagt wat je wilt delen, kies dan je
          <strong>hele scherm</strong>, zodat de gespreksleider ook het
          Atomic-venster ziet.
        </li>
        <li>
          De Atomic-app zelf is in het Engels. Dat hoort zo; je hoeft dat
          niet te veranderen.
        </li>
      </ul>`,
    unsupported:
      'Deze browser kan geen spraak herkennen. Je kunt je antwoorden wel typen, of deze pagina in Chrome of Edge openen om te praten.',
    // HTML
    consent: `<p><strong>Wat er wordt opgenomen en waar het heen gaat</strong></p>
      <ul>
        <li>
          Je scherm (het venster of scherm dat je kiest om te delen) en je
          microfoon worden opgenomen en op onze testserver bewaard.
        </li>
        <li>
          Je browser zet je spraak om in tekst; Chrome doet dat via de
          spraakdienst van Google.
        </li>
        <li>
          Die tekst (of wat je in plaats daarvan typt), bij elke beurt een schermafbeelding van je gedeelde
          scherm, en het foutenlog van de app gaan naar de Claude API van
          Anthropic, om te bepalen wat de gespreksleider daarna zegt.
        </li>
        <li>
          Als wat je test je eigen accounts koppelt (bijvoorbeeld Google
          Agenda), worden de geïmporteerde gegevens ook op de testserver
          bewaard. Je
          kunt ze daarna weer ontkoppelen.
        </li>
        <li>
          De opnames worden alleen gebruikt om Atomic te verbeteren en na de
          analyse verwijderd.
        </li>
      </ul>`,
    plan: 'Wat wil je testen?',
    name: 'Je voornaam (optioneel)',
    sessionLanguage:
      'De sessie is in het Nederlands. Je kunt de taal bovenaan deze pagina op elk moment wisselen.',
    agree: 'Ik ga akkoord met de opname en verwerking die hierboven staan.',
    start: 'Start de sessie',
    ask: 'Vraag het de gespreksleider',
    askHint: 'of wacht gewoon even na een vraag',
    end: 'Beëindig de sessie',
    you: 'Jij',
    youTyped: 'Jij (getypt)',
    typedLabel:
      'Kun je niet hardop praten, of werkt de microfoon niet? Typ je antwoord dan hier.',
    typedPlaceholder: 'Typ je antwoord…',
    send: 'Versturen',
    sendHint: 'Enter verstuurt; Shift+Enter begint een nieuwe regel.',
    recording: '● opname loopt',
    noVoice:
      'Deze browser heeft geen Nederlandse stem, dus de gespreksleider kan vreemd klinken.',
    status: {
      starting: 'Bezig met starten…',
      thinking: 'Even denken…',
      speaking: 'Aan het woord…',
      listening: 'Luistert…',
      noAnswer:
        'De gespreksleider antwoordt niet. Ga gewoon door; hij probeert het zo opnieuw.',
      yourTurn: 'Jouw beurt: typ hieronder.',
      micTyping: 'De microfoon werkt hier niet. Typ je antwoorden hieronder.',
      saving: 'De opname wordt opgeslagen…',
      ended: 'Bedankt! De sessie is afgelopen; je kunt beide vensters sluiten.',
    },
    errors: {
      noCode:
        'Deze pagina heeft de uitnodigingslink nodig die je hebt gekregen.',
      notAllowed:
        'De sessie heeft schermdelen nodig. Sta dat toe en probeer het opnieuw.',
      cannotStart: message =>
        `De sessie kon niet starten (${message}). Is de uitnodigingslink compleet?`,
    },
  },
};
