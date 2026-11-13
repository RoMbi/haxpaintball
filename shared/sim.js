import {
  DT,
  PLAYER_RADIUS,
  PLAYER_ACCEL,
  PLAYER_FRICTION,
  PLAYER_RELEASE_FRICTION,
  PLAYER_MAX_SPEED,
  PLAYER_TURN_RATE,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_INHERIT,
  BULLET_LIFE,
  BULLET_COOLDOWN,
  BULLET_TAP_RATE,
  BULLET_SPREAD,
  BULLET_SPREAD_STEP,
  BULLET_SPIN,
  BULLET_IGNORE,
  MARKER_ALONG,
  MARKER_RIGHT,
  MARKER_TIP,
  SPAWN_INVULN,
  ROUND_TIME,
  ROUND_TIME_MIN,
  ROUND_TIME_MAX,
  ROUND_END_PAUSE,
  WINS_NEEDED,
  WINS_MIN,
  WINS_MAX,
  MAG_SIZE,
  RELOAD_EMPTY,
  KEY,
  TEAM_RED,
  TEAM_BLUE,
} from './constants.js';
import {
  resolveDiscSegment,
  resolveDiscDisc,
  hitsCircle,
  closestPointOnSegment,
} from './collide.js';

const EVENT_HISTORY = 60;
const PAIR_ITERS = 3;
const ENV_ITERS = 4;
const BULLET_MAX_STEP = 4;

export function clampRules(rules) {
  const source = rules || {};
  const roundTime = Number(source.roundTime);
  const winsNeeded = Number(source.winsNeeded);
  return {
    roundTime: clampInt(roundTime, ROUND_TIME_MIN, ROUND_TIME_MAX, ROUND_TIME),
    winsNeeded: clampInt(winsNeeded, WINS_MIN, WINS_MAX, WINS_NEEDED),
  };
}

export function createMatch(map, rules) {
  const picked = clampRules(rules);
  return {
    map,
    rules: picked,
    tick: 0,
    phase: 'waiting',
    timeLeft: picked.roundTime,
    pause: 0,
    overtime: false,
    score: { red: 0, blue: 0 },
    stats: {},
    message: 'waiting',
    winner: null,
    players: [],
    bullets: [],
    recentEvents: [],
    nextEventId: 1,
    nextBulletId: 1,
    spawnCursor: { red: 0, blue: 0 },
  };
}

export function addPlayer(match, { id, nick, team }) {
  if (team !== TEAM_RED && team !== TEAM_BLUE) return null;
  const spawns = (match.map.spawns && match.map.spawns[team]) || [];
  const cursor = match.spawnCursor[team] || 0;
  match.spawnCursor[team] = cursor + 1;
  const slot = spawns.length ? cursor % spawns.length : 0;
  const pos = spawns.length ? pointOf(spawns[slot]) : mapCenter(match.map);
  const late = match.phase === 'playing' || match.phase === 'round_end';
  const player = {
    id,
    nick,
    team,
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    fx: 1,
    fy: 0,
    alive: true,
    invuln: late ? SPAWN_INVULN : 0,
    cooldown: 0,
    triggerWasDown: false,
    ammo: MAG_SIZE,
    reloading: false,
    reloadLeft: 0,
    reloadDuration: 0,
    reloadWasDown: false,
    seq: 0,
    appliedSeq: 0,
    mask: 0,
    // Last ~32 masks, keyed by seq. A late packet fills its own tick; a gap keeps the previous mask.
    inputLog: null,
    // Highest shot edge already consumed. A resent packet must not fire twice.
    shotAck: 0,
    spawnSlot: slot,
    r: PLAYER_RADIUS,
  };
  faceCenter(player, match.map);
  match.players.push(player);
  return player;
}

const INPUT_LOG = 32;

export function removePlayer(match, id) {
  match.players = match.players.filter((player) => player.id !== id);
  match.bullets = match.bullets.filter((bullet) => bullet.owner !== id);
}

export function setInput(match, id, mask, seq, shotSeq) {
  const player = match.players.find((item) => item.id === id);
  if (!player) return;
  const nextSeq = seq | 0;
  const nextMask = mask | 0;
  if (!Number.isFinite(seq) || nextSeq <= 0) return;
  if (!player.inputLog) player.inputLog = new Map();
  // Keep the mask on the seq it was sampled. A newer packet must not overwrite it.
  if (!player.inputLog.has(nextSeq)) player.inputLog.set(nextSeq, nextMask & 0xffff);
  if (nextSeq > (player.seq | 0)) player.seq = nextSeq;
  // Shot is an edge, so a lost packet is not covered by "keep the previous mask".
  // The sender repeats the same shotSeq until shotAck comes back.
  if (Number.isFinite(shotSeq)) {
    const shot = shotSeq | 0;
    if (shot > (player.shotSeq | 0)) player.shotSeq = shot;
  }
  while (player.inputLog.size > INPUT_LOG) {
    let oldest = nextSeq;
    for (const key of player.inputLog.keys()) {
      if (key < oldest) oldest = key;
    }
    player.inputLog.delete(oldest);
  }
}

// One buffered mask per tick, in sample order. A missing seq keeps the previous mask.
// A packet that arrives after its seq was passed does not fire on the arrival tick.
export function takeInput(player) {
  if (!player.inputLog || player.inputLog.size === 0) return player.mask | 0;
  const want = (player.appliedSeq | 0) + 1;
  if (player.inputLog.has(want)) {
    player.mask = player.inputLog.get(want) | 0;
    player.appliedSeq = want;
  } else {
    let oldest = 0;
    for (const key of player.inputLog.keys()) {
      if (!oldest || key < oldest) oldest = key;
    }
    // Gap or a first packet that skipped ahead. Apply the oldest buffered mask
    // on this tick so a shot is not stuck waiting for seqs that will never arrive.
    if (oldest > want) {
      player.mask = player.inputLog.get(oldest) | 0;
      player.appliedSeq = oldest;
    }
  }
  for (const key of [...player.inputLog.keys()]) {
    if (key <= (player.appliedSeq | 0)) player.inputLog.delete(key);
  }
  return player.mask | 0;
}

// A shot is an edge. The mask bit is not enough: a lost packet never becomes
// that edge, and a resent packet must not become a second one.
// shotSeq is the sample on which the key went down. It stays on every later
// packet until shotAck catches it. Cooldown, ammo and invuln still gate the spawn.
export function shotWanted(player, mask) {
  const shooting = (mask & KEY.SHOOT) !== 0;
  const pending = (player.shotSeq | 0) > (player.shotAck | 0);
  if (!shooting && !pending) return false;
  // A held key with no new edge is still a shot, just the slow one.
  // Cooldown decides when it actually spawns. Dropping it here made every
  // follow-up look like a fresh tap.
  return true;
}

export function noteShot(player) {
  const seq = player.shotSeq | 0;
  if (seq > (player.shotAck | 0)) player.shotAck = seq;
}

export function canStart(match) {
  if (match.phase !== 'waiting' && match.phase !== 'match_end') return false;
  let red = 0;
  let blue = 0;
  for (const player of match.players) {
    if (player.team === TEAM_RED) red += 1;
    else if (player.team === TEAM_BLUE) blue += 1;
  }
  return red >= 1 && blue >= 1;
}

export function pauseMatch(match) {
  if (!match || match.phase !== 'playing') return false;
  match.phase = 'paused';
  match.message = 'paused';
  return true;
}

export function resumeMatch(match) {
  if (!match || match.phase !== 'paused') return false;
  match.phase = 'playing';
  match.message = '';
  return true;
}

export function start(match) {
  if (match && match.phase === 'paused') return resumeMatch(match);
  if (!canStart(match)) return false;
  if (match.phase === 'match_end' || match.winner) {
    match.score.red = 0;
    match.score.blue = 0;
    match.stats = {};
  }
  match.winner = null;
  beginRound(match);
  return true;
}

export function applyInput(player, mask, dt) {
  if (!player.alive) return;
  const bits = mask | 0;
  let ix = 0;
  let iy = 0;
  if (bits & KEY.LEFT) ix -= 1;
  if (bits & KEY.RIGHT) ix += 1;
  if (bits & KEY.UP) iy -= 1;
  if (bits & KEY.DOWN) iy += 1;
  // Release keeps a short coast, well under half the original slide.
  if (ix === 0 && iy === 0) {
    const coast = Math.exp(-PLAYER_RELEASE_FRICTION * dt);
    player.vx *= coast;
    player.vy *= coast;
    if (Math.hypot(player.vx, player.vy) < 8) {
      player.vx = 0;
      player.vy = 0;
    }
    return;
  }
  if (ix !== 0 || iy !== 0) {
    const len = Math.hypot(ix, iy);
    ix /= len;
    iy /= len;
    const facing = turnFacing(player.fx, player.fy, ix, iy, PLAYER_TURN_RATE * dt);
    player.fx = facing.x;
    player.fy = facing.y;
    player.vx += facing.x * PLAYER_ACCEL * dt;
    player.vy += facing.y * PLAYER_ACCEL * dt;
  }
  const damp = Math.exp(-PLAYER_FRICTION * dt);
  player.vx *= damp;
  player.vy *= damp;
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > PLAYER_MAX_SPEED) {
    const scale = PLAYER_MAX_SPEED / speed;
    player.vx *= scale;
    player.vy *= scale;
  }
}

export function integratePlayer(player, map, dt) {
  if (!player.alive) {
    player.vx = 0;
    player.vy = 0;
    return;
  }
  player.r = PLAYER_RADIUS;
  // Separate first so an overlap is pushed back to the side the disc is already on,
  // instead of a single step carrying the center through a zero-thickness wall.
  resolveEnvironment(player, map);
  const dist = Math.hypot(player.vx, player.vy) * dt;
  const maxStep = PLAYER_RADIUS - 1;
  const steps = Math.max(1, Math.ceil(dist / maxStep));
  const subDt = dt / steps;
  for (let i = 0; i < steps; i++) {
    player.x += player.vx * subDt;
    player.y += player.vy * subDt;
    resolveEnvironment(player, map);
  }
}

export function step(match) {
  if (match.phase === 'paused') return;
  if (match.phase === 'waiting' || match.phase === 'match_end') {
    for (const player of match.players) {
      applyInput(player, takeInput(player, match.tick), DT);
      integratePlayer(player, match.map, DT);
    }
    resolveCrowd(match);
  } else if (match.phase === 'round_end') {
    // The pause does not move anyone, but it still has to consume masks.
    // Otherwise the next round replays the whole pause as a lunge off spawn.
    for (const player of match.players) takeInput(player, match.tick);
    match.pause -= DT;
    if (match.pause <= 0) {
      match.pause = 0;
      const winsNeeded = matchWins(match);
      if (match.score.red >= winsNeeded || match.score.blue >= winsNeeded) {
        const winner = match.score.red >= winsNeeded ? TEAM_RED : TEAM_BLUE;
        endMatch(match, winner);
      } else {
        beginRound(match);
      }
    }
  } else if (match.phase === 'playing') {
    for (const player of match.players) {
      if (!player.alive) continue;
      const mask = takeInput(player, match.tick);
      applyInput(player, mask, DT);
      player.cooldown = Math.max(0, player.cooldown - DT);
      player.invuln = Math.max(0, player.invuln - DT);
      tickReload(player);
      const keyDown = (mask & KEY.SHOOT) !== 0;
      const shooting = shotWanted(player, mask);
      // Release is the only thing that clears the hold. A tick that is still
      // waiting on cooldown is not a release.
      if (!keyDown) player.triggerWasDown = false;
      if (shooting && player.cooldown <= 0 && player.invuln <= 0 && !player.reloading && player.ammo > 0) {
        if (spawnBullet(match, player)) {
          noteShot(player);
          player.ammo -= 1;
          const tapped = !player.triggerWasDown;
          // Holding stays at the old rate. A fresh click only waits out the short floor.
          player.cooldown = tapped ? BULLET_TAP_RATE : BULLET_COOLDOWN;
          player.triggerWasDown = true;
          if (player.ammo <= 0) beginReload(player);
        }
      }
    }
    for (const player of match.players) {
      if (player.alive) integratePlayer(player, match.map, DT);
    }
    resolveCrowd(match);
    stepBullets(match);
    maybeEndRound(match);
  }
  match.tick += 1;
  pruneEvents(match);
}

function roundTenth(value) {
  return Math.round(value * 10) / 10;
}

function roundHundredth(value) {
  return Math.round(value * 100) / 100;
}

function roundUnit(value) {
  return Math.round(value);
}

export function snapshot(match, opts) {
  const since = opts && Number.isFinite(opts.sinceEvent) ? opts.sinceEvent : 0;
  const events = [];
  let lastEvent = since | 0;
  for (const event of match.recentEvents) {
    const id = event && event.id | 0;
    if (id <= since) continue;
    events.push(event);
    if (id > lastEvent) lastEvent = id;
  }
  return {
    tick: match.tick,
    mapId: match.map && match.map.id ? match.map.id : '',
    phase: match.phase,
    timeLeft: roundTenth(match.timeLeft),
    overtime: match.overtime,
    score: scoreCopy(match),
    stats: statsCopy(match),
    message: match.message,
    winner: match.winner,
    lastEvent,
    players: match.players.map((player) => ({
      id: player.id,
      x: roundTenth(player.x),
      y: roundTenth(player.y),
      vx: roundTenth(player.vx),
      vy: roundTenth(player.vy),
      facing: roundHundredth(Math.atan2(player.fy, player.fx)),
      alive: player.alive,
      team: player.team,
      invuln: roundTenth(player.invuln),
      // Seq the referee already consumed. The owner replays only masks after this.
      ack: player.appliedSeq | 0,
      shotAck: player.shotAck | 0,
      ammo: player.ammo,
      reloading: player.reloading,
      reloadLeft: roundTenth(player.reloadLeft),
      reloadDuration: roundTenth(player.reloadDuration),
    })),
    bullets: match.bullets.map((bullet) => ({
      id: bullet.id,
      owner: bullet.owner,
      team: bullet.team,
      x: roundTenth(bullet.x),
      y: roundTenth(bullet.y),
      vx: roundUnit(bullet.vx),
      vy: roundUnit(bullet.vy),
      life: roundHundredth(bullet.life),
      // Visual tumble only. The client spins from the sign so a 0.1 rad
      // quantize cannot make the core jump inside the ball.
      spin: bullet.spin < 0 ? -1 : 1,
    })),
    events,
  };
}

function beginRound(match) {
  match.phase = 'playing';
  match.timeLeft = matchRules(match).roundTime;
  match.overtime = false;
  match.pause = 0;
  match.winner = null;
  match.message = '';
  match.bullets = [];
  for (const player of match.players) {
    const pos = spawnPosition(match, player.team, player.spawnSlot);
    player.x = pos.x;
    player.y = pos.y;
    player.vx = 0;
    player.vy = 0;
    player.alive = true;
    player.invuln = SPAWN_INVULN;
    player.cooldown = 0;
    player.triggerWasDown = false;
    resetAmmo(player);
    player.r = PLAYER_RADIUS;
    faceCenter(player, match.map);
  }
}

function endMatch(match, winner) {
  match.phase = 'match_end';
  match.winner = winner;
  match.overtime = false;
  match.message = winner === TEAM_RED ? 'redMatch' : 'blueMatch';
  pushEvent(match, {
    type: 'match_end',
    winner,
    score: scoreCopy(match),
    colorTeam: winner,
    x: mapCenter(match.map).x,
    y: mapCenter(match.map).y,
  });
}

function maybeEndRound(match) {
  const redAlive = countAlive(match, TEAM_RED);
  const blueAlive = countAlive(match, TEAM_BLUE);
  // An empty roster is not a wipe. The side that is alone on the field does not score.
  if (countTeam(match, TEAM_RED) === 0 || countTeam(match, TEAM_BLUE) === 0) {
    if (!match.overtime) tickRoundClock(match);
    return;
  }
  if (redAlive === 0 && blueAlive > 0) {
    awardRound(match, TEAM_BLUE);
    return;
  }
  if (blueAlive === 0 && redAlive > 0) {
    awardRound(match, TEAM_RED);
    return;
  }
  if (match.overtime) return;
  maybeEndRoundClock(match, redAlive, blueAlive);
}

function matchRules(match) {
  return match.rules || clampRules(null);
}

function matchWins(match) {
  return matchRules(match).winsNeeded;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function resetAmmo(player) {
  player.ammo = MAG_SIZE;
  player.reloading = false;
  player.reloadLeft = 0;
  player.reloadDuration = 0;
  player.reloadWasDown = false;
}

function reloadSeconds(used) {
  if (used <= 0) return 0;
  return (used / MAG_SIZE) * RELOAD_EMPTY;
}

function beginReload(player) {
  if (player.reloading || player.ammo >= MAG_SIZE) return;
  const duration = reloadSeconds(MAG_SIZE - player.ammo);
  if (duration <= 0) {
    player.ammo = MAG_SIZE;
    return;
  }
  player.reloading = true;
  player.reloadDuration = duration;
  player.reloadLeft = duration;
}

function tickReload(player) {
  const wantsReload = (player.mask & KEY.RELOAD) !== 0;
  if (wantsReload && !player.reloadWasDown) beginReload(player);
  player.reloadWasDown = wantsReload;
  if (!player.reloading) return;
  player.reloadLeft = Math.max(0, player.reloadLeft - DT);
  if (player.reloadLeft > 0) return;
  player.ammo = MAG_SIZE;
  player.reloading = false;
  player.reloadLeft = 0;
  player.reloadDuration = 0;
}

function tickRoundClock(match) {
  match.timeLeft -= DT;
  if (match.timeLeft < 0) match.timeLeft = 0;
}

function maybeEndRoundClock(match, redAlive, blueAlive) {
  tickRoundClock(match);
  if (match.timeLeft > 0) return;
  if (redAlive > blueAlive) awardRound(match, TEAM_RED);
  else if (blueAlive > redAlive) awardRound(match, TEAM_BLUE);
  else {
    match.overtime = true;
    match.message = 'overtime';
  }
}

function awardRound(match, team) {
  match.score[team] += 1;
  match.phase = 'round_end';
  match.pause = ROUND_END_PAUSE;
  match.overtime = false;
  match.winner = team;
  match.message = team === TEAM_RED ? 'redRound' : 'blueRound';
  const center = mapCenter(match.map);
  pushEvent(match, {
    type: 'round_end',
    winner: team,
    score: scoreCopy(match),
    colorTeam: team,
    x: center.x,
    y: center.y,
  });
}

function countTeam(match, team) {
  let n = 0;
  for (const player of match.players) {
    if (player.team === team) n += 1;
  }
  return n;
}

function countAlive(match, team) {
  let n = 0;
  for (const player of match.players) {
    if (player.team === team && player.alive) n += 1;
  }
  return n;
}

function scoreCopy(match) {
  return { red: match.score.red, blue: match.score.blue };
}

function noteFrag(match, killerId, victimId) {
  if (!match.stats) match.stats = {};
  if (victimId) {
    const victim = match.stats[victimId] || (match.stats[victimId] = { k: 0, d: 0 });
    victim.d += 1;
  }
  if (killerId && killerId !== victimId) {
    const killer = match.stats[killerId] || (match.stats[killerId] = { k: 0, d: 0 });
    killer.k += 1;
  }
}

function statsCopy(match) {
  const out = {};
  const stats = match.stats || {};
  for (const id of Object.keys(stats)) {
    const row = stats[id];
    const k = row && row.k | 0;
    const d = row && row.d | 0;
    if (!k && !d) continue;
    out[id] = { k, d };
  }
  return out;
}

function pushEvent(match, fields) {
  match.recentEvents.push({
    id: match.nextEventId++,
    type: fields.type,
    x: fields.x ?? 0,
    y: fields.y ?? 0,
    colorTeam: fields.colorTeam ?? null,
    victimId: fields.victimId ?? null,
    killerId: fields.killerId ?? null,
    winner: fields.winner ?? null,
    score: fields.score ?? null,
    team: fields.team ?? fields.colorTeam ?? null,
    tick: match.tick,
  });
}

function pruneEvents(match) {
  const tick = match.tick;
  match.recentEvents = match.recentEvents.filter((event) => tick - event.tick <= EVENT_HISTORY);
}

// Lockstep seed: same tick + seq must yield the same angle on every peer.
// Math.random() here would desync host and server. Not a cryptographic mix.
function shotUnit(tick, seq, salt) {
  let h = (Math.imul(tick | 0, 0x9e3779b1) ^ Math.imul(seq | 0, 0x85ebca6b) ^ Math.imul(salt | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

function spawnBullet(match, player) {
  let fx = player.fx;
  let fy = player.fy;
  const flen = Math.hypot(fx, fy);
  if (flen < 1e-8) {
    fx = 1;
    fy = 0;
  } else {
    fx /= flen;
    fy /= flen;
  }
  const steps = Math.round(BULLET_SPREAD / BULLET_SPREAD_STEP);
  // appliedSeq is the mask this tick consumed. player.seq is the newest packet
  // and can already belong to a later tick, so it must not feed the seed.
  const shotSeq = player.appliedSeq | 0;
  const spread = Math.floor(shotUnit(match.tick, shotSeq, 1) * (steps + 1)) * BULLET_SPREAD_STEP;
  const side = shotUnit(match.tick, shotSeq, 2) < 0.5 ? -1 : 1;
  const hook = side * spread;
  const cos = Math.cos(hook);
  const sin = Math.sin(hook);
  const dx = fx * cos - fy * sin;
  const dy = fx * sin + fy * cos;
  const spin = side * BULLET_SPIN;
  const gripX = player.x + fx * PLAYER_RADIUS * MARKER_ALONG - fy * PLAYER_RADIUS * MARKER_RIGHT;
  const gripY = player.y + fy * PLAYER_RADIUS * MARKER_ALONG + fx * PLAYER_RADIUS * MARKER_RIGHT;
  const muzzle = MARKER_TIP + BULLET_RADIUS + 1;
  const bullet = {
    id: match.nextBulletId++,
    owner: player.id,
    team: player.team,
    x: gripX + dx * muzzle,
    y: gripY + dy * muzzle,
    vx: dx * BULLET_SPEED + player.vx * BULLET_INHERIT,
    vy: dy * BULLET_SPEED + player.vy * BULLET_INHERIT,
    life: BULLET_LIFE,
    ignore: BULLET_IGNORE,
    r: BULLET_RADIUS,
    angle: shotUnit(match.tick, shotSeq, 3) * Math.PI * 2,
    spin,
    curve: (hook * 2) / BULLET_LIFE,
  };
  // Spawn sits a radius past the player, which is already through a wall they are touching.
  if (collideBullet(match, bullet, player.x, player.y)) return false;
  match.bullets.push(bullet);
  return true;
}

function stepBullets(match) {
  const kept = [];
  for (const bullet of match.bullets) {
    if (advanceBullet(match, bullet)) kept.push(bullet);
  }
  match.bullets = kept;
}

function advanceBullet(match, bullet) {
  const dist = Math.hypot(bullet.vx, bullet.vy) * DT;
  const steps = Math.max(1, Math.ceil(dist / BULLET_MAX_STEP));
  const subDt = DT / steps;
  for (let i = 0; i < steps; i++) {
    if (bullet.life <= 0) return false;
    const x0 = bullet.x;
    const y0 = bullet.y;
    bullet.x += bullet.vx * subDt;
    bullet.y += bullet.vy * subDt;
    if (collideBullet(match, bullet, x0, y0)) return false;
    bullet.life -= subDt;
    bullet.ignore = Math.max(0, bullet.ignore - subDt);
    // Straight for the first half, then the stepped hook and tumble kick in.
    if (bullet.life > BULLET_LIFE * 0.5) {
      if (bullet.life <= 0) return false;
      continue;
    }
    bullet.angle = (bullet.angle || 0) + (bullet.spin || 0) * subDt;
    const curve = (bullet.curve || 0) * subDt;
    if (curve !== 0) {
      const cos = Math.cos(curve);
      const sin = Math.sin(curve);
      const vx = bullet.vx;
      const vy = bullet.vy;
      bullet.vx = vx * cos - vy * sin;
      bullet.vy = vx * sin + vy * cos;
    }
    if (bullet.life <= 0) return false;
  }
  return true;
}

function collideBullet(match, bullet, x0, y0) {
  const obstacle = firstObstacle(match, x0, y0, bullet.x, bullet.y);
  if (obstacle) {
    pushEvent(match, {
      type: 'hit',
      x: obstacle.x,
      y: obstacle.y,
      colorTeam: bullet.team,
      victimId: null,
      killerId: bullet.owner,
    });
    return true;
  }
  const enemy = sweptEnemy(match, bullet, x0, y0);
  if (enemy) {
    const contact = contactOnCircle(enemy.hitX, enemy.hitY, enemy.player.x, enemy.player.y, PLAYER_RADIUS);
    pushEvent(match, {
      type: 'hit',
      x: contact.x,
      y: contact.y,
      colorTeam: bullet.team,
      victimId: enemy.player.id,
      killerId: bullet.owner,
    });
    enemy.player.alive = false;
    enemy.player.vx = 0;
    enemy.player.vy = 0;
    noteFrag(match, bullet.owner, enemy.player.id);
    pushEvent(match, {
      type: 'death',
      x: enemy.player.x,
      y: enemy.player.y,
      colorTeam: bullet.team,
      team: bullet.team,
      victimId: enemy.player.id,
      killerId: bullet.owner,
    });
    return true;
  }
  return false;
}

// Sub-step segment vs disc. End-point hitsCircle misses a bullet that is already
// past the disc when the 4 px slice finishes. Friendly fire stays off.
function sweptEnemy(match, bullet, x0, y0) {
  let best = null;
  for (const player of match.players) {
    if (!player.alive || player.invuln > 0) continue;
    if (player.team === bullet.team) continue;
    if (bullet.ignore > 0 && player.id === bullet.owner) continue;
    const hit = sweepDisc(x0, y0, bullet.x, bullet.y, player.x, player.y, PLAYER_RADIUS);
    if (!hit) continue;
    if (!best || hit.t < best.t) best = { player, hitX: hit.x, hitY: hit.y, t: hit.t };
  }
  return best;
}

function sweepDisc(x0, y0, x1, y1, cx, cy, radius) {
  const reach = radius + BULLET_RADIUS;
  if (hitsCircle(x1, y1, BULLET_RADIUS, cx, cy, radius)) {
    return { x: x1, y: y1, t: 1 };
  }
  if (hitsCircle(x0, y0, BULLET_RADIUS, cx, cy, radius)) {
    return { x: x0, y: y0, t: 0 };
  }
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return null;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - reach * reach;
  const disc = b * b - 4 * len2 * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t = (-b - root) / (2 * len2);
  if (t < 0 || t > 1) return null;
  return { x: x0 + t * dx, y: y0 + t * dy, t };
}

function firstObstacle(match, x0, y0, x1, y1) {
  let best = null;
  for (const wall of wallsOf(match.map)) {
    const hit = sweepWall(x0, y0, x1, y1, wall);
    if (!hit) continue;
    if (!best || hit.t < best.t) best = hit;
  }
  const pillars = match.map.discs || [];
  for (const pillar of pillars) {
    const hit = sweepPillar(x0, y0, x1, y1, pillar);
    if (!hit) continue;
    if (!best || hit.t < best.t) best = hit;
  }
  return best;
}

function sweepWall(x0, y0, x1, y1, wall) {
  const crossed = segmentIntersection(x0, y0, x1, y1, wall.x1, wall.y1, wall.x2, wall.y2);
  if (crossed) return { x: crossed.x, y: crossed.y, t: crossed.t };
  const end = wallContact(x1, y1, wall);
  if (end) return { x: end.x, y: end.y, t: 1 };
  const start = wallContact(x0, y0, wall);
  if (start) return { x: start.x, y: start.y, t: 0 };
  return grazeWall(x0, y0, x1, y1, wall);
}

function wallContact(x, y, wall) {
  const closest = closestPointOnSegment(x, y, wall.x1, wall.y1, wall.x2, wall.y2);
  const dx = x - closest.x;
  const dy = y - closest.y;
  if (dx * dx + dy * dy < BULLET_RADIUS * BULLET_RADIUS) return closest;
  return null;
}

function grazeWall(x0, y0, x1, y1, wall) {
  const candidates = [];
  const c0 = closestPointOnSegment(x0, y0, wall.x1, wall.y1, wall.x2, wall.y2);
  candidates.push({ x: c0.x, y: c0.y, dist: Math.hypot(x0 - c0.x, y0 - c0.y), t: 0 });
  const c1 = closestPointOnSegment(x1, y1, wall.x1, wall.y1, wall.x2, wall.y2);
  candidates.push({ x: c1.x, y: c1.y, dist: Math.hypot(x1 - c1.x, y1 - c1.y), t: 1 });
  const t0 = closestPointOnSegment(wall.x1, wall.y1, x0, y0, x1, y1);
  candidates.push({
    x: wall.x1,
    y: wall.y1,
    dist: Math.hypot(wall.x1 - t0.x, wall.y1 - t0.y),
    t: t0.t,
  });
  const t1 = closestPointOnSegment(wall.x2, wall.y2, x0, y0, x1, y1);
  candidates.push({
    x: wall.x2,
    y: wall.y2,
    dist: Math.hypot(wall.x2 - t1.x, wall.y2 - t1.y),
    t: t1.t,
  });
  let best = null;
  for (const candidate of candidates) {
    if (candidate.dist >= BULLET_RADIUS) continue;
    if (!best || candidate.t < best.t) best = candidate;
  }
  return best;
}

function sweepPillar(x0, y0, x1, y1, pillar) {
  const pr = pillar.radius || 0;
  if (hitsCircle(x1, y1, BULLET_RADIUS, pillar.x, pillar.y, pr)) {
    const contact = contactOnCircle(x1, y1, pillar.x, pillar.y, pr);
    return { x: contact.x, y: contact.y, t: 1 };
  }
  if (hitsCircle(x0, y0, BULLET_RADIUS, pillar.x, pillar.y, pr)) {
    const contact = contactOnCircle(x0, y0, pillar.x, pillar.y, pr);
    return { x: contact.x, y: contact.y, t: 0 };
  }
  const closest = closestPointOnSegment(pillar.x, pillar.y, x0, y0, x1, y1);
  const dist = Math.hypot(closest.x - pillar.x, closest.y - pillar.y);
  if (dist <= pr + BULLET_RADIUS) {
    const contact = contactOnCircle(closest.x, closest.y, pillar.x, pillar.y, pr);
    return { x: contact.x, y: contact.y, t: closest.t };
  }
  return null;
}

function contactOnCircle(px, py, cx, cy, radius) {
  let dx = px - cx;
  let dy = py - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-8) return { x: cx + radius, y: cy };
  return { x: cx + (dx / len) * radius, y: cy + (dy / len) * radius };
}

function segmentIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
  const rx = x2 - x1;
  const ry = y2 - y1;
  const sx = x4 - x3;
  const sy = y4 - y3;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-10) return null;
  const qpx = x3 - x1;
  const qpy = y3 - y1;
  const t = (qpx * sy - qpy * sx) / den;
  const u = (qpx * ry - qpy * rx) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: x1 + t * rx, y: y1 + t * ry, t };
  }
  return null;
}

function resolveCrowd(match) {
  const alive = match.players.filter((player) => player.alive);
  for (const player of alive) player.r = PLAYER_RADIUS;
  for (let iter = 0; iter < PAIR_ITERS; iter++) {
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        resolveDiscDisc(alive[i], alive[j]);
      }
    }
    for (const player of alive) resolveEnvironment(player, match.map);
  }
}

function resolveEnvironment(player, map) {
  if (!map) return;
  player.r = PLAYER_RADIUS;
  const walls = wallsOf(map);
  const pillars = map.discs || [];
  for (let iter = 0; iter < ENV_ITERS; iter++) {
    for (const wall of walls) resolveDiscSegment(player, wall);
    for (const pillar of pillars) resolveStaticDisc(player, pillar);
  }
}

function resolveStaticDisc(player, pillar) {
  const pr = pillar.radius || 0;
  let dx = player.x - pillar.x;
  let dy = player.y - pillar.y;
  let dist = Math.hypot(dx, dy);
  const minDist = PLAYER_RADIUS + pr;
  if (!(dist < minDist)) return;
  let nx;
  let ny;
  if (dist > 0) {
    nx = dx / dist;
    ny = dy / dist;
  } else {
    nx = 1;
    ny = 0;
    dist = 0;
  }
  const pen = minDist - dist;
  player.x += nx * pen;
  player.y += ny * pen;
  const vn = player.vx * nx + player.vy * ny;
  if (vn < 0) {
    player.vx -= vn * nx;
    player.vy -= vn * ny;
  }
}

function wallsOf(map) {
  if (!map) return [];
  return (map.bounds || []).concat(map.segments || []);
}

function spawnPosition(match, team, slot) {
  const spawns = (match.map.spawns && match.map.spawns[team]) || [];
  if (!spawns.length) return mapCenter(match.map);
  return pointOf(spawns[slot % spawns.length]);
}

function pointOf(spawn) {
  if (Array.isArray(spawn)) return { x: spawn[0], y: spawn[1] };
  return { x: spawn.x, y: spawn.y };
}

function mapCenter(map) {
  return { x: (map.width || 0) / 2, y: (map.height || 0) / 2 };
}

function turnFacing(fx, fy, tx, ty, maxStep) {
  let x = fx;
  let y = fy;
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 1e-8) {
    x = 1;
    y = 0;
  }
  const cross = x * ty - y * tx;
  const dot = x * tx + y * ty;
  const delta = Math.atan2(cross, dot);
  const step = Math.max(-maxStep, Math.min(maxStep, delta));
  const cos = Math.cos(step);
  const sin = Math.sin(step);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
  };
}

function faceCenter(player, map) {
  const center = mapCenter(map);
  const dx = center.x - player.x;
  const dy = center.y - player.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-8) {
    player.fx = 1;
    player.fy = 0;
  } else {
    player.fx = dx / len;
    player.fy = dy / len;
  }
}
