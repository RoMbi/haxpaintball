const LANG_KEY = 'haxpaintball.lang';

export const STR = {
  pl: {
    menu: 'Lobby',
    lang: 'Język',
    nick: 'Nick',
    map: 'Mapa',
    roundTime: 'Czas gry (min)',
    winsNeeded: 'Punkty do wygranej',
    copy: 'Kopiuj',
    leave: 'Wyjdź',
    shuffle: 'Rozlosuj',
    play: 'Graj',
    resume: 'Wznów',
    serverHost: 'Host na serwerze',
    create: 'Utwórz pokój',
    codePlaceholder: 'kod',
    join: 'Dołącz',
    hotseat: 'lokalnie: WASD/strzałki + X/Spacja, przeładowanie Z · drugi gracz IJKL + U, przeładowanie O · zoom: Page Up/Down, +/- lub kółko',
    room: 'Pokój {code}',
    player: 'gracz',
    red: 'czerwony',
    blue: 'niebieski',
    sizeSmall: 'Małe',
    sizeMedium: 'Średnie',
    sizeLarge: 'Duże',
    copied: 'Skopiowano kod',
    connecting: 'Łączenie…',
    noResponse: 'Brak odpowiedzi serwera',
    needCode: 'Podaj kod pokoju',
    mapListFailed: 'Nie można wczytać listy map',
    mapFailed: 'Nie można wczytać mapy {name}',
    connectionClosed: 'Połączenie zamknięte',
    error: 'Błąd',
    cannotConnect: 'Nie można połączyć z serwerem',
    connectionLost: 'Połączenie zerwane',
    hudRed: 'czerwoni',
    hudBlue: 'niebiescy',
    overtime: 'dogrywka',
    roomHud: 'pokój {code}',
    reloading: 'przeładowanie {time}s',
    balls: 'kulki {count}/{max}',
    mapName: {
      'small-cross': 'Mała - krzyż',
      'small-alley': 'Mała - aleja',
      'small-bunker': 'Mała - bunkry',
      'medium-cross': 'Średnia - krzyż',
      'medium-alley': 'Średnia - aleja',
      'medium-bunker': 'Średnia - bunkry',
      'large-cross': 'Duża - krzyż',
      'large-alley': 'Duża - aleja',
      'large-bunker': 'Duża - bunkry',
    },
    msg: {
      waiting: 'Czekam na graczy',
      paused: 'Pauza',
      overtime: 'Dogrywka',
      redRound: 'Czerwoni wygrywają rundę',
      blueRound: 'Niebiescy wygrywają rundę',
      redMatch: 'Czerwoni wygrywają mecz',
      blueMatch: 'Niebiescy wygrywają mecz',
    },
    err: {
      already_in_room: 'Już jesteś w pokoju',
      bad_team: 'Nieprawidłowa drużyna',
      missing_code: 'Brak kodu pokoju',
      no_room: 'Nie ma takiego pokoju',
      room_full: 'Pokój jest pełny',
      need_both_teams: 'Potrzeba graczy w obu drużynach',
      host_closed: 'Host zamknął pokój',
    },
  },
  en: {
    menu: 'Lobby',
    lang: 'Language',
    nick: 'Nick',
    map: 'Map',
    roundTime: 'Round time (min)',
    winsNeeded: 'Points to win',
    copy: 'Copy',
    leave: 'Leave',
    shuffle: 'Shuffle',
    play: 'Play',
    resume: 'Resume',
    serverHost: 'Host on server',
    create: 'Create room',
    codePlaceholder: 'code',
    join: 'Join',
    hotseat: 'local: WASD/arrows + X/Space, reload Z · second player IJKL + U, reload O · zoom: Page Up/Down, +/- or wheel',
    room: 'Room {code}',
    player: 'player',
    red: 'red',
    blue: 'blue',
    sizeSmall: 'Small',
    sizeMedium: 'Medium',
    sizeLarge: 'Large',
    copied: 'Code copied',
    connecting: 'Connecting…',
    noResponse: 'No response from server',
    needCode: 'Enter a room code',
    mapListFailed: 'Could not load the map list',
    mapFailed: 'Could not load map {name}',
    connectionClosed: 'Connection closed',
    error: 'Error',
    cannotConnect: 'Could not connect to the server',
    connectionLost: 'Connection lost',
    hudRed: 'red',
    hudBlue: 'blue',
    overtime: 'overtime',
    roomHud: 'room {code}',
    reloading: 'reloading {time}s',
    balls: 'balls {count}/{max}',
    mapName: {
      'small-cross': 'Small - cross',
      'small-alley': 'Small - alley',
      'small-bunker': 'Small - bunkers',
      'medium-cross': 'Medium - cross',
      'medium-alley': 'Medium - alley',
      'medium-bunker': 'Medium - bunkers',
      'large-cross': 'Large - cross',
      'large-alley': 'Large - alley',
      'large-bunker': 'Large - bunkers',
    },
    msg: {
      waiting: 'Waiting for players',
      paused: 'Paused',
      overtime: 'Overtime',
      redRound: 'Red win the round',
      blueRound: 'Blue win the round',
      redMatch: 'Red win the match',
      blueMatch: 'Blue win the match',
    },
    err: {
      already_in_room: 'You are already in a room',
      bad_team: 'Invalid team',
      missing_code: 'Missing room code',
      no_room: 'No such room',
      room_full: 'Room is full',
      need_both_teams: 'Need players on both teams',
      host_closed: 'Host closed the room',
    },
  },
};

const LEGACY_MSG = {
  'Czekam na graczy': 'waiting',
  Pauza: 'paused',
  Dogrywka: 'overtime',
  'Czerwoni wygrywają rundę': 'redRound',
  'Niebiescy wygrywają rundę': 'blueRound',
  'Czerwoni wygrywają mecz': 'redMatch',
  'Niebiescy wygrywają mecz': 'blueMatch',
};

const LEGACY_ERR = {
  'Już jesteś w pokoju': 'already_in_room',
  'Nieprawidłowa drużyna': 'bad_team',
  'Brak kodu pokoju': 'missing_code',
  'Nie ma takiego pokoju': 'no_room',
  'Pokój jest pełny': 'room_full',
  'Potrzeba graczy w obu drużynach': 'need_both_teams',
  'Host zamknął pokój': 'host_closed',
  'Połączenie zamknięte': 'connectionClosed',
  'Połączenie zerwane': 'connectionLost',
  'Nie można połączyć z serwerem': 'cannotConnect',
  Błąd: 'error',
};

let lang = 'pl';

export function getLang() {
  return lang;
}

export function loadLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'pl' || saved === 'en') lang = saved;
  } catch {
    // Storage unavailable. Polish stays the default.
  }
  return lang;
}

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'pl';
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Private mode can reject storage. The choice still applies this visit.
  }
  return lang;
}

export function t(key, vars) {
  const pack = STR[lang] || STR.pl;
  let text = pack[key];
  if (text == null) text = STR.pl[key];
  if (typeof text !== 'string') return key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] == null ? match : String(vars[name])));
}

export function mapName(id, fallback) {
  const names = (STR[lang] || STR.pl).mapName;
  if (names && names[id]) return names[id];
  return fallback || id;
}

export function matchMessage(code) {
  if (!code) return '';
  const key = LEGACY_MSG[code] || code;
  const pack = (STR[lang] || STR.pl).msg;
  if (pack && pack[key]) return pack[key];
  if (STR.pl.msg[key]) return STR.pl.msg[key];
  return code;
}

export function serverError(code) {
  if (!code) return t('error');
  if (code === 'connectionClosed' || code === 'connectionLost' || code === 'cannotConnect' || code === 'error') {
    return t(code);
  }
  const key = LEGACY_ERR[code] || code;
  if (key === 'connectionClosed' || key === 'connectionLost' || key === 'cannotConnect' || key === 'error') {
    return t(key);
  }
  const pack = (STR[lang] || STR.pl).err;
  if (pack && pack[key]) return pack[key];
  if (STR.pl.err[key]) return STR.pl.err[key];
  return code;
}
