// Deterministic tests for shared/sim.js. Run: node shared/sim.test.js
// Physics is not patched here. If a case is not a sim guarantee, the test
// documents the current behavior instead of inventing a pass.

import assert from 'node:assert/strict';
import {
  DT,
  KEY,
  PLAYER_RADIUS,
  BULLET_RADIUS,
  BULLET_COOLDOWN,
  BULLET_TAP_RATE,
  BULLET_SPREAD,
  SPAWN_INVULN,
  ROUND_END_PAUSE,
  TEAM_RED,
  TEAM_BLUE,
} from './constants.js';
import { createMatch, addPlayer, removePlayer, setInput, start, step, snapshot } from './sim.js';
import { hitsCircle } from './collide.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function boxMap() {
  const width = 800;
  const height = 600;
  return {
    id: 'test-box',
    width,
    height,
    bounds: [
      { x1: 0, y1: 0, x2: width, y2: 0 },
      { x1: width, y1: 0, x2: width, y2: height },
      { x1: width, y1: height, x2: 0, y2: height },
      { x1: 0, y1: height, x2: 0, y2: 0 },
    ],
    segments: [],
    discs: [],
    spawns: {
      red: [{ x: 120, y: 300 }],
      blue: [{ x: 680, y: 300 }],
    },
  };
}

function cornerMap() {
  // L-shaped obstacle: vertical wall ending at a corner, then a horizontal wall.
  const map = boxMap();
  map.id = 'test-corner';
  map.segments = [
    { x1: 400, y1: 0, x2: 400, y2: 280 },
    { x1: 400, y1: 280, x2: 800, y2: 280 },
  ];
  return map;
}

function pillarMap() {
  const map = boxMap();
  map.id = 'test-pillar';
  map.discs = [{ x: 400, y: 300, radius: 28 }];
  return map;
}

function rules(extra) {
  return { roundTime: 60, winsNeeded: 5, ...extra };
}

function makePlaying(map, opts = {}) {
  const match = createMatch(map, rules(opts.rules));
  const red = addPlayer(match, { id: 'red', nick: 'red', team: TEAM_RED });
  const blue = addPlayer(match, { id: 'blue', nick: 'blue', team: TEAM_BLUE });
  assert.equal(start(match), true);
  if (opts.skipInvuln !== false) {
    red.invuln = 0;
    blue.invuln = 0;
  }
  return { match, red, blue };
}

function steps(match, n) {
  for (let i = 0; i < n; i++) step(match);
}

function place(player, x, y, facing) {
  player.x = x;
  player.y = y;
  player.vx = 0;
  player.vy = 0;
  if (facing) {
    player.fx = facing.x;
    player.fy = facing.y;
  }
}

function alive(match, id) {
  const player = match.players.find((item) => item.id === id);
  return !!(player && player.alive);
}

test('ruch w ścianę nie wynosi środka dysku poza pole', () => {
  const map = boxMap();
  const { match, red } = makePlaying(map);
  place(red, PLAYER_RADIUS + 2, 300, { x: -1, y: 0 });
  setInput(match, red.id, KEY.LEFT, 1);
  steps(match, 180);
  assert.ok(red.x >= PLAYER_RADIUS - 1e-6, `x=${red.x} weszło w lewą ścianę`);
  assert.ok(red.x < 80, `x=${red.x} nie doszło do ściany`);
  assert.ok(red.vx <= 1e-6, `vx=${red.vx} nadal pcha w ścianę`);
});

test('spychanie dwóch dysków rozdziela je na co najmniej sumę promieni', () => {
  const map = boxMap();
  const { match, red, blue } = makePlaying(map);
  place(red, 400, 300, { x: 1, y: 0 });
  place(blue, 400 + PLAYER_RADIUS, 300, { x: 1, y: 0 });
  setInput(match, red.id, KEY.RIGHT, 1);
  steps(match, 90);
  const dist = Math.hypot(blue.x - red.x, blue.y - red.y);
  assert.ok(dist >= PLAYER_RADIUS * 2 - 1e-4, `dist=${dist} dyski się przenikają`);
  assert.ok(blue.x > 400 + PLAYER_RADIUS, `blue.x=${blue.x} nie został odepchnięty`);
});

test('trzymana spacja strzela wolniej niż szybkie klikanie', () => {
  const holdTicks = Math.round(BULLET_COOLDOWN / DT);
  const tapTicks = Math.max(1, Math.round(BULLET_TAP_RATE / DT));
  assert.ok(holdTicks > tapTicks, 'hold nie jest wolniejszy od tapu');

  function countShots(drive, ticks) {
    const { match, red } = makePlaying(boxMap());
    red.ammo = 50;
    red.cooldown = 0;
    let shots = 0;
    for (let tick = 1; tick <= ticks; tick++) {
      const before = match.bullets.length;
      drive(match, red, tick);
      step(match);
      shots += Math.max(0, match.bullets.length - before);
    }
    return shots;
  }

  const ticks = holdTicks * 3 + 1;
  // Same shape as the client: shotSeq bumps on key-down and stays until ack.
  const held = countShots((match, red, tick) => {
    setInput(match, red.id, KEY.SHOOT, tick, 1);
  }, ticks);
  const tapped = countShots((match, red, tick) => {
    const down = tick % (tapTicks + 1) === 1;
    const edge = Math.floor((tick - 1) / (tapTicks + 1)) + 1;
    setInput(match, red.id, down ? KEY.SHOOT : 0, tick, edge);
  }, ticks);

  assert.equal(held, 4, `hold wystrzelił ${held} zamiast 4`);
  assert.ok(tapped > held, `tap=${tapped} nie jest szybszy od hold=${held}`);
});

test('pocisk przez róg nie przelatuje na drugą stronę ściany', () => {
  const map = cornerMap();
  const { match, red, blue } = makePlaying(map);
  // Corner of the L is (400, 280). Aim just past it from the open side.
  place(red, 360, 300, { x: 1, y: 0 });
  red.fx = 400 - red.x;
  red.fy = 280 - red.y;
  const flen = Math.hypot(red.fx, red.fy);
  red.fx /= flen;
  red.fy /= flen;
  place(blue, 430, 250, { x: -1, y: 0 });
  blue.invuln = 0;
  red.invuln = 0;
  red.ammo = 50;
  red.cooldown = 0;
  setInput(match, red.id, KEY.SHOOT, 1);
  step(match);
  assert.ok(match.bullets.length >= 1 || !alive(match, blue.id), 'strzał nie powstał');
  steps(match, 40);
  assert.equal(alive(match, blue.id), true, 'pocisk przeszedł róg i zabił za ścianą');
  const leaked = match.bullets.some((bullet) => bullet.x > 400 + BULLET_RADIUS && bullet.y < 280);
  assert.equal(leaked, false, 'pocisk jest po drugiej stronie rogu');
});
test('pocisk muskający dysk nie zabija, pocisk w dysk zabija', () => {
  const map = pillarMap();
  const pillar = map.discs[0];
  // Hook is random up to BULLET_SPREAD. Clearance must survive the worst hook
  // over the flight to the pillar, otherwise a "graze" is sometimes a hit.
  const flight = pillar.x - 80;
  const clearance = flight * Math.tan(BULLET_SPREAD) + BULLET_RADIUS + 8;
  let sawMiss = false;
  for (let trial = 0; trial < 24; trial++) {
    const match = createMatch(map, rules());
    const red = addPlayer(match, { id: 'red', nick: 'red', team: TEAM_RED });
    const blue = addPlayer(match, { id: 'blue', nick: 'blue', team: TEAM_BLUE });
    assert.equal(start(match), true);
    place(red, 80, pillar.y + pillar.radius + clearance, { x: 1, y: 0 });
    place(blue, 700, 300, { x: -1, y: 0 });
    red.invuln = 0;
    blue.invuln = 0;
    red.ammo = 50;
    red.cooldown = 0;
    setInput(match, red.id, KEY.SHOOT, 1);
    step(match);
    assert.equal(match.bullets.length, 1, 'muskający strzał nie powstał');
    // Life is 1s and the hold keeps firing, so only follow the first bullet.
    const shot = match.bullets[0];
    let closest = Infinity;
    for (let i = 0; i < 70 && match.bullets.includes(shot); i++) {
      const d = Math.hypot(shot.x - pillar.x, shot.y - pillar.y);
      if (d < closest) closest = d;
      step(match);
    }
    assert.equal(match.bullets.includes(shot), false, 'pierwszy pocisk nie zszedł ze sceny');
    assert.ok(closest > pillar.radius + BULLET_RADIUS, `closest=${closest} musknięcie weszło w dysk`);
    assert.equal(alive(match, blue.id), true);
    const paintOnPillar = match.recentEvents.some((event) => event.type === 'hit' && event.victimId == null);
    assert.equal(paintOnPillar, false, 'muskający pocisk zaliczył filar');
    sawMiss = true;
  }
  assert.equal(sawMiss, true);

  // Center line. Spread can walk off a thin target, so repeat until a shot
  // actually meets the disc — that meeting must stop the bullet.
  let blocked = false;
  for (let trial = 0; trial < 40 && !blocked; trial++) {
    const hit = createMatch(map, rules());
    const shooter = addPlayer(hit, { id: 'red', nick: 'red', team: TEAM_RED });
    const target = addPlayer(hit, { id: 'blue', nick: 'blue', team: TEAM_BLUE });
    assert.equal(start(hit), true);
    place(shooter, 80, pillar.y, { x: 1, y: 0 });
    place(target, 700, 80, { x: -1, y: 0 });
    shooter.invuln = 0;
    target.invuln = 0;
    shooter.ammo = 50;
    shooter.cooldown = 0;
    setInput(hit, shooter.id, KEY.SHOOT, 1);
    step(hit);
    const shot = hit.bullets[0];
    for (let i = 0; i < 40 && hit.bullets.includes(shot); i++) step(hit);
    blocked = hit.recentEvents.some((event) => event.type === 'hit' && event.victimId == null);
    assert.equal(alive(hit, target.id), true, 'pocisk przeszedł przez dysk i zabił za nim');
  }
  assert.equal(blocked, true, 'żaden pocisk wycelowany w środek dysku go nie trafił');
});;

test('koniec czasu przy równej liczbie żywych wchodzi w dogrywkę bez punktu', () => {
  const { match } = makePlaying(boxMap(), { rules: { roundTime: 60, winsNeeded: 3 } });
  const before = { red: match.score.red, blue: match.score.blue };
  const ticks = Math.ceil(60 / DT) + 2;
  steps(match, ticks);
  assert.equal(match.overtime, true);
  assert.equal(match.phase, 'playing');
  assert.equal(match.timeLeft, 0);
  assert.equal(match.message, 'overtime');
  assert.deepEqual(match.score, before);
});
test('koniec czasu przy przewadze żywych daje punkt, nie dogrywkę', () => {
  // Clock and wipe share maybeEndRound, and a wipe is checked first. A dead
  // blue at tick 1 would score immediately and never reach timeLeft === 0.
  // Extra living discs keep both sides non-empty until the clock drains.
  const map = boxMap();
  const match = createMatch(map, rules({ roundTime: 60, winsNeeded: 3 }));
  const redA = addPlayer(match, { id: 'red-a', nick: 'a', team: TEAM_RED });
  const redB = addPlayer(match, { id: 'red-b', nick: 'b', team: TEAM_RED });
  const blue = addPlayer(match, { id: 'blue', nick: 'blue', team: TEAM_BLUE });
  assert.equal(start(match), true);
  redA.invuln = 0;
  redB.invuln = 0;
  blue.invuln = 0;
  const ticksToZero = Math.ceil(60 / DT);
  steps(match, ticksToZero - 1);
  assert.equal(match.phase, 'playing');
  assert.equal(match.score.red, 0);
  // maybeEndRound awards a wipe before tickRoundClock, so this tick still
  // shows the last slice of time. Equal alive counts would tick that slice
  // to 0 and enter overtime instead of scoring.
  assert.ok(match.timeLeft > 0 && match.timeLeft <= DT + 1e-6, `timeLeft=${match.timeLeft}`);
  blue.alive = false;
  step(match);
  assert.equal(match.phase, 'round_end');
  assert.equal(match.score.red, 1);
  assert.equal(match.score.blue, 0);
  assert.equal(match.overtime, false);
  assert.ok(match.timeLeft > 0, 'wipe jest liczony przed zejściem zegara do zera');
});;

test('dogrywka nie kończy się samym upływem czasu i punktuje wipe', () => {
  const { match, blue } = makePlaying(boxMap(), { rules: { roundTime: 60, winsNeeded: 3 } });
  steps(match, Math.ceil(60 / DT) + 2);
  assert.equal(match.overtime, true);
  const frozen = match.timeLeft;
  steps(match, 120);
  assert.equal(match.phase, 'playing');
  assert.equal(match.overtime, true);
  assert.equal(match.timeLeft, frozen);
  assert.equal(match.score.red, 0);
  blue.alive = false;
  step(match);
  assert.equal(match.phase, 'round_end');
  assert.equal(match.score.red, 1);
  assert.equal(match.overtime, false);
});

test('pusty roster nie daje punktu', () => {
  const map = boxMap();
  const match = createMatch(map, rules());
  const red = addPlayer(match, { id: 'red', nick: 'red', team: TEAM_RED });
  const blue = addPlayer(match, { id: 'blue', nick: 'blue', team: TEAM_BLUE });
  assert.equal(start(match), true);
  red.invuln = 0;
  blue.invuln = 0;
  removePlayer(match, blue.id);
  // The remaining side is alone. Neither a wipe of the last player nor the clock scores.
  red.alive = false;
  steps(match, 30);
  assert.equal(match.phase, 'playing');
  assert.equal(match.score.red, 0);
  assert.equal(match.score.blue, 0);
  steps(match, Math.ceil(60 / DT) + 5);
  assert.equal(match.phase, 'playing');
  assert.equal(match.score.red, 0);
  assert.equal(match.score.blue, 0);
  assert.equal(match.overtime, false, 'pusty roster nie powinien wejść w dogrywkę ani dostać punktu');
});

test('sim nie ma zmiany drużyny: sama zmiana pola team nie respawnuje', () => {
  // sim.js nie eksportuje setTeam / syncRoster. Respawn przy zmianie drużyny
  // robi klient (client/game.js onRoster) i serwer (syncMatchRoster) przez
  // removePlayer + addPlayer. Ten test pilnuje tylko tego, czego sim sam
  // gwarantuje: mutacja player.team nie woła beginRound ani spawnu.
  const { match, red } = makePlaying(boxMap());
  place(red, 250, 180, { x: 1, y: 0 });
  red.vx = 40;
  red.vy = -12;
  red.alive = false;
  red.invuln = 0;
  const before = { x: red.x, y: red.y, vx: red.vx, vy: red.vy, alive: red.alive, slot: red.spawnSlot };
  red.team = TEAM_BLUE;
  steps(match, 10);
  assert.equal(red.x, before.x);
  assert.equal(red.y, before.y);
  assert.equal(red.vx, before.vx);
  assert.equal(red.vy, before.vy);
  assert.equal(red.alive, before.alive);
  assert.equal(red.spawnSlot, before.slot);
  assert.equal(red.team, TEAM_BLUE);
  assert.notEqual(match.phase, 'waiting');
});

test('addPlayer w trakcie rundy stawia na spawnie — to nie jest zmiana drużyny', () => {
  // Dokumentuje granicę API: jedyny sposób „zmiany drużyny” wewnątrz sim to
  // remove + add, a addPlayer ZAWSZE stawia dysk na spawnie nowej drużyny.
  // Sim tego nie zabrania. Zakaz respawnu musi żyć w sync rosteru, nie tutaj.
  const { match, red } = makePlaying(boxMap());
  place(red, 250, 180);
  red.alive = false;
  removePlayer(match, red.id);
  const again = addPlayer(match, { id: 'red', nick: 'red', team: TEAM_BLUE });
  const spawn = match.map.spawns.blue[0];
  assert.equal(again.x, spawn.x);
  assert.equal(again.y, spawn.y);
  assert.equal(again.alive, true);
  assert.ok(again.invuln > 0 && again.invuln <= SPAWN_INVULN);
  assert.equal(match.phase, 'playing');
});

test('zgubiony pakiet strzału nie gubi strzału, powtórzony nie daje drugiego', () => {
  const { match, red } = makePlaying(boxMap());
  place(red, 200, 300, { x: 1, y: 0 });
  red.invuln = 0;
  red.ammo = 50;
  red.cooldown = 0;
  // The mask that carried the edge never arrives. Later packets only repeat shotSeq.
  setInput(match, red.id, 0, 1, 1);
  setInput(match, red.id, 0, 2, 1);
  step(match);
  assert.equal(match.bullets.length, 1, 'powtórzona krawędź nie wypaliła');
  assert.equal(red.shotAck, 1);
  const again = snapshot(match).players.find((player) => player.id === red.id);
  assert.equal(again.shotAck, 1);
  setInput(match, red.id, 0, 3, 1);
  step(match);
  assert.equal(match.bullets.length, 1, 'ta sama krawędź wypaliła drugi raz');
});

test('ten sam tick i seq dają ten sam kąt strzału', () => {
  function shotAngle(seq) {
    const { match, red } = makePlaying(boxMap());
    place(red, 200, 300, { x: 1, y: 0 });
    red.invuln = 0;
    red.ammo = 50;
    red.cooldown = 0;
    setInput(match, red.id, KEY.SHOOT, seq);
    step(match);
    assert.equal(match.bullets.length, 1);
    const bullet = match.bullets[0];
    return Math.atan2(bullet.vy, bullet.vx);
  }
  const a = shotAngle(7);
  const b = shotAngle(7);
  const other = shotAngle(8);
  assert.equal(a, b);
  assert.notEqual(a, other);
});

test('sweep łapie pocisk, który na końcu sub-kroku jest już za dyskiem', () => {
  // Place the disc so the first 4 px slice starts clear of it and ends past it.
  // hitsCircle on that end point misses; the segment still crosses the disc.
  const map = boxMap();
  const { match, red, blue } = makePlaying(map);
  place(red, 200, 300, { x: 1, y: 0 });
  red.invuln = 0;
  red.ammo = 50;
  red.cooldown = 0;
  setInput(match, red.id, KEY.SHOOT, 1);
  step(match);
  assert.equal(match.bullets.length, 1, 'strzał nie powstał');
  const shot = match.bullets[0];
  const stepX = shot.vx * DT;
  const slices = Math.max(1, Math.ceil(Math.abs(stepX) / 4));
  const slice = stepX / slices;
  // Half a slice is still inside the 19 px reach. Sit the disc past the end point
  // so only the segment, not hitsCircle on that end, can register the hit.
  place(blue, shot.x + slice + PLAYER_RADIUS + BULLET_RADIUS + 1, shot.y, { x: -1, y: 0 });
  blue.invuln = 0;
  const endX = shot.x + slice;
  assert.equal(
    hitsCircle(endX, shot.y, BULLET_RADIUS, blue.x, blue.y, PLAYER_RADIUS),
    false,
    'koniec sub-kroku nadal nachodzi na dysk — test nie sprawdza tunelowania',
  );
  const before = snapshot(match);
  step(match);
  const after = snapshot(match);
  const was = before.players.find((player) => player.id === blue.id);
  const now = after.players.find((player) => player.id === blue.id);
  assert.equal(alive(match, blue.id), false, 'odcinek przeciął dysk, a hitsCircle na końcu by spudłował');
  assert.equal(was.alive, true);
  assert.equal(now.alive, false);
  assert.ok(
    match.recentEvents.some((event) => event.type === 'death' && event.victimId === blue.id),
    'brak eventu death',
  );
  // drawPlayersFromSpan (client/game.js) skips the lerp when before.alive !== remote.alive
  // and snaps to the dead snapshot. A half-buffer blend would still slide the living disc.
  assert.notEqual(was.alive, now.alive, 'zmiana alive jest tym, co przerywa blend');
});

test('pauza końca rundy nie przyznaje drugiego punktu sama z siebie', () => {
  const { match, blue } = makePlaying(boxMap(), { rules: { roundTime: 60, winsNeeded: 3 } });
  blue.alive = false;
  step(match);
  assert.equal(match.phase, 'round_end');
  assert.equal(match.score.red, 1);
  const pauseTicks = Math.ceil(ROUND_END_PAUSE / DT);
  steps(match, pauseTicks - 1);
  assert.equal(match.phase, 'round_end');
  assert.equal(match.score.red, 1);
});

test('pauza końca rundy zjada maski, nowa runda nie odtwarza ich od spawnu', () => {
  const { match, red, blue } = makePlaying(boxMap(), { rules: { roundTime: 60, winsNeeded: 3 } });
  blue.alive = false;
  step(match);
  assert.equal(match.phase, 'round_end');
  const pauseTicks = Math.ceil(ROUND_END_PAUSE / DT);
  for (let i = 0; i < pauseTicks; i += 1) {
    setInput(match, red.id, KEY.RIGHT, 1000 + i);
    step(match);
  }
  step(match);
  assert.equal(match.phase, 'playing');
  const spawn = match.map.spawns.red[red.spawnSlot % match.map.spawns.red.length];
  assert.ok(Math.hypot(red.x - spawn.x, red.y - spawn.y) < 1, `spawn drift ${red.x},${red.y}`);
  assert.equal(red.appliedSeq, 1000 + pauseTicks - 1);
});

let failed = 0;
for (const item of tests) {
  try {
    item.fn();
    console.log(`ok  ${item.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${item.name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error(`\n${failed} failed, ${tests.length - failed} passed`);
  process.exit(1);
}
console.log(`\n${tests.length} passed`);
