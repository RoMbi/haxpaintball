import {
  DT,
  MAX_PAINT,
  MAG_SIZE,
  ROUND_TIME,
  WINS_NEEDED,
  SNAPSHOT_EVERY,
  TEAM_RED,
  TEAM_BLUE,
  TEAM_SPEC,
  PLAYER_RADIUS,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_INHERIT,
  BULLET_LIFE,
  BULLET_COOLDOWN,
  BULLET_TAP_RATE,
  MARKER_ALONG,
  MARKER_RIGHT,
  MARKER_TIP,
} from '../shared/constants.js';
import {
  createMatch,
  clampRules,
  addPlayer,
  removePlayer,
  setInput,
  canStart,
  start,
  pauseMatch,
  applyInput,
  integratePlayer,
  step,
} from './host.js';
import { MAP_WASD, MAP_IJKL, createInput } from './input.js';
import { createRenderer, getZoom, setZoom, loadZoom } from './render.js';
import { t, loadLang, setLang, mapName, matchMessage, serverError } from './i18n.js';
import { createNet } from './net.js';
import { createClientMetrics } from './metrics.js';

const LOCAL_RED = 'local-red';
const LOCAL_BLUE = 'local-blue';
const NICK_KEY = 'haxpaintball.nick';
const MAP_KEY = 'haxpaintball.map';
const RULES_KEY = 'haxpaintball.rules';
let MAPS = [];
const PAINT_LIFE = 12;
const MAX_STEPS = 5;
// Render behind the newest snapshot so a frame always has two samples to blend.
const INTERP_INTERVALS = 2;
const INTERP_DELAY = SNAPSHOT_EVERY * DT * INTERP_INTERVALS;
const INTERP_DELAY_MAX = 0.15;
const INTERP_QUIET_MS = 2000;
const SNAP_BUFFER = 32;
const INPUT_HISTORY = 32;
// Own disc is predicted. Error under this blends in. Past it, the disc is wrong enough to snap.
const CORRECT_BLEND = 0.3;
const CORRECT_SNAP = 80;
// Own shot is drawn from the muzzle on the tick the key went down.
// The referee copy of that shot is already in the past, so it is not drawn.
const LOCAL_BULLETS = 8;

const canvas = document.querySelector('#view');
const lobbyEl = document.querySelector('#lobby');
const menuBtn = document.querySelector('#menu');
const langPick = document.querySelector('#lang-pick');
const langEl = document.querySelector('#lang');
const splashEl = document.querySelector('#splash');
const hotseatEl = document.querySelector('#hotseat');
const nickEl = document.querySelector('#nick');
const codeEl = document.querySelector('#code');
const statusEl = document.querySelector('#status');
const createBtn = document.querySelector('#create');
const serverHostEl = document.querySelector('#server-host');
const serverHostCheck = document.querySelector('#server-host-check');
const joinBtn = document.querySelector('#join');
const joinRow = document.querySelector('#join-row');
const roomBar = document.querySelector('#room-bar');
const roomCodeEl = document.querySelector('#room-code');
const copyCodeBtn = document.querySelector('#copy-code');
const leaveBtn = document.querySelector('#leave');
const shuffleBtn = document.querySelector('#shuffle');
const playBtn = document.querySelector('#play');
const teamsEl = document.querySelector('#teams');
const listRed = document.querySelector('#list-red');
const listSpec = document.querySelector('#list-spec');
const listBlue = document.querySelector('#list-blue');
const mapPick = document.querySelector('#map-pick');
const roundTimeEl = document.querySelector('#round-time');
const winsNeededEl = document.querySelector('#wins-needed');
const rulesRow = document.querySelector('#rules-row');

const renderer = createRenderer(canvas);
const wasd = createInput(window, MAP_WASD);
const ijkl = createInput(window, MAP_IJKL);

let map = null;
let mapId = 'medium-cross';
const mapsById = new Map();
let match = null;
let mode = 'local';
let selfId = LOCAL_RED;
let roomCode = '';
let transport = 'none';
let roster = [];
let pickedTeam = TEAM_SPEC;
let isHost = false;
let serverHost = false;
let connecting = false;
let inputSeq = 0;
let sentInputs = [];
let sentAck = 0;
let latestSnap = null;
let latestSnapAt = 0;
let snapBuffer = [];
let paint = [];
let seenEventId = 0;
let seenDeathId = 0;
let hostEventAcks = new Map();
let renderDelay = INTERP_DELAY * 1000;
let delayQuietSince = 0;
// Local body for anyone who is not the referee. Rendered live, corrected from snapshots.
let predicted = null;
let predictedAck = 0;
let localBullets = [];
let triggerWasDown = false;
let shotCooldown = 0;

const metrics = createClientMetrics();
const net = createNet({
  onWelcome,
  onRoster,
  onGame,
  onClosed,
  onError,
  onTransport,
});

function setStatus(text) {
  statusEl.textContent = text || '';
}

function showLobby(show) {
  lobbyEl.classList.toggle('hidden', !show);
  lobbyEl.hidden = !show;
  splashEl.classList.toggle('hidden', !show);
  splashEl.hidden = !show;
  hotseatEl.classList.toggle('hidden', mode !== 'local' || show);
  menuBtn.classList.toggle('hidden', show);
  langPick.classList.toggle('hidden', !show);
  // Menu keys must type, not steer. Clear any key already held when it opens.
  wasd.setBlocked(show);
  ijkl.setBlocked(show);
  // Hidden inputs keep focus, so the match looks live while controls never read.
  if (!show && lobbyEl.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  renderTeams();
  renderMapPick();
  renderRules();
}

function renderTeams() {
  const inRoom = mode === 'host' || mode === 'guest';
  roomBar.classList.toggle('visible', inRoom);
  roomCodeEl.textContent = inRoom && roomCode ? t('room', { code: roomCode }) : '';
  createBtn.hidden = inRoom;
  serverHostEl.hidden = inRoom;
  joinRow.hidden = inRoom;
  teamsEl.classList.toggle('visible', inRoom);
  shuffleBtn.classList.toggle('visible', inRoom && isHost);
  const paused = serverHost
    ? !!(latestSnap && latestSnap.phase === 'paused')
    : !!(match && match.phase === 'paused');
  const canPlay = paused || sidesReady();
  playBtn.textContent = (serverHost ? latestSnap && latestSnap.phase === 'paused' : paused) ? t('resume') : t('play');
  playBtn.classList.toggle('visible', inRoom && isHost && canPlay);
  teamsEl.querySelector('#pick-red').classList.toggle('picked', pickedTeam === TEAM_RED);
  teamsEl.querySelector('#pick-spec').classList.toggle('picked', pickedTeam === TEAM_SPEC);
  teamsEl.querySelector('#pick-blue').classList.toggle('picked', pickedTeam === TEAM_BLUE);
  fillTeamList(listRed, TEAM_RED);
  fillTeamList(listSpec, TEAM_SPEC);
  fillTeamList(listBlue, TEAM_BLUE);
}

function fillTeamList(list, team) {
  list.replaceChildren();
  const members = inRoomRoster().filter((player) => player.team === team);
  if (!members.length) {
    const empty = document.createElement('li');
    empty.textContent = '—';
    list.appendChild(empty);
    return;
  }
  for (const member of members) {
    const item = document.createElement('li');
    item.textContent = member.nick || t('player');
    if (member.id === selfId) item.classList.add('self');
    list.appendChild(item);
  }
}

function sidesReady() {
  if (serverHost) {
    if (!latestSnap) return false;
    if (latestSnap.phase !== 'waiting' && latestSnap.phase !== 'match_end') return false;
  } else if (!match || (match.phase !== 'waiting' && match.phase !== 'match_end')) {
    return false;
  }
  let red = 0;
  let blue = 0;
  for (const player of inRoomRoster()) {
    if (player.team === TEAM_RED) red += 1;
    else if (player.team === TEAM_BLUE) blue += 1;
  }
  return red >= 1 && blue >= 1;
}

function inRoomRoster() {
  if (mode === 'host' || mode === 'guest') return roster;
  return [{ id: selfId, nick: nickOr(t('red')), team: pickedTeam }];
}

function nickOr(fallback) {
  const nick = nickEl.value.trim();
  return nick || fallback;
}

function rememberNick() {
  const nick = nickEl.value.trim().slice(0, 16);
  try {
    if (nick) localStorage.setItem(NICK_KEY, nick);
  } catch {
    // Private mode can reject storage. The field still works for this visit.
  }
}

function loadNick() {
  try {
    const saved = localStorage.getItem(NICK_KEY);
    if (saved) nickEl.value = saved.slice(0, 16);
  } catch {
    // Storage unavailable.
  }
}

function loadMapChoice() {
  try {
    const saved = localStorage.getItem(MAP_KEY);
    if (saved && mapsById.has(saved)) mapId = saved;
  } catch {
    // Storage unavailable.
  }
}

function rememberMap() {
  try {
    localStorage.setItem(MAP_KEY, mapId);
  } catch {
    // Private mode can reject storage.
  }
}

function renderMapPick() {
  const current = mapPick.value;
  mapPick.replaceChildren();
  let group = null;
  let groupSize = '';
  for (const entry of MAPS) {
    if (entry.size !== groupSize) {
      groupSize = entry.size;
      group = document.createElement('optgroup');
      group.label = entry.size === 'small' ? t('sizeSmall') : entry.size === 'large' ? t('sizeLarge') : t('sizeMedium');
      mapPick.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = mapName(entry.id, entry.name);
    group.appendChild(option);
  }
  mapPick.value = mapsById.has(mapId) ? mapId : (MAPS[0] ? MAPS[0].id : current);
  mapPick.disabled = mode === 'guest' || (mode === 'host' && !isHost);
}

function currentRules() {
  return clampRules({
    roundTime: Number(roundTimeEl.value) * 60,
    winsNeeded: winsNeededEl.value,
  });
}

function applyRulesToFields(rules) {
  const picked = clampRules(rules);
  roundTimeEl.value = String(Math.round(picked.roundTime / 60));
  winsNeededEl.value = String(picked.winsNeeded);
}

function rememberRules() {
  const rules = currentRules();
  applyRulesToFields(rules);
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
  } catch {
    // Private mode can reject storage.
  }
  return rules;
}

function loadRules() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(RULES_KEY) || 'null');
  } catch {
    saved = null;
  }
  applyRulesToFields(saved || { roundTime: ROUND_TIME, winsNeeded: WINS_NEEDED });
}

function renderRules() {
  const locked = mode === 'guest' || (serverHost && !isHost);
  rulesRow.hidden = mode === 'guest';
  roundTimeEl.disabled = locked;
  winsNeededEl.disabled = locked;
}

function selectedMap() {
  return mapsById.get(mapId) || null;
}

function applyMap(id, restart) {
  const next = mapsById.get(id);
  if (!next) return false;
  mapId = next.id || id;
  rememberMap();
  renderMapPick();
  if (mode === 'host' && isHost) net.setMap(mapId);
  if (!restart || mode === 'guest') return true;
  if (mode === 'host') {
    if (serverHost) return true;
    if (!isHost || (match && match.phase !== 'waiting' && match.phase !== 'match_end')) return true;
    rebuildHostMatch();
    return true;
  }
  resetLocalMatch();
  return true;
}

function rebuildHostMatch() {
  const next = selectedMap();
  if (!next) return;
  map = null;
  match = createMatch(next, rememberRules());
  match.phase = 'waiting';
  for (const entry of roster) {
    if (teamOf(entry.team) === TEAM_SPEC) continue;
    addPlayer(match, { id: entry.id, nick: entry.nick, team: entry.team });
  }
  paint = [];
  seenEventId = 0;
  seenDeathId = 0;
  tryStart();
}

function teamOf(value) {
  if (value === TEAM_BLUE) return TEAM_BLUE;
  if (value === TEAM_SPEC) return TEAM_SPEC;
  return TEAM_RED;
}

function resetLocalMatch() {
  map = null;
  match = createMatch(selectedMap() || { id: mapId, width: 1, height: 1, spawns: {} }, rememberRules());
  addPlayer(match, { id: LOCAL_RED, nick: nickOr(t('red')), team: TEAM_RED });
  addPlayer(match, { id: LOCAL_BLUE, nick: t('blue'), team: TEAM_BLUE });
  mode = 'local';
  selfId = LOCAL_RED;
  roomCode = '';
  transport = 'none';
  roster = [];
  isHost = false;
  serverHost = false;
  inputSeq = 0;
  latestSnap = null;
  latestSnapAt = 0;
  snapBuffer = [];
  sentInputs = [];
  sentAck = 0;
  paint = [];
  seenEventId = 0;
  seenDeathId = 0;
  predicted = null;
  predictedAck = 0;
  clearLocalShots();
  showLobby(true);
}

function ensureHotseat() {
  if (mode !== 'local' || !match) return;
  if (!match.players.some((player) => player.id === LOCAL_BLUE)) {
    addPlayer(match, { id: LOCAL_BLUE, nick: t('blue'), team: TEAM_BLUE });
  }
}

function syncLocalNick() {
  if (!match || mode !== 'local') return;
  if (match.phase !== 'waiting' && match.phase !== 'match_end') return;
  const self = match.players.find((player) => player.id === LOCAL_RED);
  if (self) self.nick = nickOr(t('red'));
}

function tryStart() {
  if (mode === 'host') {
    renderTeams();
    return;
  }
  if (!match || mode === 'guest') return;
}

function rosterOpen() {
  const phase = serverHost || mode === 'guest'
    ? (latestSnap && latestSnap.phase)
    : (match && match.phase);
  if (!phase) return true;
  return phase === 'waiting' || phase === 'match_end';
}

function dropDisc(player) {
  player.alive = false;
  player.mask = 0;
  player.vx = 0;
  player.vy = 0;
}

function syncHostDiscs() {
  if (serverHost || mode !== 'host' || !match) return;
  const open = rosterOpen();
  const live = new Set();
  for (const entry of roster) {
    if (teamOf(entry.team) === TEAM_SPEC) continue;
    live.add(entry.id);
    if (!open) continue;
    const disc = match.players.find((player) => player.id === entry.id);
    if (!disc) {
      addPlayer(match, { id: entry.id, nick: entry.nick, team: entry.team });
      continue;
    }
    if (disc.team !== entry.team) {
      removePlayer(match, entry.id);
      addPlayer(match, { id: entry.id, nick: entry.nick, team: entry.team });
    } else {
      disc.nick = entry.nick;
    }
  }
  for (const player of match.players.slice()) {
    if (live.has(player.id)) continue;
    if (open) removePlayer(match, player.id);
    else dropDisc(player);
  }
  tryStart();
}

function releaseHostDeparted() {
  if (serverHost || mode !== 'host' || !match || match.phase !== 'round_end') return;
  const live = new Set();
  for (const entry of roster) {
    if (teamOf(entry.team) !== TEAM_SPEC) live.add(entry.id);
  }
  for (const player of match.players.slice()) {
    if (!live.has(player.id)) removePlayer(match, player.id);
  }
}

function ingestHits(events) {
  if (!events) return;
  for (const event of events) {
    if (!event) continue;
    const id = event.id | 0;
    if (event.type === 'death') {
      // Death is an event, not "the disc vanished from the interp buffer".
      // A late packet still has to flash even if its id was already counted as paint.
      if (id > seenDeathId && event.victimId === selfId) {
        seenDeathId = id;
        renderer.flashDeath();
      }
      continue;
    }
    if (event.type !== 'hit') continue;
    if (id <= seenEventId) continue;
    seenEventId = id;
    paint.push({
      x: event.x,
      y: event.y,
      team: event.colorTeam || event.team,
      age: 0,
    });
  }
  while (paint.length > MAX_PAINT) paint.shift();
}

function agePaint(frameDt) {
  for (const spot of paint) spot.age += frameDt;
  paint = paint.filter((spot) => spot.age < PAINT_LIFE);
  for (const spot of paint) spot.alpha = Math.max(0, 1 - spot.age / PAINT_LIFE);
}

function paintFromMatch() {
  ingestHits(match.recentEvents);
}

function paintFromSnapshot(snap) {
  if (!snap) return;
  ingestHits(snap.events);
}

function findSnapPlayer(snap, id) {
  if (!snap || !snap.players) return null;
  return snap.players.find((player) => player.id === id) || null;
}

function rosterOf(id) {
  return roster.find((player) => player.id === id) || null;
}

function hydratePlayer(raw) {
  if (!raw) return null;
  const known = rosterOf(raw.id);
  const player = {
    ...raw,
    nick: known ? known.nick : (raw.nick || ''),
    team: known && known.team ? known.team : (raw.team || ''),
  };
  if (!Number.isFinite(player.fx) || !Number.isFinite(player.fy)) {
    const angle = Number.isFinite(raw.facing) ? raw.facing : 0;
    player.fx = Math.cos(angle);
    player.fy = Math.sin(angle);
  }
  return player;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  const from = Number.isFinite(a) ? a : 0;
  const to = Number.isFinite(b) ? b : from;
  let delta = to - from;
  delta -= Math.PI * 2 * Math.round(delta / (Math.PI * 2));
  return from + delta * t;
}

function facingOf(fx, fy) {
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return 0;
  return Math.atan2(fy, fx);
}

function pushSnap(snap, nowMs) {
  if (!snap) return false;
  const last = snapBuffer[snapBuffer.length - 1];
  if (last && snap.tick <= last.snap.tick) return false;
  const tick = snap.tick | 0;
  let at = nowMs;
  if (last) {
    const simGap = (tick - last.snap.tick) * DT * 1000;
    const arrived = nowMs - last.at;
    // A burst must not collapse the timeline. A late packet must not invent time.
    at = last.at + Math.min(Math.max(0, simGap), Math.max(0, arrived));
  }
  snapBuffer.push({ snap, at, tick });
  if (snapBuffer.length > SNAP_BUFFER) snapBuffer.shift();
  return true;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function noteSnapGap(nowMs) {
  if (snapBuffer.length < 2) return;
  const gaps = [];
  const start = Math.max(1, snapBuffer.length - 16);
  for (let i = start; i < snapBuffer.length; i += 1) {
    const gap = snapBuffer[i].at - snapBuffer[i - 1].at;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return;
  const floor = INTERP_DELAY * 1000;
  const cap = INTERP_DELAY_MAX * 1000;
  const raised = Math.min(cap, Math.max(floor, percentile(gaps, 0.95) * 1.5));
  if (raised > renderDelay + 1) {
    renderDelay = raised;
    delayQuietSince = 0;
    return;
  }
  // Back to two snapshot intervals only after the gap has stayed down.
  if (raised <= floor + 1 && renderDelay > floor + 1) {
    if (!delayQuietSince) delayQuietSince = nowMs;
    if (nowMs - delayQuietSince >= INTERP_QUIET_MS) renderDelay = floor;
    return;
  }
  delayQuietSince = 0;
}

function renderDelayMs() {
  return renderDelay;
}

function interpSpan(nowMs) {
  if (snapBuffer.length === 0) return null;
  const target = nowMs - renderDelayMs();
  let to = snapBuffer[0];
  let from = snapBuffer[0];
  for (let i = 0; i < snapBuffer.length; i += 1) {
    if (snapBuffer[i].at <= target) from = snapBuffer[i];
    if (snapBuffer[i].at >= target) {
      to = snapBuffer[i];
      break;
    }
    to = snapBuffer[i];
  }
  const span = to.at - from.at;
  const t = from === to || span <= 0 ? 1 : Math.min(1, Math.max(0, (target - from.at) / span));
  return { from: from.snap, to: to.snap, t };
}

function blendPair(before, after, t, fields) {
  const blended = { ...after };
  for (const field of fields) {
    blended[field] = lerp(before[field], after[field], t);
  }
  return blended;
}

function blendPlayer(before, after, t) {
  const blended = blendPair(before, after, t, ['x', 'y']);
  const angle = lerpAngle(
    Number.isFinite(before.facing) ? before.facing : facingOf(before.fx, before.fy),
    Number.isFinite(after.facing) ? after.facing : facingOf(after.fx, after.fy),
    t,
  );
  blended.facing = angle;
  blended.fx = Math.cos(angle);
  blended.fy = Math.sin(angle);
  blended.nick = after.nick || before.nick || '';
  blended.team = after.team || before.team || '';
  return blended;
}

function blendBullet(before, after, t) {
  const blended = blendPair(before, after, t, ['x', 'y']);
  blended.angle = lerpAngle(before.angle, after.angle, t);
  return blended;
}

function drawPlayersFromSpan(span) {
  const players = [];
  for (const raw of span.to.players || []) {
    const remote = hydratePlayer(raw);
    const beforeRaw = span.from.players
      ? span.from.players.find((player) => player.id === remote.id)
      : null;
    const before = hydratePlayer(beforeRaw);
    if (!before || before.alive !== remote.alive) {
      players.push(remote);
      continue;
    }
    players.push(blendPlayer(before, remote, span.t));
  }
  return players;
}

function drawBulletsFromSpan(span) {
  const bullets = [];
  for (const bullet of span.to.bullets || []) {
    const before = span.from.bullets
      ? span.from.bullets.find((item) => item.id === bullet.id)
      : null;
    if (!before) {
      bullets.push(bullet);
      continue;
    }
    bullets.push(blendBullet(before, bullet, span.t));
  }
  return bullets;
}

function ammoOf(player) {
  if (!player) return null;
  return {
    ammo: player.ammo == null ? MAG_SIZE : player.ammo,
    max: MAG_SIZE,
    reloading: !!player.reloading,
    reloadLeft: player.reloadLeft || 0,
    reloadDuration: player.reloadDuration || 0,
  };
}

function selfAmmo(source) {
  if (mode === 'guest' && latestSnap) return ammoOf(findSnapPlayer(latestSnap, selfId));
  const players = source && source.players;
  if (!players) return null;
  return ammoOf(players.find((player) => player.id === selfId));
}

function hudFrom(source) {
  const score = source.score || { red: 0, blue: 0 };
  return {
    score,
    timeLeft: source.timeLeft,
    phase: source.phase,
    message: matchMessage(source.message),
    overtime: !!source.overtime,
    roomCode,
    transport: mode === 'local' ? '' : transport,
    roster: mode === 'local' ? [] : roster,
    ammo: selfAmmo(source),
  };
}

function fieldVisible() {
  if (mode === 'guest' || serverHost) {
    return !!(latestSnap && (latestSnap.phase === 'playing' || latestSnap.phase === 'round_end'));
  }
  if (mode === 'local') return false;
  return !!(match && (match.phase === 'playing' || match.phase === 'round_end'));
}

function needsPrediction() {
  return mode === 'guest' || serverHost;
}

function buildView() {
  const visibleMap = fieldVisible() ? map : null;
  if (needsPrediction() && latestSnap) {
    const span = interpSpan(performance.now());
    const players = span ? drawPlayersFromSpan(span) : [];
    if (predicted && predicted.alive) {
      const idx = players.findIndex((player) => player.id === selfId);
      const body = drawPredicted();
      if (idx >= 0) players[idx] = body;
      else players.push(body);
    }
    return {
      map: visibleMap,
      players,
      bullets: span ? drawOwnShots(drawBulletsFromSpan(span)) : localBullets.slice(),
      paint,
      selfId,
      los: true,
      hud: hudFrom(latestSnap),
    };
  }
  return {
    map: visibleMap,
    players: match ? match.players : [],
    bullets: match ? match.bullets : [],
    paint,
    selfId,
    los: mode !== 'local',
    hud: match ? hudFrom(match) : hudFrom({}),
  };
}

function stepLocalOrHost() {
  syncLocalNick();
  ensureHotseat();
  const red = match.players.find((player) => player.id === (mode === 'local' ? LOCAL_RED : selfId));
  if (red && (mode === 'local' || mode === 'host')) {
    const mask = wasd.sample();
    inputSeq += 1;
    setInput(match, red.id, mask, inputSeq);
  }
  if (mode === 'local') {
    const blue = match.players.find((player) => player.id === LOCAL_BLUE);
    if (blue) setInput(match, LOCAL_BLUE, ijkl.sample(), match.tick + 1);
  }
  tryStart();
  releaseHostDeparted();
  step(match);
  paintFromMatch();
}

function flushHostSnapshot(force) {
  if (mode !== 'host' || serverHost || !match || roster.length < 2) return;
  const waiting = match.phase === 'waiting' || match.phase === 'match_end';
  if (!force && !waiting && match.tick % SNAPSHOT_EVERY !== 0) return;
  const since = {};
  for (const [id, ack] of hostEventAcks) since[id] = ack;
  net.sendSnapshot(match, since);
}

function rememberInput(seq, mask) {
  const bits = mask | 0;
  // One entry per sampled tick. The shoot bit stays on the tick the key went down.
  sentInputs.push({ seq, mask: bits });
  if (sentInputs.length > INPUT_HISTORY) sentInputs.shift();
  return bits;
}

function dropAckedInputs(ack) {
  const confirmed = ack | 0;
  if (confirmed > predictedAck) predictedAck = confirmed;
  while (sentInputs.length && sentInputs[0].seq <= predictedAck) sentInputs.shift();
}

function seedPredicted(raw) {
  const body = hydratePlayer(raw);
  if (!body) return null;
  body.alive = raw.alive !== false;
  body.vx = Number(raw.vx) || 0;
  body.vy = Number(raw.vy) || 0;
  body.invuln = Number(raw.invuln) || 0;
  body.cooldown = 0;
  body.triggerWasDown = false;
  return body;
}

function drawPredicted() {
  const known = rosterOf(selfId);
  return {
    ...predicted,
    id: selfId,
    nick: known ? known.nick : (predicted.nick || ''),
    team: known && known.team ? known.team : (predicted.team || pickedTeam),
    facing: facingOf(predicted.fx, predicted.fy),
  };
}

function correctPredicted(remote) {
  if (!predicted || !remote) return;
  if (remote.alive === false) {
    predicted.alive = false;
    predicted.x = remote.x;
    predicted.y = remote.y;
    predicted.vx = 0;
    predicted.vy = 0;
    return;
  }
  if (!predicted.alive) {
    predicted = seedPredicted(remote);
    return;
  }
  const dx = remote.x - predicted.x;
  const dy = remote.y - predicted.y;
  const err = Math.hypot(dx, dy);
  metrics.noteReconcile(err);
  // Velocity stays local. Snapshot vx is rounded to 1 px/s, so blending it
  // every 30 Hz tugs the disc and reads as stutter.
  if (err >= CORRECT_SNAP) {
    predicted.x = remote.x;
    predicted.y = remote.y;
    predicted.vx = Number(remote.vx) || 0;
    predicted.vy = Number(remote.vy) || 0;
  } else if (err > 0.5) {
    predicted.x += dx * CORRECT_BLEND;
    predicted.y += dy * CORRECT_BLEND;
  }
  if (remote.invuln != null) predicted.invuln = Number(remote.invuln) || 0;
}

// Replay masks the referee has not consumed yet, on top of the confirmed pose.
// Shots stay with the referee. This only moves the local disc.
function replayUnacked(body) {
  const field = predictMap();
  if (!body || !field) return;
  for (const entry of sentInputs) {
    if (entry.seq <= predictedAck) continue;
    applyInput(body, entry.mask, DT);
    integratePlayer(body, field, DT);
  }
}

function predictMap() {
  if (map) return map;
  return mapsById.get(mapId) || null;
}

function stepPredicted(mask) {
  const field = predictMap();
  if (!predicted || !predicted.alive || !field) return;
  if (pickedTeam === TEAM_SPEC) return;
  applyInput(predicted, mask, DT);
  if (map) integratePlayer(predicted, field, DT);
  else {
    predicted.x += predicted.vx * DT;
    predicted.y += predicted.vy * DT;
  }
  fireLocal(mask);
}

function clearLocalShots() {
  localBullets = [];
  triggerWasDown = false;
  shotCooldown = 0;
}

function fireLocal(mask) {
  const shooting = (mask & KEY.SHOOT) !== 0;
  shotCooldown = Math.max(0, shotCooldown - DT);
  if (!shooting) {
    triggerWasDown = false;
    return;
  }
  if (triggerWasDown || shotCooldown > 0) return;
  if (!predicted || !predicted.alive) return;
  const remote = latestSnap && findSnapPlayer(latestSnap, selfId);
  if (remote && (remote.reloading || remote.ammo === 0 || remote.alive === false)) return;
  if (remote && remote.invuln > 0) return;
  const shot = muzzleShot(predicted);
  if (!shot) return;
  localBullets.push(shot);
  while (localBullets.length > LOCAL_BULLETS) localBullets.shift();
  triggerWasDown = true;
  shotCooldown = BULLET_TAP_RATE;
}

function muzzleShot(body) {
  let fx = body.fx;
  let fy = body.fy;
  const flen = Math.hypot(fx, fy);
  if (flen < 1e-8) {
    fx = 1;
    fy = 0;
  } else {
    fx /= flen;
    fy /= flen;
  }
  const gripX = body.x + fx * PLAYER_RADIUS * MARKER_ALONG - fy * PLAYER_RADIUS * MARKER_RIGHT;
  const gripY = body.y + fy * PLAYER_RADIUS * MARKER_ALONG + fx * PLAYER_RADIUS * MARKER_RIGHT;
  const muzzle = MARKER_TIP + BULLET_RADIUS + 1;
  return {
    local: true,
    owner: selfId,
    team: body.team || pickedTeam,
    x: gripX + fx * muzzle,
    y: gripY + fy * muzzle,
    vx: fx * BULLET_SPEED + body.vx * BULLET_INHERIT,
    vy: fy * BULLET_SPEED + body.vy * BULLET_INHERIT,
    life: BULLET_LIFE,
    angle: 0,
  };
}

function stepLocalBullets() {
  if (!localBullets.length) return;
  const kept = [];
  for (const bullet of localBullets) {
    bullet.life -= DT;
    if (bullet.life <= 0) continue;
    bullet.x += bullet.vx * DT;
    bullet.y += bullet.vy * DT;
    kept.push(bullet);
  }
  localBullets = kept;
}

// Referee copies of our shots spawn where we were, not where we are. Drop them.
function drawOwnShots(remote) {
  stepLocalBullets();
  const others = [];
  for (const bullet of remote) {
    if (bullet.owner === selfId) continue;
    others.push(bullet);
  }
  return others.concat(localBullets);
}

function stepGuest() {
  if (pickedTeam === TEAM_SPEC) {
    predicted = null;
    clearLocalShots();
    if (seenEventId > sentAck) {
      sentAck = seenEventId;
      net.sendInput(inputSeq, 0, seenEventId);
    }
    return;
  }
  inputSeq += 1;
  const mask = rememberInput(inputSeq, wasd.sample());
  sentAck = seenEventId;
  net.sendInput(inputSeq, mask, seenEventId);
  stepPredicted(mask);
}

function tickMatch() {
  if (mode === 'guest' || serverHost) {
    stepGuest();
    return;
  }
  if (!match) return;
  stepLocalOrHost();
}

function onWelcome(state) {
  connecting = false;
  roomCode = state.roomCode || '';
  transport = state.transport || transport;
  selfId = state.playerId;
  inputSeq = 0;
  sentInputs = [];
  sentAck = 0;
  seenEventId = 0;
  seenDeathId = 0;
  paint = [];
  hostEventAcks = new Map();
  renderDelay = INTERP_DELAY * 1000;
  delayQuietSince = 0;
  predicted = null;
  predictedAck = 0;
  localBullets = [];
  triggerWasDown = false;
  shotCooldown = 0;
  latestSnap = null;
  latestSnapAt = 0;
  snapBuffer = [];
  showLobby(true);
  setStatus('');
  isHost = !!state.isHost;
  serverHost = !!state.serverHost;
  map = null;
  if (state.isHost && !serverHost) {
    mode = 'host';
    if (state.mapId && mapsById.has(state.mapId)) mapId = state.mapId;
    rebuildHostMatch();
  } else {
    mode = serverHost && state.isHost ? 'host' : 'guest';
    match = null;
    if (state.mapId && mapsById.has(state.mapId)) mapId = state.mapId;
  }
  hotseatEl.classList.add('hidden');
  renderTeams();
}

function onRoster(players, state) {
  roster = players.map((player) => ({
    id: player.id,
    nick: player.nick,
    team: player.team,
  }));
  if (state) {
    roomCode = state.roomCode || roomCode;
    transport = state.transport || transport;
    isHost = !!state.isHost;
    serverHost = !!state.serverHost;
    if (state.mapId && mapsById.has(state.mapId) && state.mapId !== mapId) {
      mapId = state.mapId;
      if (mode === 'host' && isHost && match && (match.phase === 'waiting' || match.phase === 'match_end')) {
        rebuildHostMatch();
      }
    }
  }
  const self = roster.find((player) => player.id === selfId);
  if (self) pickedTeam = teamOf(self.team);
  renderTeams();
  syncHostDiscs();
}

function onGame(msg, fromId) {
  if (!msg) return;
  if (msg.t === 'input') {
    if (serverHost || mode !== 'host' || !match) return;
    setInput(match, msg.id || fromId, msg.mask, msg.seq);
    if (fromId && Number.isFinite(Number(msg.ack))) {
      const ack = msg.ack | 0;
      if (ack > (hostEventAcks.get(fromId) || 0)) hostEventAcks.set(fromId, ack);
    }
    return;
  }
  if (msg.t === 'snapshot') {
    if (mode !== 'guest' && !serverHost) return;
    const snap = msg.snap;
    if (!snap) return;
    const snapAt = performance.now();
    if (!pushSnap(snap, snapAt)) return;
    noteSnapGap(snapAt);
    latestSnap = snap;
    latestSnapAt = snapAt;
    if (snap.mapId && mapsById.has(snap.mapId)) {
      const next = mapsById.get(snap.mapId);
      if (mapId !== next.id) mapId = next.id;
      // Waiting still needs the field, or a joiner's local step has nothing to walk on.
      if (map !== next) map = next;
    }
    paintFromSnapshot(snap);
    if (needsPrediction()) adoptPrediction(snap);
    if (snap.phase === 'playing' || snap.phase === 'round_end') showLobby(false);
    else showLobby(true);
  }
}

function adoptPrediction(snap) {
  if (pickedTeam === TEAM_SPEC) {
    predicted = null;
    clearLocalShots();
    return;
  }
  if (snap.phase !== 'playing') clearLocalShots();
  const remote = findSnapPlayer(snap, selfId);
  if (!remote) return;
  const ack = Number.isFinite(Number(remote.ack)) ? remote.ack | 0 : predictedAck;
  dropAckedInputs(ack);
  if (!predicted) {
    predicted = seedPredicted(remote);
    return;
  }
  if (remote.alive === false) {
    predicted.alive = false;
    predicted.vx = 0;
    predicted.vy = 0;
    return;
  }
  if (!predicted.alive) {
    predicted = seedPredicted(remote);
    return;
  }
  // The live body already applied these masks. A snapshot is where we were,
  // so pulling toward it is the lag. Only a real desync (spawn, shove through
  // a wall) is allowed to move the disc.
  const dx = remote.x - predicted.x;
  const dy = remote.y - predicted.y;
  const err = Math.hypot(dx, dy);
  metrics.noteReconcile(err);
  if (err >= CORRECT_SNAP) {
    predicted.x = remote.x;
    predicted.y = remote.y;
    predicted.vx = Number(remote.vx) || 0;
    predicted.vy = Number(remote.vy) || 0;
  }
}

function leaveRoomToSandbox(message) {
  connecting = false;
  if (mode === 'local' && match) {
    setStatus(message || '');
    showLobby(true);
    return;
  }
  resetLocalMatch();
  setStatus(message || '');
}

function onClosed(reason) {
  leaveRoomToSandbox(serverError(reason || 'connectionClosed'));
}

function onError(message) {
  connecting = false;
  setStatus(serverError(message || 'error'));
  showLobby(true);
}

function onTransport(next) {
  transport = next || 'none';
}

function chooseTeam(team) {
  if (mode !== 'host' && mode !== 'guest') return;
  if (!rosterOpen()) return;
  pickedTeam = teamOf(team);
  renderTeams();
  net.setTeam(pickedTeam);
}

nickEl.addEventListener('input', rememberNick);
nickEl.addEventListener('change', rememberNick);

teamsEl.addEventListener('click', (event) => {
  const col = event.target.closest('[data-team]');
  if (!col || !teamsEl.contains(col)) return;
  chooseTeam(col.dataset.team);
});

shuffleBtn.addEventListener('click', () => {
  if (mode !== 'host' || !rosterOpen()) return;
  net.shuffleTeams();
});

function onRulesChanged() {
  const rules = rememberRules();
  if (serverHost) {
    if (isHost) net.setRules(rules);
    return;
  }
  if (!match || mode === 'guest') return;
  if (match.phase !== 'waiting' && match.phase !== 'match_end') return;
  match.rules = rules;
  match.timeLeft = rules.roundTime;
}

roundTimeEl.addEventListener('change', onRulesChanged);
winsNeededEl.addEventListener('change', onRulesChanged);

playBtn.addEventListener('click', () => {
  if (serverHost) {
    if (!isHost) return;
    onRulesChanged();
    net.startMatch();
    return;
  }
  if (mode !== 'host' || !isHost || !match) return;
  if (match.phase === 'paused') {
    start(match);
    showLobby(false);
    return;
  }
  syncHostDiscs();
  if (!canStart(match)) return;
  onRulesChanged();
  const next = selectedMap();
  if (next && match.map !== next) rebuildHostMatch();
  if (!match || !canStart(match)) return;
  start(match);
  map = match.map;
  showLobby(false);
});

function copyWithExecCommand(text) {
  // Selection alone is not enough: execCommand('copy') returns true while the
  // clipboard still holds the previous value. The copy event has to carry the text.
  let copied = '';
  function onCopy(event) {
    event.preventDefault();
    if (event.clipboardData) event.clipboardData.setData('text/plain', text);
    copied = text;
  }
  document.addEventListener('copy', onCopy);
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.removeEventListener('copy', onCopy);
  area.remove();
  return ok && copied === text;
}

async function copyRoomCode(text) {
  const secure = typeof window.isSecureContext === 'boolean' ? window.isSecureContext : false;
  if (secure && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission or a headless/iframe host can reject the async API. Fall through.
    }
  }
  return copyWithExecCommand(text);
}

copyCodeBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!roomCode) return;
  const ok = await copyRoomCode(roomCode);
  setStatus(ok ? t('copied') : roomCode);
});

leaveBtn.addEventListener('click', () => {
  if (mode !== 'host' && mode !== 'guest') return;
  net.leaveRoom();
  net.close();
  leaveRoomToSandbox('');
});

createBtn.addEventListener('click', () => {
  if (connecting) return;
  if (mode !== 'local') return;
  rememberNick();
  connecting = true;
  setStatus(t('connecting'));
  net.connect();
  net.createRoom({
    nick: nickOr(t('red')),
    team: pickedTeam,
    mapId,
    serverHost: serverHostCheck.checked,
  });
  window.setTimeout(() => {
    if (!connecting || mode !== 'local') return;
    connecting = false;
    setStatus(t('noResponse'));
  }, 4000);
});

joinBtn.addEventListener('click', () => {
  if (connecting) return;
  if (mode !== 'local') return;
  const code = codeEl.value.trim();
  if (!code) {
    setStatus(t('needCode'));
    return;
  }
  rememberNick();
  connecting = true;
  setStatus(t('connecting'));
  net.connect();
  net.joinRoom({ code, nick: nickOr(t('player')), team: pickedTeam });
});

let last = 0;
let simClock = 0;
let simSteps = 0;

const SIM_LATE_MS = 250;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // A hidden tab must not replay the gap. The next tick starts from now.
  simClock = 0;
  last = 0;
});

function simActive() {
  return !!(match || mode === 'guest' || serverHost);
}

// Fixed 60 Hz on the display clock. setTimeout in a background tab drifts,
// and that drift is what made a keypress land a second late.
function tickClock(now) {
  if (!simActive()) {
    simClock = 0;
    return;
  }
  if (document.hidden) {
    simClock = 0;
    return;
  }
  if (!simClock) simClock = now;
  let gap = now - simClock;
  let steps = 0;
  if (gap >= SIM_LATE_MS) {
    simClock = now;
    steps = 1;
  } else {
    while (gap >= DT * 1000 && steps < MAX_STEPS) {
      gap -= DT * 1000;
      steps += 1;
    }
    if (steps > 0) simClock += steps * DT * 1000;
  }
  for (let i = 0; i < steps; i += 1) tickMatch();
  if (steps > 1) flushHostSnapshot(true);
  else if (steps === 1) flushHostSnapshot(false);
  simSteps += steps;
}

function frame(now) {
  if (!last) last = now;
  let frameDt = (now - last) / 1000;
  last = now;
  if (document.hidden || frameDt > 0.25) frameDt = 0;
  tickClock(now);
  agePaint(frameDt);
  const drawStart = performance.now();
  renderer.draw(buildView(), frameDt);
  const steps = simSteps;
  simSteps = 0;
  metrics.note({
    frameMs: frameDt * 1000,
    drawMs: performance.now() - drawStart,
    steps,
    snapAgeMs: latestSnap ? Math.max(0, now - latestSnapAt) : 0,
    snapBuffer: snapBuffer.length,
    hasSnap: !!latestSnap,
  });
  metrics.maybeReport(now);
  requestAnimationFrame(frame);
}

lobbyEl.addEventListener('submit', (event) => event.preventDefault());

function labelText(el, key) {
  const text = document.createTextNode(t(key));
  const field = el.querySelector('input, select');
  el.replaceChildren(text, document.createTextNode(' '), field);
}

function applyLang() {
  document.documentElement.lang = langEl.value;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  labelText(document.querySelector('#nick-label'), 'nick');
  labelText(document.querySelector('#map-label'), 'map');
  labelText(document.querySelector('#round-time-label'), 'roundTime');
  labelText(document.querySelector('#wins-needed-label'), 'winsNeeded');
  if (mode === 'local') {
    syncLocalNick();
    const blue = match && match.players.find((player) => player.id === LOCAL_BLUE);
    if (blue && !nickEl.value.trim()) blue.nick = t('blue');
  }
  renderMapPick();
  renderTeams();
}

langEl.addEventListener('change', () => {
  setLang(langEl.value);
  applyLang();
});

menuBtn.addEventListener('click', () => {
  if (mode === 'host' && isHost && !serverHost) pauseMatch(match);
  showLobby(true);
});

mapPick.addEventListener('change', () => {
  if (mode === 'guest' || (mode === 'host' && !isHost)) {
    mapPick.value = mapId;
    return;
  }
  if (mapPick.value === mapId) return;
  applyMap(mapPick.value, true);
});

function bumpZoom(delta) {
  setZoom(getZoom() + delta);
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (event.code === 'PageUp' || event.code === 'NumpadAdd' || event.key === '+' || event.key === '=') {
    event.preventDefault();
    bumpZoom(1);
  } else if (event.code === 'PageDown' || event.code === 'NumpadSubtract' || event.key === '-' || event.key === '_') {
    event.preventDefault();
    bumpZoom(-1);
  } else if (event.code === 'Digit1' || event.code === 'Numpad1') setZoom(1);
  else if (event.code === 'Digit2' || event.code === 'Numpad2') setZoom(2);
  else if (event.code === 'Digit3' || event.code === 'Numpad3') setZoom(3);
  else if (event.code === 'Digit4' || event.code === 'Numpad4') setZoom(4);
  else if (event.code === 'Digit5' || event.code === 'Numpad5') setZoom(5);
});

window.addEventListener('wheel', (event) => {
  if (lobbyEl.contains(event.target) && !lobbyEl.classList.contains('hidden')) return;
  event.preventDefault();
  bumpZoom(event.deltaY < 0 ? 1 : -1);
}, { passive: false });

async function loadMaps() {
  const indexResponse = await fetch('/maps/index.json');
  if (!indexResponse.ok) throw new Error(t('mapListFailed'));
  const index = await indexResponse.json();
  MAPS = index.filter((entry) => entry && entry.id && entry.file);
  await Promise.all(MAPS.map(async (entry) => {
    const response = await fetch('/maps/' + entry.file);
    if (!response.ok) throw new Error(t('mapFailed', { name: entry.name || entry.id }));
    const data = await response.json();
    data.id = entry.id;
    data.name = entry.name || data.name;
    entry.size = data.size || entry.size || '';
    mapsById.set(entry.id, data);
  }));
}

await loadMaps();
langEl.value = loadLang();
loadNick();
loadRules();
loadZoom();
loadMapChoice();
resetLocalMatch();
applyLang();
requestAnimationFrame(frame);
