import {
  DT,
  MAX_PAINT,
  MAG_SIZE,
  ROUND_TIME,
  WINS_NEEDED,
  SNAPSHOT_EVERY,
  KEY,
  TEAM_RED,
  TEAM_BLUE,
  TEAM_SPEC,
  BULLET_LIFE,
  BULLET_SPIN,
  BULLET_SPEED,
  BULLET_INHERIT,
  BULLET_RADIUS,
  PLAYER_RADIUS,
  MARKER_ALONG,
  MARKER_RIGHT,
  MARKER_TIP,
} from '../shared/constants.js';
import {
  createMatch,
  clampRules,
  addPlayer,
  setInput,
  canStart,
  pauseMatch,
  start,
  step,
} from './host.js';
import { syncRoster, releaseDeparted } from '../shared/authority.js';
import { MAP_WASD, MAP_IJKL, createInput } from './input.js';
import { createRenderer, getZoom, setZoom, loadZoom } from './render.js';
import { t, loadLang, setLang, mapName, matchMessage, serverError } from './i18n.js';
import { createNet } from './net.js';
import { createClientMetrics } from './metrics.js';

const LOCAL_RED = 'local-red';
const LOCAL_BLUE = 'local-blue';
const VICTORY_HOLD = 4;
const NICK_KEY = 'haxpaintball.nick';
const MAP_KEY = 'haxpaintball.map';
const RULES_KEY = 'haxpaintball.rules';
let MAPS = [];
const PAINT_LIFE = 12;
const MAX_STEPS = 5;
// Render behind the newest snapshot so a frame always has two samples to blend.
const INTERP_INTERVALS = 2;
const INTERP_DELAY = SNAPSHOT_EVERY * DT * INTERP_INTERVALS;
// Guest view sits this many ticks behind the newest snapshot. Hold the host's
// own mask for the same count so a join does not leave the referee instant.
const HOST_INPUT_DELAY = SNAPSHOT_EVERY * INTERP_INTERVALS;
const INTERP_DELAY_MAX = 0.15;
const INTERP_QUIET_MS = 2000;
const SNAP_BUFFER = 32;
const INPUT_HISTORY = 32;

const canvas = document.querySelector('#view');
const lobbyEl = document.querySelector('#lobby');
const menuBtn = document.querySelector('#menu');
const scoreBtn = document.querySelector('#score-btn');
const teamBoardEl = document.querySelector('#team-board');
const teamBoardBody = document.querySelector('#team-board-body');
const scoreboardEl = document.querySelector('#scoreboard');
const scoreRedBody = document.querySelector('#score-red');
const scoreBlueBody = document.querySelector('#score-blue');
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
const copyLinkBtn = document.querySelector('#copy-link');
const leaveBtn = document.querySelector('#leave');
const matchSetup = document.querySelector('#match-setup');
const entrySwitch = document.querySelector('#entry-switch');
const hostPanel = document.querySelector('#host-panel');
const joinPanel = document.querySelector('#join-panel');
const showHostBtn = document.querySelector('#show-host');
const showJoinBtn = document.querySelector('#show-join');
const matchIdEl = document.querySelector('#match-id');
const newMatchIdBtn = document.querySelector('#new-match-id');
const copyMatchLinkBtn = document.querySelector('#copy-match-link');
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

const renderer = canvas ? createRenderer(canvas) : { draw() {} };
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
let hostInputQueue = [];
let sentInputs = [];
let sentAck = 0;
let latestSnap = null;
let latestSnapAt = 0;
let snapBuffer = [];
let paint = [];
let seenEventId = 0;
let seenDeathId = 0;
const wasAlive = new Map();
let hostEventAcks = new Map();
let renderDelay = INTERP_DELAY * 1000;
let delayQuietSince = 0;
// Shot is an edge. It stays on every packet until the referee's shotAck catches it.
let shotSeq = 0;
let shotAck = 0;
let shotWasDown = false;
// Own shots drawn before the snapshot returns. Authority still decides the hit.
let localShots = [];
let localShotId = 0;

const metrics = createClientMetrics();
const net = createNet({
  onWelcome,
  onRoster,
  onGame,
  onClosed,
  onError,
  onTransport,
  onReserved,
});

function setStatus(text) {
  statusEl.textContent = text || '';
}

let victoryLeft = 0;
let victoryHeld = false;

function currentPhase() {
  if (mode === 'guest' || serverHost) return latestSnap ? latestSnap.phase : '';
  return match ? match.phase : '';
}

function clearVictoryHold() {
  victoryLeft = 0;
  victoryHeld = false;
}

function noteMatchEnd() {
  if (currentPhase() !== 'match_end') {
    clearVictoryHold();
    return;
  }
  // Once per match. Restarting after expiry flashed the lobby for one frame
  // and hid Play before a click could land.
  if (victoryHeld) return;
  beginVictoryHold();
}

function beginVictoryHold() {
  victoryHeld = true;
  victoryLeft = VICTORY_HOLD;
  showLobby(false);
}

function finishVictoryHold() {
  victoryHeld = true;
  victoryLeft = 0;
  showLobby(true);
}

function tickVictoryHold(dt) {
  if (victoryLeft <= 0) return;
  victoryLeft -= dt;
  if (victoryLeft > 0) return;
  victoryLeft = 0;
  if (currentPhase() === 'match_end' || currentPhase() === 'waiting') showLobby(true);
}

function lobbyWanted(phase) {
  if (phase === 'playing' || phase === 'round_end') return false;
  if (phase === 'match_end') return victoryHeld && victoryLeft <= 0;
  return true;
}

function showLobby(show) {
  lobbyEl.classList.toggle('hidden', !show);
  lobbyEl.hidden = !show;
  splashEl.classList.toggle('hidden', !show);
  splashEl.hidden = !show;
  hotseatEl.classList.toggle('hidden', mode !== 'local' || show);
  if (menuBtn) menuBtn.classList.toggle('hidden', show);
  if (scoreBtn) scoreBtn.classList.toggle('hidden', show);
  if (show) setScoreboard(false);
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

function cleanMatchId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function matchLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  if (code) url.searchParams.set('match', code);
  return url.toString();
}

function linkCode() {
  try {
    return cleanMatchId(new URL(location.href).searchParams.get('match'));
  } catch {
    return '';
  }
}

function setMatchUrl(code) {
  const next = matchLink(code);
  if (location.href === next) return;
  history.replaceState(null, '', next);
}

let lobbyPane = 'join';
let pendingMatchId = '';
let reserving = false;

function showEntryPane(pane) {
  lobbyPane = pane === 'join' ? 'join' : 'host';
  if (hostPanel) hostPanel.hidden = lobbyPane !== 'host';
  if (joinPanel) joinPanel.hidden = lobbyPane !== 'join';
  if (matchSetup) matchSetup.hidden = false;
  if (showHostBtn) showHostBtn.classList.toggle('on', lobbyPane === 'host');
  if (showJoinBtn) showJoinBtn.classList.toggle('on', lobbyPane === 'join');
}

function renderTeams() {
  const inRoom = mode === 'host' || mode === 'guest';
  roomBar.classList.toggle('visible', inRoom);
  roomCodeEl.textContent = inRoom && roomCode ? t('room', { code: roomCode }) : '';
  if (entrySwitch) entrySwitch.hidden = inRoom;
  if (hostPanel) hostPanel.hidden = inRoom ? !isHost : lobbyPane !== 'host';
  if (matchSetup) matchSetup.hidden = false;
  if (joinPanel) joinPanel.hidden = inRoom || lobbyPane !== 'join';
  createBtn.hidden = inRoom;
  serverHostEl.hidden = inRoom;
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
    if (latestSnap.phase !== 'waiting' && latestSnap.phase !== 'match_end' && latestSnap.phase !== 'paused') return false;
  } else if (!match || (match.phase !== 'waiting' && match.phase !== 'match_end' && match.phase !== 'paused')) {
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
  const locked = mode === 'guest' || (mode === 'host' && !isHost);
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
    if (!isHost || (match && match.phase !== 'waiting' && match.phase !== 'match_end' && match.phase !== 'paused')) return true;
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
  wasAlive.clear();
  hostInputQueue = [];
  clearScoreNames();
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
  hostInputQueue = [];
  latestSnap = null;
  latestSnapAt = 0;
  snapBuffer = [];
  sentInputs = [];
  sentAck = 0;
  paint = [];
  seenEventId = 0;
  seenDeathId = 0;
  wasAlive.clear();
  clearScoreNames();
  shotSeq = 0;
  shotAck = 0;
  shotWasDown = false;
  clearVictoryHold();
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

function rosterOpen() {
  const phase = serverHost || mode === 'guest'
    ? (latestSnap && latestSnap.phase)
    : (match && match.phase);
  if (!phase) return true;
  return phase === 'waiting' || phase === 'match_end' || phase === 'paused';
}

function syncHostDiscs() {
  if (serverHost || mode !== 'host' || !match) return;
  syncRoster(match, roster);
  releaseDeparted(match, roster);
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

function noteVisibleDeaths(players) {
  if (!players || !players.length) return;
  const seen = new Set();
  for (const player of players) {
    if (!player || player.id == null) continue;
    seen.add(player.id);
    const alive = player.alive !== false;
    if (wasAlive.get(player.id) === true && !alive) {
      renderer.shatter({
        x: player.x,
        y: player.y,
        victimId: player.id,
        victimTeam: player.team,
      });
    }
    wasAlive.set(player.id, alive);
  }
  for (const id of wasAlive.keys()) {
    if (!seen.has(id)) wasAlive.delete(id);
  }
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

// Straight for the first half, then the same tumble the sim applies.
// Driven from render time so a quantized snapshot angle cannot swim.
function tumbleAngle(life, spinSign) {
  const left = Number.isFinite(life) ? life : BULLET_LIFE;
  const spun = Math.max(0, BULLET_LIFE * 0.5 - left);
  const sign = spinSign < 0 ? -1 : 1;
  return sign * BULLET_SPIN * spun;
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

function resetInterpDelay() {
  renderDelay = INTERP_DELAY * 1000;
  delayQuietSince = 0;
  snapBuffer = [];
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
  const life = lerp(before.life, after.life, t);
  const sign = after.spin != null ? after.spin : before.spin;
  blended.angle = tumbleAngle(life, sign);
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

function localBanners(source) {
  if (!source || source.phase !== 'round_end' || !source.winner) return null;
  const won = source.winner;
  return [
    { team: TEAM_RED, title: won === TEAM_RED ? t('roundWin') : t('wasted'), lost: won !== TEAM_RED },
    { team: TEAM_BLUE, title: won === TEAM_BLUE ? t('roundWin') : t('wasted'), lost: won !== TEAM_BLUE },
  ];
}

function selfTeam() {
  const known = roster.find((player) => player.id === selfId);
  if (known && known.team) return known.team;
  if (remoteView() && latestSnap) {
    const self = findSnapPlayer(latestSnap, selfId);
    if (self && self.team) return self.team;
  }
  if (match) {
    const self = match.players.find((player) => player.id === selfId);
    if (self && self.team) return self.team;
  }
  return pickedTeam;
}

let scoreboardOpen = false;
let scoreNames = new Map();
let statsPhase = '';

function clearScoreNames() {
  scoreNames = new Map();
}

function rememberNames() {
  for (const entry of roster) {
    if (!entry || !entry.id) continue;
    const prev = scoreNames.get(entry.id);
    scoreNames.set(entry.id, {
      nick: entry.nick || (prev && prev.nick) || '',
      team: entry.team || (prev && prev.team) || '',
    });
  }
  if (!match) return;
  for (const player of match.players) {
    if (!player || !player.id) continue;
    const prev = scoreNames.get(player.id);
    scoreNames.set(player.id, {
      nick: player.nick || (prev && prev.nick) || '',
      team: player.team || (prev && prev.team) || '',
    });
  }
}

function noteStatsPhase() {
  const phase = currentPhase();
  if (statsPhase === 'match_end' && phase === 'playing') clearScoreNames();
  statsPhase = phase;
}

function setScoreboard(open) {
  scoreboardOpen = !!open && !!scoreBtn && !scoreBtn.classList.contains('hidden');
  scoreboardEl.classList.toggle('hidden', !scoreboardOpen);
  scoreboardEl.hidden = !scoreboardOpen;
  scoreBtn.classList.toggle('on', scoreboardOpen);
  if (scoreboardOpen) renderScoreboard();
}

function statOf(id) {
  const bag = remoteView() ? (latestSnap && latestSnap.stats) : (match && match.stats);
  const row = bag && bag[id];
  return {
    k: row && row.k ? row.k | 0 : 0,
    d: row && row.d ? row.d | 0 : 0,
  };
}

function kdText(k, d) {
  const value = d ? k / d : k;
  return value.toFixed(2);
}

function aliveById() {
  const found = new Map();
  const players = remoteView()
    ? ((latestSnap && latestSnap.players) || [])
    : ((match && match.players) || []);
  for (const player of players) {
    if (!player || player.id == null) continue;
    found.set(player.id, player.alive !== false);
  }
  return found;
}

function scoreRows() {
  noteStatsPhase();
  rememberNames();
  const alive = aliveById();
  const rows = [];
  for (const [id, entry] of scoreNames) {
    if (!entry || (entry.team !== TEAM_RED && entry.team !== TEAM_BLUE)) continue;
    rows.push(scoreRow(id, entry.nick, entry.team, alive));
  }
  return rows;
}

function scoreRow(id, nick, team, alive) {
  const stat = statOf(id);
  return {
    id,
    nick: nick || t('player'),
    team,
    k: stat.k,
    d: stat.d,
    alive: alive.has(id) ? alive.get(id) : null,
  };
}

function compareNick(a, b) {
  return String(a.nick || '').localeCompare(String(b.nick || ''), undefined, { sensitivity: 'base' });
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function paintRow(row, markAlive) {
  const tr = document.createElement('tr');
  tr.classList.add(row.team === TEAM_BLUE ? 'blue' : 'red');
  if (row.id === selfId) tr.classList.add('self');
  if (markAlive && row.alive === false) tr.classList.add('dead');
  tr.append(cell(row.nick), cell(String(row.k)), cell(String(row.d)), cell(kdText(row.k, row.d)));
  return tr;
}

function byKd(a, b) {
  const ratioA = a.d ? a.k / a.d : a.k;
  const ratioB = b.d ? b.k / b.d : b.k;
  if (ratioB !== ratioA) return ratioB - ratioA;
  if (b.k !== a.k) return b.k - a.k;
  return compareNick(a, b);
}

function ownTeam() {
  if (mode === 'local' && match) {
    const self = match.players.find((player) => player.id === selfId);
    if (self) return self.team;
  }
  const self = roster.find((player) => player.id === selfId);
  if (self && self.team) return self.team;
  return pickedTeam;
}

function renderTeamBoard() {
  const team = ownTeam();
  const show = currentPhase() === 'playing'
    && lobbyEl.classList.contains('hidden')
    && (team === TEAM_RED || team === TEAM_BLUE);
  teamBoardEl.classList.toggle('hidden', !show);
  teamBoardEl.hidden = !show;
  teamBoardEl.style.bottom = hotseatEl.classList.contains('hidden') ? '16px' : '40px';
  if (!show) {
    teamBoardBody.replaceChildren();
    return;
  }
  const rows = scoreRows()
    .filter((row) => row.team === team)
    .sort((a, b) => {
      const aliveA = a.alive === false ? 1 : 0;
      const aliveB = b.alive === false ? 1 : 0;
      if (aliveA !== aliveB) return aliveA - aliveB;
      return compareNick(a, b);
    });
  teamBoardBody.replaceChildren(...rows.map((row) => paintRow(row, true)));
}

function renderScoreboard() {
  const rows = scoreRows();
  const red = rows.filter((row) => row.team === TEAM_RED).sort(byKd);
  const blue = rows.filter((row) => row.team === TEAM_BLUE).sort(byKd);
  scoreRedBody.replaceChildren(...red.map((row) => paintRow(row, false)));
  scoreBlueBody.replaceChildren(...blue.map((row) => paintRow(row, false)));
}

function hudFrom(source) {
  const score = source.score || { red: 0, blue: 0 };
  return {
    score,
    timeLeft: source.timeLeft,
    phase: source.phase,
    message: matchMessage(source.message),
    overtime: !!source.overtime,
    winner: source.winner || '',
    selfTeam: selfTeam(),
    split: mode === 'local' && source.phase === 'round_end',
    roomCode,
    transport: mode === 'local' ? '' : transport,
    roster: mode === 'local' ? [] : roster,
    ammo: selfAmmo(source),
  };
}

function fieldVisible() {
  if (mode === 'guest' || serverHost) {
    return !!(latestSnap && (latestSnap.phase === 'playing' || latestSnap.phase === 'round_end' || latestSnap.phase === 'match_end'));
  }
  if (mode === 'local') return false;
  return !!(match && (match.phase === 'playing' || match.phase === 'round_end' || match.phase === 'match_end'));
}

function remoteView() {
  return mode === 'guest' || serverHost;
}

function buildView() {
  const visibleMap = fieldVisible() ? map : null;
  if (remoteView() && latestSnap) {
    const nowMs = performance.now();
    const span = interpSpan(nowMs);
    const bullets = span ? drawBulletsFromSpan(span) : [];
    return {
      map: visibleMap,
      players: span ? drawPlayersFromSpan(span) : [],
      bullets: bullets.concat(localShotBullets(nowMs)),
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
    banners: mode === 'local' ? localBanners(match) : null,
  };
}

function queueHostInput(id, mask, seq, shot) {
  // Sandbox has no guest to match. A delayed hotseat just feels broken.
  if (mode !== 'host' || serverHost) {
    setInput(match, id, mask, seq, shot);
    return;
  }
  hostInputQueue.push({ id, mask, seq, shot });
}

function flushHostInput() {
  if (mode !== 'host' || serverHost || !match) return;
  while (hostInputQueue.length > HOST_INPUT_DELAY) {
    const sample = hostInputQueue.shift();
    setInput(match, sample.id, sample.mask, sample.seq, sample.shot);
  }
}

function stepLocalOrHost() {
  syncLocalNick();
  ensureHotseat();
  releaseDeparted(match, roster);
  // Lobby blocks keys, so the pause must not sit in the host delay queue.
  // Replaying it on resume is the lag that grows each visit.
  if (match.phase === 'paused') {
    hostInputQueue = [];
    shotWasDown = false;
    step(match);
    paintFromMatch();
    return;
  }
  const red = match.players.find((player) => player.id === (mode === 'local' ? LOCAL_RED : selfId));
  if (red && (mode === 'local' || mode === 'host')) {
    const mask = wasd.sample();
    inputSeq += 1;
    noteShotEdge(mask);
    queueHostInput(red.id, mask, inputSeq, shotSeq);
  }
  if (mode === 'local') {
    const blue = match.players.find((player) => player.id === LOCAL_BLUE);
    if (blue) setInput(match, LOCAL_BLUE, ijkl.sample(), match.tick + 1);
  }
  flushHostInput();
  step(match);
  paintFromMatch();
}

function flushHostSnapshot(force) {
  if (mode !== 'host' || serverHost || !match || roster.length < 2) return;
  const waiting = match.phase === 'waiting' || match.phase === 'match_end' || match.phase === 'paused';
  if (!force && !waiting && match.tick % SNAPSHOT_EVERY !== 0) return;
  const since = {};
  for (const [id, ack] of hostEventAcks) since[id] = ack;
  net.sendSnapshot(match, since);
}

function rememberInput(seq, mask) {
  const bits = mask | 0;
  sentInputs.push({ seq, mask: bits });
  if (sentInputs.length > INPUT_HISTORY) sentInputs.shift();
  return bits;
}

// The key going down is the edge. Later packets repeat the same shotSeq until
// the referee answers with shotAck, so a lost packet is not a lost shot.
function noteShotEdge(mask) {
  const down = (mask & KEY.SHOOT) !== 0;
  if (down && !shotWasDown) {
    shotSeq += 1;
    spawnLocalShot();
  }
  shotWasDown = down;
  return shotSeq;
}

// Visual only. The referee still owns the real bullet, so a ghost that the
// host never spawned just expires. It must not decide a hit.
function spawnLocalShot() {
  if (!remoteView()) return;
  if (!latestSnap || latestSnap.phase !== 'playing') return;
  const self = selfOnScreen();
  if (!self || self.alive === false) return;
  if (self.invuln > 0 || self.reloading || (self.ammo != null && self.ammo <= 0)) return;
  let fx = self.fx;
  let fy = self.fy;
  const flen = Math.hypot(fx, fy);
  if (flen < 1e-8) {
    fx = 1;
    fy = 0;
  } else {
    fx /= flen;
    fy /= flen;
  }
  const gripX = self.x + fx * PLAYER_RADIUS * MARKER_ALONG - fy * PLAYER_RADIUS * MARKER_RIGHT;
  const gripY = self.y + fy * PLAYER_RADIUS * MARKER_ALONG + fx * PLAYER_RADIUS * MARKER_RIGHT;
  const muzzle = MARKER_TIP + BULLET_RADIUS + 1;
  localShotId += 1;
  localShots.push({
    id: localShotId,
    shotSeq,
    team: self.team,
    x: gripX + fx * muzzle,
    y: gripY + fy * muzzle,
    vx: fx * BULLET_SPEED + (self.vx || 0) * BULLET_INHERIT,
    vy: fy * BULLET_SPEED + (self.vy || 0) * BULLET_INHERIT,
    born: performance.now(),
  });
}

function localShotBullets(nowMs) {
  if (!localShots.length) return [];
  const kept = [];
  const drawn = [];
  const hide = ownBulletInView();
  for (const shot of localShots) {
    const age = (nowMs - shot.born) / 1000;
    // shotAck is the referee saying this edge was consumed. Until then the
    // delayed view has not caught the ball, so the ghost has to keep flying.
    if (age < 0 || age > BULLET_LIFE || shotAck >= shot.shotSeq) continue;
    kept.push(shot);
    if (hide) continue;
    drawn.push({
      id: 'local-' + shot.id,
      owner: selfId,
      team: shot.team,
      x: shot.x + shot.vx * age,
      y: shot.y + shot.vy * age,
      life: BULLET_LIFE - age,
      spin: 1,
      angle: 0,
    });
  }
  localShots = kept;
  return drawn;
}

function selfOnScreen() {
  const span = interpSpan(performance.now());
  if (span) {
    const drawn = drawPlayersFromSpan(span).find((player) => player.id === selfId);
    if (drawn) return drawn;
  }
  return hydratePlayer(findSnapPlayer(latestSnap, selfId));
}

function ownBulletInView() {
  const span = interpSpan(performance.now());
  if (!span || !span.to || !span.to.bullets) return false;
  for (const bullet of span.to.bullets) {
    if (bullet.owner === selfId) return true;
  }
  return false;
}

function takeShotAck(snap) {
  const remote = findSnapPlayer(snap, selfId);
  if (!remote || !Number.isFinite(Number(remote.shotAck))) return;
  const ack = remote.shotAck | 0;
  if (ack > shotAck) shotAck = ack;
}

function stepGuest() {
  if (pickedTeam === TEAM_SPEC || (latestSnap && latestSnap.phase === 'paused')) {
    shotWasDown = false;
    if (seenEventId > sentAck) {
      sentAck = seenEventId;
      net.sendInput(inputSeq, 0, seenEventId, shotSeq);
    }
    return;
  }
  inputSeq += 1;
  const playing = latestSnap && latestSnap.phase === 'playing';
  const mask = rememberInput(inputSeq, playing ? wasd.sample() : 0);
  noteShotEdge(mask);
  sentAck = seenEventId;
  net.sendInput(inputSeq, mask, seenEventId, shotSeq);
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
  reserving = false;
  pendingMatchId = '';
  roomCode = state.roomCode || '';
  setMatchUrl(roomCode);
  transport = state.transport || transport;
  selfId = state.playerId;
  inputSeq = 0;
  hostInputQueue = [];
  sentInputs = [];
  sentAck = 0;
  seenEventId = 0;
  seenDeathId = 0;
  wasAlive.clear();
  clearScoreNames();
  paint = [];
  hostEventAcks = new Map();
  renderDelay = INTERP_DELAY * 1000;
  delayQuietSince = 0;
  shotSeq = 0;
  shotAck = 0;
  shotWasDown = false;
  latestSnap = null;
  latestSnapAt = 0;
  snapBuffer = [];
  clearVictoryHold();
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
      if (mode === 'host' && isHost && match && (match.phase === 'waiting' || match.phase === 'match_end' || match.phase === 'paused')) {
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
    const shot = Number(msg.shot);
    setInput(match, msg.id || fromId, msg.mask, msg.seq, Number.isFinite(shot) ? shot : 0);
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
    if (remoteView()) takeShotAck(snap);
    // match_end is on the field only until the hold ends. After that a snapshot
    // must not hide the lobby, or Play never stays clickable.
    const wantLobby = lobbyWanted(snap.phase);
    const lobbyOpen = !lobbyEl.classList.contains('hidden');
    if (wantLobby === lobbyOpen) return;
    if (!wantLobby) resetInterpDelay();
    showLobby(wantLobby);
  }
}

function leaveRoomToSandbox(message) {
  connecting = false;
  reserving = false;
  pendingMatchId = '';
  setMatchUrl('');
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
  if (reserving) {
    reserving = false;
    pendingMatchId = '';
    setStatus(serverError(message || 'error'));
    return;
  }
  setStatus(serverError(message || 'error'));
  showLobby(true);
}

function onReserved(code) {
  if (!reserving) return;
  reserving = false;
  const next = cleanMatchId(code);
  if (matchIdEl && next) matchIdEl.value = next;
  setStatus('');
  if (pendingMatchId === 'create') {
    pendingMatchId = '';
    createRoom(next);
    return;
  }
  pendingMatchId = '';
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
  if (match.phase !== 'waiting' && match.phase !== 'match_end' && match.phase !== 'paused') return;
  match.rules = rules;
  match.timeLeft = rules.roundTime;
}

roundTimeEl.addEventListener('change', onRulesChanged);
winsNeededEl.addEventListener('change', onRulesChanged);

playBtn.addEventListener('click', () => {
  if (serverHost) {
    if (!isHost) return;
    onRulesChanged();
    resetInterpDelay();
    net.startMatch();
    return;
  }
  if (mode !== 'host' || !isHost || !match) return;
  if (match.phase === 'paused') {
    hostInputQueue = [];
    shotWasDown = false;
    start(match);
    showLobby(false);
    flushHostSnapshot(true);
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

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!roomCode) return;
    const link = matchLink(roomCode);
    const ok = await copyRoomCode(link);
    setStatus(ok ? t('copiedLink') : link);
  });
}

leaveBtn.addEventListener('click', () => {
  if (mode !== 'host' && mode !== 'guest') return;
  net.leaveRoom();
  net.close();
  leaveRoomToSandbox('');
});

function requestMatchId(code, next) {
  if (connecting || reserving || mode !== 'local') return;
  reserving = true;
  pendingMatchId = next || '';
  setStatus(t('connecting'));
  net.connect();
  net.reserveCode(cleanMatchId(code));
  window.setTimeout(() => {
    if (!reserving) return;
    reserving = false;
    pendingMatchId = '';
    setStatus(t('noResponse'));
  }, 4000);
}

function createRoom(code) {
  if (connecting || mode !== 'local') return;
  rememberNick();
  connecting = true;
  setStatus(t('connecting'));
  net.connect();
  net.createRoom({
    nick: nickOr(t('red')),
    team: pickedTeam,
    mapId,
    serverHost: serverHostCheck.checked,
    code: cleanMatchId(code),
  });
  window.setTimeout(() => {
    if (!connecting || mode !== 'local') return;
    connecting = false;
    setStatus(t('noResponse'));
  }, 4000);
}

createBtn.addEventListener('click', () => {
  const code = matchIdEl ? cleanMatchId(matchIdEl.value) : '';
  if (!code) {
    requestMatchId('', 'create');
    return;
  }
  createRoom(code);
});

if (newMatchIdBtn) {
  newMatchIdBtn.addEventListener('click', () => {
    requestMatchId('', '');
  });
}

if (copyMatchLinkBtn) {
  copyMatchLinkBtn.addEventListener('click', async (event) => {
    event.preventDefault();
    const code = matchIdEl ? cleanMatchId(matchIdEl.value) : '';
    if (!code) {
      setStatus(t('needCode'));
      return;
    }
    const link = matchLink(code);
    const ok = await copyRoomCode(link);
    setStatus(ok ? t('copiedLink') : link);
  });
}

if (showHostBtn) showHostBtn.addEventListener('click', () => showEntryPane('host'));
if (showJoinBtn) showJoinBtn.addEventListener('click', () => showEntryPane('join'));
if (matchIdEl) {
  matchIdEl.addEventListener('input', () => {
    matchIdEl.value = cleanMatchId(matchIdEl.value);
  });
}

function joinRoom(code) {
  if (connecting || reserving) return;
  if (mode !== 'local') return;
  const next = cleanMatchId(code);
  if (!next) {
    setStatus(t('needCode'));
    return;
  }
  rememberNick();
  connecting = true;
  setStatus(t('connecting'));
  net.connect();
  net.joinRoom({ code: next, nick: nickOr(t('player')), team: pickedTeam });
}

joinBtn.addEventListener('click', () => {
  joinRoom(codeEl.value);
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
  noteMatchEnd();
  tickVictoryHold(frameDt);
  const drawStart = performance.now();
  const view = buildView();
  if (view.map) noteVisibleDeaths(view.players);
  renderer.draw(view, frameDt);
  renderTeamBoard();
  if (scoreboardOpen) renderScoreboard();
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
  labelText(document.querySelector('#match-id-label'), 'matchId');
  labelText(document.querySelector('#round-time-label'), 'roundTime');
  labelText(document.querySelector('#wins-needed-label'), 'winsNeeded');
  if (mode === 'local') {
    syncLocalNick();
    const blue = match && match.players.find((player) => player.id === LOCAL_BLUE);
    if (blue && !nickEl.value.trim()) blue.nick = t('blue');
  }
  renderMapPick();
  renderTeams();
  renderTeamBoard();
  if (scoreboardOpen) renderScoreboard();
}

langEl.addEventListener('change', () => {
  setLang(langEl.value);
  applyLang();
});

if (menuBtn) {
  menuBtn.addEventListener('click', () => {
    if (mode !== 'host' || !isHost) return;
    if (currentPhase() === 'match_end') {
      finishVictoryHold();
      return;
    }
    if (serverHost) {
      net.pauseMatch();
      return;
    }
    if (!pauseMatch(match)) return;
    hostInputQueue = [];
    shotWasDown = false;
    flushHostSnapshot(true);
    showLobby(true);
  });
}

if (scoreBtn) {
  scoreBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setScoreboard(!scoreboardOpen);
  });
}

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
const fromLink = linkCode();
if (fromLink) {
  showEntryPane('join');
  codeEl.value = fromLink;
  joinRoom(fromLink);
} else {
  showEntryPane('join');
}
applyLang();
requestAnimationFrame(frame);
