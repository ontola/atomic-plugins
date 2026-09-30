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
    title: "Try Atomic's new plugins",
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
          If you connect your own accounts (for example Google Calendar), the
          imported data is stored on the test server too. You can disconnect
          afterwards.
        </li>
        <li>
          The recordings are only used to improve Atomic and are deleted
          after analysis.
        </li>
      </ul>`,
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
    check: {
      heading: 'Sound check',
      intro:
        "Before you start, check that we can hear you and that you can hear the moderator. Nothing is recorded during this check. Can't talk or no microphone? Choose to type instead.",
      micButton: 'Test microphone',
      micAsking:
        'Your browser asks to use the microphone: choose Allow.',
      micListening: 'The microphone is on. Say something, so we know it hears you.',
      micOk: '✓ We can hear you.',
      levelLabel: 'Microphone level',
      speechButton: 'Check speech recognition (optional)',
      speechNote:
        'Say a short sentence. Chrome sends this to Google to turn it into text, as in the session.',
      speechListening: 'Listening… say a short sentence.',
      speechHeard: words => `✓ Recognized: “${words}”`,
      speechNone: 'No words were recognized. Try again, a bit louder or closer.',
      speechFailed: reason =>
        `Speech recognition did not work (${reason}). You can still talk: the recording has your voice. Or type instead.`,
      speakerButton: 'Test speakers',
      speakerLine:
        'Hello! This is the voice of the moderator. If you can hear me, the sound works.',
      speakerHint: voice =>
        `Playing a line in the moderator's voice (${voice}). No sound? Check the volume and your headphones.`,
      defaultVoice: 'the default voice',
      typeInstead: 'Type instead',
      typedChosen:
        '✓ You will type your answers. The moderator still speaks, so keep the sound on.',
      needCheck:
        'To start, test your microphone above, or choose to type instead.',
    },
    errors: {
      noCode: 'This page needs the invite link you received.',
      wrongCode:
        'The invite code in this link was not accepted. Please open the exact link you received, or ask us for a new one.',
      badLink:
        'The invite link points to a session that does not exist. Please open the exact link you received.',
      tooMany:
        'No more sessions can start today. Please try again tomorrow, or ask us.',
      network:
        'Could not reach the test server. Check your internet connection and try again.',
      retry: 'Try again',
      micDenied:
        'The microphone is blocked for this page. To allow it in Chrome or Edge: click the lock or settings icon left of the address bar, choose Site settings, set Microphone to Allow, then reload this page. Or type instead.',
      noMic:
        'No microphone was found. Connect one (or a headset) and test again, or type instead.',
      micOther: reason =>
        `The microphone could not be opened (${reason}). Close other apps that use it and test again, or type instead.`,
      speechUnsupported:
        "This browser can't do speech recognition. Use Chrome or Edge to talk, or type instead.",
      screenCancelled:
        'Screen sharing was cancelled or blocked. The session needs it: press Start again and choose your entire screen.',
      screenFailed: reason =>
        `Screen sharing did not work (${reason}). Try again, or use Chrome or Edge on a laptop or desktop.`,
      cannotStart: message => `Could not start the session (${message}).`,
    },
  },

  'nl-NL': {
    title: 'Probeer de nieuwe plugins van Atomic',
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
          Als je je eigen accounts koppelt (bijvoorbeeld Google Agenda),
          worden de geïmporteerde gegevens ook op de testserver bewaard. Je
          kunt ze daarna weer ontkoppelen.
        </li>
        <li>
          De opnames worden alleen gebruikt om Atomic te verbeteren en na de
          analyse verwijderd.
        </li>
      </ul>`,
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
    check: {
      heading: 'Geluidstest',
      intro:
        'Controleer voordat je begint of we je kunnen horen en of jij de gespreksleider kunt horen. Tijdens deze test wordt niets opgenomen. Kun je niet praten of heb je geen microfoon? Kies dan voor typen.',
      micButton: 'Test de microfoon',
      micAsking: 'Je browser vraagt om de microfoon te gebruiken: kies Toestaan.',
      micListening:
        'De microfoon staat aan. Zeg iets, zodat we weten dat hij je hoort.',
      micOk: '✓ We kunnen je horen.',
      levelLabel: 'Microfoonniveau',
      speechButton: 'Test de spraakherkenning (optioneel)',
      speechNote:
        'Zeg een korte zin. Chrome stuurt die naar Google om er tekst van te maken, net als in de sessie.',
      speechListening: 'Luistert… zeg een korte zin.',
      speechHeard: words => `✓ Herkend: “${words}”`,
      speechNone:
        'Er zijn geen woorden herkend. Probeer het opnieuw, wat harder of dichterbij.',
      speechFailed: reason =>
        `De spraakherkenning werkte niet (${reason}). Je kunt nog steeds praten: de opname heeft je stem. Of kies voor typen.`,
      speakerButton: 'Test de luidsprekers',
      speakerLine:
        'Hallo! Dit is de stem van de gespreksleider. Als je mij hoort, werkt het geluid.',
      speakerHint: voice =>
        `Er klinkt een zin met de stem van de gespreksleider (${voice}). Geen geluid? Controleer het volume en je koptelefoon.`,
      defaultVoice: 'de standaardstem',
      typeInstead: 'Liever typen',
      typedChosen:
        '✓ Je typt je antwoorden. De gespreksleider praat wel, dus laat het geluid aan.',
      needCheck:
        'Test eerst hierboven je microfoon, of kies voor typen, om te kunnen starten.',
    },
    errors: {
      noCode:
        'Deze pagina heeft de uitnodigingslink nodig die je hebt gekregen.',
      wrongCode:
        'De uitnodigingscode in deze link werd niet geaccepteerd. Open precies de link die je hebt gekregen, of vraag ons om een nieuwe.',
      badLink:
        'De uitnodigingslink verwijst naar een sessie die niet bestaat. Open precies de link die je hebt gekregen.',
      tooMany:
        'Vandaag kunnen er geen sessies meer starten. Probeer het morgen opnieuw, of vraag het ons.',
      network:
        'De testserver is niet bereikbaar. Controleer je internetverbinding en probeer het opnieuw.',
      retry: 'Opnieuw proberen',
      micDenied:
        'De microfoon is geblokkeerd voor deze pagina. Toestaan in Chrome of Edge: klik op het slotje of instellingen-icoon links van de adresbalk, kies Site-instellingen, zet Microfoon op Toestaan en laad deze pagina opnieuw. Of kies voor typen.',
      noMic:
        'Er is geen microfoon gevonden. Sluit er een aan (of een headset) en test opnieuw, of kies voor typen.',
      micOther: reason =>
        `De microfoon kon niet worden geopend (${reason}). Sluit andere apps die hem gebruiken en test opnieuw, of kies voor typen.`,
      speechUnsupported:
        'Deze browser kan geen spraak herkennen. Gebruik Chrome of Edge om te praten, of kies voor typen.',
      screenCancelled:
        'Schermdelen is geannuleerd of geblokkeerd. De sessie heeft het nodig: druk opnieuw op Start en kies je hele scherm.',
      screenFailed: reason =>
        `Schermdelen werkte niet (${reason}). Probeer het opnieuw, of gebruik Chrome of Edge op een laptop of desktop.`,
      cannotStart: message => `De sessie kon niet starten (${message}).`,
    },
  },
};
