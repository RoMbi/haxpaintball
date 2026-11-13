import { performance } from 'node:perf_hooks';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientMsg, ServerMsg, encode, decode } from '../shared/protocol.js';
import { DT, SNAPSHOT_EVERY } from '../shared/constants.js';
import {
  clampRules,
  createMatch,
  setInput,
  pauseMatch,
  step,
  snapshot,
} from '../shared/sim.js';
import { syncRoster, releaseDeparted, tryStart, applyRules } from '../shared/authority.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const ALLOWED_ROOTS = new Set(['client', 'shared', 'maps']);
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

const rooms = new Map();
const sessions = new Map();
const mapsById = new Map();
const TICK_MS = DT * 1000;
const MAX_CATCHUP = 5;
// Past this the loop is late, not behind. One state, then reset the clock.
const LATE_RESET_MS = 100;

function randomString(length) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function roomCode() {
  let code = randomString(4);
  while (rooms.has(code)) code = randomString(4);
  return code;
}

function playerIdTaken(id) {
  for (const room of rooms.values()) {
    if (room.players.has(id)) return true;
  }
  return false;
}

function playerId() {
  let id = randomString(8);
  while (playerIdTaken(id)) id = randomString(8);
  return id;
}

function cleanNick(nick) {
  if (typeof nick !== 'string') return '';
  return nick.trim().slice(0, 16);
}

function cleanTeam(team) {
  return team === 'red' || team === 'blue' || team === 'spec' ? team : null;
}

const MAP_IDS = new Set([
  'small-cross', 'small-alley', 'small-bunker',
  'medium-cross', 'medium-alley', 'medium-bunker',
  'large-cross', 'large-alley', 'large-bunker',
]);

function cleanMapId(id) {
  return MAP_IDS.has(id) ? id : 'medium-cross';
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(encode(obj));
  } catch {
    // Socket can close between the readyState check and send.
  }
}

function rosterOf(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({ id: p.id, nick: p.nick, team: p.team });
  }
  return {
    t: ServerMsg.ROSTER,
    players,
    hostId: room.hostId,
    mapId: room.mapId,
    serverHost: !!room.serverHost,
  };
}

function welcomeOf(room, id) {
  return {
    t: ServerMsg.CREATED,
    code: room.code,
    playerId: id,
    hostId: room.hostId,
    mapId: room.mapId,
    serverHost: !!room.serverHost,
  };
}

function broadcast(room, obj, exceptId) {
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    send(p.ws, obj);
  }
}

function fail(ws, message) {
  send(ws, { t: ServerMsg.ERROR, message });
}

function loadMaps() {
  const indexPath = path.join(root, 'maps', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  for (const entry of index) {
    if (!entry || !MAP_IDS.has(entry.id) || !entry.file) continue;
    const filePath = path.resolve(root, 'maps', path.basename(entry.file));
    if (!isInside(path.resolve(root, 'maps'), filePath)) continue;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.id = entry.id;
    data.name = entry.name || data.name;
    mapsById.set(entry.id, data);
  }
  if (!mapsById.has('medium-cross')) {
    throw new Error('Brak mapy medium-cross');
  }
}

function mapOf(id) {
  return mapsById.get(cleanMapId(id));
}

function wantsServerHost(msg) {
  return msg.serverHost === true || msg.serverHost === 1 || msg.serverHost === '1';
}

function makeRoom(code, hostId, mapId, serverHost) {
  const room = {
    code,
    hostId,
    mapId: cleanMapId(mapId),
    serverHost: !!serverHost,
    players: new Map(),
    match: null,
    acc: 0,
    lastTick: 0,
  };
  if (room.serverHost) room.match = createMatch(mapOf(room.mapId), null);
  return room;
}

function rosterEntries(room) {
  const entries = [];
  for (const entry of room.players.values()) {
    entries.push({ id: entry.id, nick: entry.nick, team: entry.team });
  }
  return entries;
}

function syncMatchRoster(room) {
  if (!room.match) return;
  syncRoster(room.match, rosterEntries(room));
  releaseDeparted(room.match, rosterEntries(room));
}

function sendSnapshot(room) {
  if (!room.match) return;
  const waiting = room.match.phase === 'waiting' || room.match.phase === 'match_end';
  if (!waiting && room.match.tick % SNAPSHOT_EVERY !== 0) return;
  broadcast(room, { t: ServerMsg.SNAPSHOT, snap: snapshot(room.match) });
}

function stepRoom(room, steps) {
  if (!room.serverHost || !room.match || steps < 1) return;
  for (let i = 0; i < steps; i += 1) step(room.match);
  // One snapshot for the window, not one per caught-up tick.
  sendSnapshot(room);
}

function tickRooms() {
  const now = performance.now();
  if (!tickClock) tickClock = now;
  let gap = now - tickClock;
  let steps = 0;
  if (gap >= LATE_RESET_MS) {
    // Late, not behind. One state, then the next tick is a full interval out.
    tickClock = now;
    steps = 1;
  } else {
    while (gap >= TICK_MS && steps < MAX_CATCHUP) {
      gap -= TICK_MS;
      steps += 1;
    }
    tickClock = now - gap;
  }
  if (steps > 0) {
    for (const room of rooms.values()) stepRoom(room, steps);
  }
  const remain = gap >= LATE_RESET_MS ? TICK_MS : TICK_MS - (performance.now() - tickClock);
  scheduleTick(remain);
}

function scheduleTick(ms) {
  const delay = ms > 1 ? ms : 1;
  setTimeout(tickRooms, delay);
}

function handleCreate(ws, msg) {
  if (sessions.has(ws)) {
    fail(ws, 'already_in_room');
    return;
  }
  const team = cleanTeam(msg.team);
  if (!team) {
    fail(ws, 'bad_team');
    return;
  }
  const code = roomCode();
  const id = playerId();
  const serverHost = wantsServerHost(msg);
  const room = makeRoom(code, id, msg.mapId, serverHost);
  room.players.set(id, { id, nick: cleanNick(msg.nick), team, ws });
  rooms.set(code, room);
  sessions.set(ws, { code, playerId: id });
  if (serverHost) syncMatchRoster(room);
  send(ws, welcomeOf(room, id));
  send(ws, rosterOf(room));
  if (serverHost) sendSnapshot(room);
  console.log(`room create ${code}${serverHost ? ' server-host' : ''}`);
}

function handleJoin(ws, msg) {
  if (sessions.has(ws)) {
    fail(ws, 'already_in_room');
    return;
  }
  if (typeof msg.code !== 'string' || msg.code.trim() === '') {
    fail(ws, 'missing_code');
    return;
  }
  const code = msg.code.trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    fail(ws, 'no_room');
    return;
  }
  if (room.players.size >= MAX_PLAYERS) {
    fail(ws, 'room_full');
    return;
  }
  const id = playerId();
  room.players.set(id, { id, nick: cleanNick(msg.nick), team: 'spec', ws });
  sessions.set(ws, { code, playerId: id });
  send(ws, {
    t: ServerMsg.JOINED,
    code,
    playerId: id,
    hostId: room.hostId,
    mapId: room.mapId,
    serverHost: !!room.serverHost,
  });
  if (room.serverHost) syncMatchRoster(room);
  broadcast(room, rosterOf(room));
  if (room.serverHost) sendSnapshot(room);
  console.log(`room join ${code}`);
}

function handleTeam(ws, msg) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room) return;
  const player = room.players.get(sess.playerId);
  if (!player || player.ws !== ws) return;
  const team = cleanTeam(msg.team);
  if (!team) {
    fail(ws, 'bad_team');
    return;
  }
  player.team = team;
  if (room.serverHost) syncMatchRoster(room);
  broadcast(room, rosterOf(room));
  if (room.serverHost) sendSnapshot(room);
}

function handleMap(ws, msg) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || sess.playerId !== room.hostId) return;
  const mapId = cleanMapId(msg.mapId);
  if (!MAP_IDS.has(msg.mapId) || mapId === room.mapId) return;
  room.mapId = mapId;
  if (room.serverHost && room.match && (room.match.phase === 'waiting' || room.match.phase === 'match_end')) {
    room.match = createMatch(mapOf(mapId), room.match.rules);
    syncMatchRoster(room);
  }
  broadcast(room, rosterOf(room));
  if (room.serverHost) sendSnapshot(room);
}

function handleShuffle(ws) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || sess.playerId !== room.hostId) return;
  const players = shuffle([...room.players.values()]);
  const redCount = Math.floor(players.length / 2);
  const blueCount = players.length - redCount;
  const first = Math.random() < 0.5 ? 'red' : 'blue';
  const second = first === 'red' ? 'blue' : 'red';
  const firstCount = first === 'red' ? redCount : blueCount;
  players.forEach((player, index) => {
    player.team = index < firstCount ? first : second;
  });
  if (room.serverHost) syncMatchRoster(room);
  broadcast(room, rosterOf(room));
  if (room.serverHost) sendSnapshot(room);
}

function handleRules(ws, msg) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || !room.serverHost || sess.playerId !== room.hostId || !room.match) return;
  if (!applyRules(room.match, clampRules(msg))) return;
  sendSnapshot(room);
}

function handleStart(ws) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || !room.serverHost || sess.playerId !== room.hostId || !room.match) return;
  if (!tryStart(room.match)) {
    fail(ws, 'need_both_teams');
    return;
  }
  sendSnapshot(room);
}

function handleInput(ws, msg) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || !room.serverHost || !room.match) return;
  const mask = Number(msg.mask);
  const seq = Number(msg.seq);
  if (!Number.isFinite(mask) || !Number.isFinite(seq)) return;
  const shotSeq = Number(msg.shot);
  setInput(room.match, sess.playerId, mask & 0xffff, seq, Number.isFinite(shotSeq) ? shotSeq : 0);
}

function handleSignal(ws, msg) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || typeof msg.to !== 'string') return;
  const target = room.players.get(msg.to);
  if (!target) return;
  send(target.ws, { t: ServerMsg.SIGNAL, from: sess.playerId, data: msg.data });
}

function handleRelay(ws, msg) {
  const sess = sessions.get(ws);
  if (!sess) return;
  const room = rooms.get(sess.code);
  if (!room || room.serverHost) return;
  const payload = msg.payload && typeof msg.payload === 'object' ? { ...msg.payload } : msg.payload;
  if (payload && payload.t === 'input') payload.id = sess.playerId;
  broadcast(
    room,
    { t: ServerMsg.RELAY, from: sess.playerId, payload },
    sess.playerId,
  );
}

function handleLeave(ws) {
  const sess = sessions.get(ws);
  if (!sess) return;
  sessions.delete(ws);
  const room = rooms.get(sess.code);
  if (!room) return;
  const player = room.players.get(sess.playerId);
  if (!player || player.ws !== ws) return;
  room.players.delete(sess.playerId);
  if (room.serverHost) {
    syncMatchRoster(room);
    if (room.match && room.match.phase === 'playing' && room.players.size === 0) pauseMatch(room.match);
  }

  if (!room.serverHost && sess.playerId === room.hostId) {
    const roster = rosterOf(room);
    const closed = { t: ServerMsg.CLOSED, reason: 'host_closed' };
    for (const p of room.players.values()) {
      sessions.delete(p.ws);
      send(p.ws, roster);
      send(p.ws, closed);
    }
    rooms.delete(room.code);
    console.log(`room close ${room.code}`);
    return;
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
    console.log(`room close ${room.code}`);
    return;
  }
  if (room.serverHost && room.hostId === sess.playerId) {
    const next = room.players.values().next().value;
    room.hostId = next.id;
  }
  broadcast(room, rosterOf(room));
  if (room.serverHost) sendSnapshot(room);
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'text/plain';
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('..') || decoded.includes('\0')) return null;

  let rel;
  if (decoded === '/' || decoded === '/index.html') {
    rel = path.join('client', 'index.html');
  } else {
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0 || !ALLOWED_ROOTS.has(parts[0])) return null;
    if (parts.some((part) => part === '.' || part === '..')) return null;
    rel = path.join(...parts);
  }

  const filePath = path.resolve(root, rel);
  const bucket = path.resolve(root, rel.split(path.sep)[0]);
  if (!isInside(bucket, filePath)) return null;
  return filePath;
}

function serve(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(404);
    res.end();
    return;
  }
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath.includes('..') || urlPath.includes('\0') || urlPath.includes('\\')) {
    res.writeHead(403);
    res.end();
    return;
  }
  const filePath = safeFile(urlPath);
  if (!filePath) {
    res.writeHead(404);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}

const server = http.createServer(serve);
const wss = new WebSocketServer({ server, perMessageDeflate: false });

wss.on('connection', (ws) => {
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = decode(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case ClientMsg.CREATE:
        handleCreate(ws, msg);
        break;
      case ClientMsg.JOIN:
        handleJoin(ws, msg);
        break;
      case ClientMsg.SHUFFLE:
        handleShuffle(ws);
        break;
      case ClientMsg.MAP:
        handleMap(ws, msg);
        break;
      case ClientMsg.SIGNAL:
        handleSignal(ws, msg);
        break;
      case ClientMsg.RELAY:
        handleRelay(ws, msg);
        break;
      case ClientMsg.LEAVE:
        handleLeave(ws);
        break;
      case ClientMsg.TEAM:
        handleTeam(ws, msg);
        break;
      case ClientMsg.START:
        handleStart(ws);
        break;
      case ClientMsg.RULES:
        handleRules(ws, msg);
        break;
      case ClientMsg.INPUT:
        handleInput(ws, msg);
        break;
      default:
        break;
    }
  });
  ws.on('close', () => handleLeave(ws));
});

loadMaps();

const port = process.env.PORT || 8080;
let tickClock = 0;
scheduleTick(TICK_MS);
server.listen(port, '0.0.0.0', () => {
  const addr = server.address();
  console.log(`listening on ${addr.address}:${addr.port}`);
});
