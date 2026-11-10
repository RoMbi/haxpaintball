import { PLAYER_RADIUS, BULLET_RADIUS, COLOR, MAX_PAINT, MARKER_ALONG, MARKER_RIGHT } from '../shared/constants.js';
import { discHidden } from '../shared/collide.js';
import { t } from './i18n.js';

const MARGIN = 16;
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_KEY = 'haxpaintball.zoom';
// Haxball view steps: 1 shows the whole field, 5 is a close follow cam.
const ZOOM_MUL = [1, 1.55, 2.2, 3.1, 4.3];
const cam = { zoom: 1, x: 0, y: 0, ready: false };
// Own-death cue. Short enough that a late hit reads as lag, not as a physics bug.
const DEATH_FLASH = 0.22;
const deathFx = { left: 0, kickX: 0, kickY: 0 };
// Matches the old per-frame lerp of 0.18 at 60 Hz: 1 - exp(-k / 60) = 0.18.
const CAM_FOLLOW_K = -Math.log(1 - 0.18) * 60;
let frameDt = 1 / 60;

function clampZoom(level) {
  const n = level | 0;
  if (n < ZOOM_MIN) return ZOOM_MIN;
  if (n > ZOOM_MAX) return ZOOM_MAX;
  return n;
}

export function getZoom() {
  return cam.zoom;
}

export function setZoom(level) {
  cam.zoom = clampZoom(level);
  try {
    localStorage.setItem(ZOOM_KEY, String(cam.zoom));
  } catch {
    // Storage can be blocked. The level still applies this visit.
  }
  return cam.zoom;
}

export function loadZoom() {
  try {
    const saved = Number(localStorage.getItem(ZOOM_KEY));
    if (saved >= ZOOM_MIN && saved <= ZOOM_MAX) cam.zoom = saved | 0;
  } catch {
    // Storage unavailable.
  }
  return cam.zoom;
}
const PAINT_RADIUS = 12;
const PILLAR = '#c5ced6';
const BLINK_MS = 125;
const FAINT = 0.35;

function teamColor(team) {
  if (team === 'red') return COLOR.red;
  if (team === 'blue') return COLOR.blue;
  return COLOR.dead;
}

function formatClock(timeLeft) {
  const total = Math.max(0, Math.ceil(Number(timeLeft) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

function timerLabel(hud) {
  if (hud.overtime || hud.timeLeft < 0) return t('overtime');
  return formatClock(hud.timeLeft);
}

function facingOf(player) {
  if (!Number.isFinite(player.fx) || !Number.isFinite(player.fy)) return { fx: 1, fy: 0 };
  return { fx: player.fx, fy: player.fy };
}

function fillCircle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

// Canvas Y grows down, so the player's right is (-fy, fx).
function markerGrip(x, y, fx, fy) {
  return {
    x: x + fx * PLAYER_RADIUS * MARKER_ALONG - fy * PLAYER_RADIUS * MARKER_RIGHT,
    y: y + fy * PLAYER_RADIUS * MARKER_ALONG + fx * PLAYER_RADIUS * MARKER_RIGHT,
  };
}

function reloadProgress(player) {
  if (!player || !player.reloading) return 0;
  const duration = Number(player.reloadDuration) || 0;
  const left = Math.max(0, Number(player.reloadLeft) || 0);
  if (duration <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - left / duration));
}

function drawMarker(ctx, x, y, fx, fy, reload) {
  const grip = markerGrip(x, y, fx, fy);
  const loading = reload > 0 && reload < 1;
  // Hopper lid flips open, then paintballs drop in one by one.
  const open = loading ? Math.min(1, reload / 0.12) : 0;
  const balls = 6;
  const fed = loading ? Math.min(balls, Math.floor(reload * balls) + 1) : 0;
  ctx.save();
  ctx.translate(grip.x, grip.y);
  ctx.rotate(Math.atan2(fy, fx));
  ctx.fillStyle = COLOR.nose;
  ctx.beginPath();
  ctx.moveTo(13.4, 0);
  ctx.lineTo(5.2, 2.3);
  ctx.lineTo(-1.4, 2.8);
  ctx.lineTo(-7.2, 1.6);
  ctx.lineTo(-7.2, -1.6);
  ctx.lineTo(-1.4, -2.8);
  ctx.lineTo(5.2, -2.3);
  ctx.closePath();
  ctx.fill();
  if (loading) {
    ctx.save();
    ctx.translate(-4.2, -2.2);
    ctx.rotate(-open * 1.15);
    ctx.fillStyle = '#d7dde2';
    ctx.fillRect(-1.2, -5.4, 2.4, 5.6);
    ctx.beginPath();
    ctx.arc(0, -5.4, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = COLOR.bulletCore;
    for (let i = 0; i < fed; i++) {
      const drop = ((reload * balls) - i) % 1;
      fillCircle(ctx, -3.6 + i * 1.15, -7.2 + drop * 5.4, 1.15);
    }
  }
  ctx.restore();
}

function strokeSegments(ctx, segments) {
  if (!Array.isArray(segments)) return;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
  }
}

export function noteDeathFlash() {
  deathFx.left = DEATH_FLASH;
  const angle = Math.random() * Math.PI * 2;
  deathFx.kickX = Math.cos(angle);
  deathFx.kickY = Math.sin(angle);
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  // Caller caps and fades paint (MAX_PAINT). This file only draws the list.
  void MAX_PAINT;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  }

  function draw(view, dt) {
    frameDt = dt > 0 && dt < 1 ? dt : 1 / 60;
    const v = view || {};
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.clearRect(0, 0, cssW, cssH);
    if (v.map) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, cssW, cssH);
    }

    const map = v.map;
    const fitted = fitMap(map, cssW, cssH, cameraFocus(v));
    if (fitted) {
      const eye = sightEye(v);
      ctx.save();
      ctx.setTransform(fitted.scale * dpr, 0, 0, fitted.scale * dpr, fitted.offsetX * dpr, fitted.offsetY * dpr);
      drawWorld(ctx, v, map, fitted.scale, eye);
      ctx.restore();
      drawNicks(ctx, v.players, fitted, map, eye);
    }

    drawHud(ctx, v.hud);
    drawDeathFlash(ctx, cssW, cssH);
  }

  window.addEventListener('resize', resize);
  resize();

  return { draw, resize, flashDeath: noteDeathFlash };
}

function drawDeathFlash(ctx, cssW, cssH) {
  if (deathFx.left <= 0) return;
  const alpha = 0.45 * (deathFx.left / DEATH_FLASH);
  deathFx.left = Math.max(0, deathFx.left - frameDt);
  ctx.save();
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.fillStyle = 'rgba(226, 61, 61, ' + alpha.toFixed(3) + ')';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.restore();
}

function fitMap(map, cssW, cssH, focus) {
  if (!map || !(map.width > 0) || !(map.height > 0)) return null;
  const availW = Math.max(1, cssW - MARGIN * 2);
  const availH = Math.max(1, cssH - MARGIN * 2);
  const base = Math.min(availW / map.width, availH / map.height);
  const mul = ZOOM_MUL[clampZoom(cam.zoom) - 1] || 1;
  const scale = base * mul;
  if (!(scale > 0)) return null;
  const viewW = cssW / scale;
  const viewH = cssH / scale;
  let cx = map.width / 2;
  let cy = map.height / 2;
  if (focus && Number.isFinite(focus.x) && Number.isFinite(focus.y)) {
    cx = focus.x;
    cy = focus.y;
  }
  if (!cam.ready) {
    cam.x = cx;
    cam.y = cy;
    cam.ready = true;
  } else {
    const follow = 1 - Math.exp(-CAM_FOLLOW_K * frameDt);
    cam.x += (cx - cam.x) * follow;
    cam.y += (cy - cam.y) * follow;
  }
  if (deathFx.left > 0) {
    const kick = 7 * (deathFx.left / DEATH_FLASH);
    cx += deathFx.kickX * kick;
    cy += deathFx.kickY * kick;
  }
  let left = cam.x - viewW / 2;
  let top = cam.y - viewH / 2;
  const slackX = map.width - viewW;
  const slackY = map.height - viewH;
  if (slackX <= 0) left = slackX / 2;
  else left = Math.min(Math.max(0, left), slackX);
  if (slackY <= 0) top = slackY / 2;
  else top = Math.min(Math.max(0, top), slackY);
  return {
    scale,
    offsetX: -left * scale,
    offsetY: -top * scale,
  };
}

function cameraFocus(view) {
  const players = (view && view.players) || [];
  if (view && view.selfId != null) {
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player && player.id === view.selfId && Number.isFinite(player.x) && Number.isFinite(player.y)) {
        return player;
      }
    }
  }
  return null;
}

function sightEye(view) {
  if (!view || view.los === false || view.selfId == null) return null;
  const players = view.players || [];
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player && player.id === view.selfId && Number.isFinite(player.x) && Number.isFinite(player.y)) {
      return player;
    }
  }
  return null;
}

function hiddenFrom(map, eye, x, y, radius) {
  if (!eye) return false;
  return discHidden(map, eye.x, eye.y, x, y, radius);
}

// Paint LOS is visual only and stored on the spot, so shift/filter cannot desync it.
// Players and bullets stay per frame.
const PAINT_LOS_EVERY = 3;
let paintLosFrame = 0;

function syncPaintLos(map, eye, paint) {
  paintLosFrame += 1;
  const refresh = (paintLosFrame % PAINT_LOS_EVERY) === 0;
  for (let i = 0; i < paint.length; i++) {
    const spot = paint[i];
    if (!spot) continue;
    if (!refresh && spot._los != null) continue;
    spot._los = !!(eye && hiddenFrom(map, eye, spot.x, spot.y, PAINT_RADIUS));
  }
}

function drawWorld(ctx, view, map, scale, eye) {
  ctx.fillStyle = COLOR.floor;
  ctx.fillRect(0, 0, map.width, map.height);

  const paint = view.paint || [];
  syncPaintLos(map, eye, paint);
  ctx.save();
  for (let i = 0; i < paint.length; i++) {
    const spot = paint[i];
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) continue;
    if (spot._los) continue;
    const alpha = spot.alpha == null ? 1 : spot.alpha;
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = teamColor(spot.team);
    fillCircle(ctx, spot.x, spot.y, PAINT_RADIUS);
  }
  ctx.restore();

  ctx.strokeStyle = COLOR.wall;
  ctx.lineWidth = 8;
  ctx.lineCap = 'square';
  ctx.beginPath();
  strokeSegments(ctx, map.bounds);
  strokeSegments(ctx, map.segments);
  ctx.stroke();

  const discs = map.discs || [];
  ctx.fillStyle = PILLAR;
  for (let i = 0; i < discs.length; i++) {
    const disc = discs[i];
    if (!disc || !Number.isFinite(disc.x) || !Number.isFinite(disc.y)) continue;
    fillCircle(ctx, disc.x, disc.y, disc.radius || 0);
  }

  const bullets = view.bullets || [];
  for (let i = 0; i < bullets.length; i++) {
    const bullet = bullets[i];
    if (!bullet || !Number.isFinite(bullet.x) || !Number.isFinite(bullet.y)) continue;
    if (hiddenFrom(map, eye, bullet.x, bullet.y, BULLET_RADIUS)) continue;
    ctx.fillStyle = teamColor(bullet.team);
    fillCircle(ctx, bullet.x, bullet.y, BULLET_RADIUS);
    const angle = Number.isFinite(bullet.angle) ? bullet.angle : 0;
    ctx.fillStyle = COLOR.bulletCore;
    fillCircle(
      ctx,
      bullet.x + Math.cos(angle) * 1.6,
      bullet.y + Math.sin(angle) * 1.6,
      1.4,
    );
  }

  const players = view.players || [];
  const blinkOff = Math.floor(performance.now() / BLINK_MS) % 2 === 1;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (eye && player && player.id !== eye.id && hiddenFrom(map, eye, player.x, player.y, PLAYER_RADIUS)) continue;
    drawPlayer(ctx, player, view.selfId, scale, blinkOff);
  }
}

function drawPlayer(ctx, player, selfId, scale, blinkOff) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return;
  const dead = player.alive === false;
  const color = dead ? COLOR.dead : teamColor(player.team);
  const faint = player.invuln > 0 && blinkOff;

  ctx.save();
  ctx.globalAlpha = faint ? FAINT : 1;
  ctx.fillStyle = color;
  fillCircle(ctx, player.x, player.y, PLAYER_RADIUS);
  if (!dead) {
    const face = facingOf(player);
    drawMarker(ctx, player.x, player.y, face.fx, face.fy, reloadProgress(player));
  }
  ctx.restore();

  if (selfId != null && player.id === selfId) {
    drawSelfRing(ctx, player, scale, color);
  }
}

function drawSelfRing(ctx, player, scale, color) {
  const radius = PLAYER_RADIUS + 2 / scale;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5 / scale;
  ctx.beginPath();
  ctx.arc(player.x, player.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  const done = reloadProgress(player);
  if (done <= 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5 / scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(player.x, player.y, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, done));
  ctx.stroke();
}

function drawNicks(ctx, players, fitted, map, eye) {
  if (!Array.isArray(players)) return;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.text;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (!player || !player.nick || !Number.isFinite(player.x) || !Number.isFinite(player.y)) continue;
    if (eye && player.id !== eye.id && hiddenFrom(map, eye, player.x, player.y, PLAYER_RADIUS)) continue;
    const x = fitted.offsetX + player.x * fitted.scale;
    const y = fitted.offsetY + (player.y + PLAYER_RADIUS) * fitted.scale + 3;
    ctx.fillText(String(player.nick), x, y);
  }
}

function drawHud(ctx, hud) {
  if (!hud || hud.phase === 'waiting' || !hud.phase) return;
  const score = hud.score || {};
  const red = score.red == null ? 0 : score.red;
  const blue = score.blue == null ? 0 : score.blue;

  ctx.save();
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.text;

  let y = 16;
  const x = 16;
  const line = 22;
  ctx.fillText(t('hudRed') + ' ' + red + ' : ' + blue + ' ' + t('hudBlue') + '    ' + timerLabel(hud), x, y);
  y += line;

  if (Array.isArray(hud.roster) && hud.roster.length) {
    let rx = x;
    for (let i = 0; i < hud.roster.length; i++) {
      const member = hud.roster[i];
      if (!member) continue;
      const nick = member.nick == null ? '' : String(member.nick);
      ctx.fillStyle = teamColor(member.team);
      ctx.fillText(nick, rx, y);
      rx += ctx.measureText(nick).width + 14;
    }
    ctx.fillStyle = COLOR.text;
    y += line;
  }

  if (hud.message) {
    ctx.fillText(String(hud.message), x, y);
    y += line;
  }

  if (hud.roomCode) {
    const transport = hud.transport ? '  ' + hud.transport : '';
    ctx.fillText(t('roomHud', { code: hud.roomCode }) + transport, x, y);
    y += line;
  }
  ctx.fillText('zoom ' + cam.zoom, x, y);

  ctx.restore();
  drawAmmo(ctx, hud.ammo);
}

function drawAmmo(ctx, ammo) {
  if (!ammo) return;
  const count = ammo.ammo == null ? 0 : ammo.ammo;
  const max = ammo.max > 0 ? ammo.max : 50;
  const reloading = !!ammo.reloading;
  const duration = Number(ammo.reloadDuration) || 0;
  const left = Math.max(0, Number(ammo.reloadLeft) || 0);
  const progress = reloading && duration > 0 ? 1 - left / duration : count / max;
  const blink = reloading && Math.floor(performance.now() / BLINK_MS) % 2 === 1;

  const w = 148;
  const h = 36;
  const x = 16;
  const y = ctx.canvas.height / (window.devicePixelRatio || 1) - h - 16;

  ctx.save();
  ctx.fillStyle = 'rgba(16, 18, 20, 0.72)';
  ctx.fillRect(x, y, w, h);

  ctx.fillStyle = blink ? 'rgba(226, 61, 61, 0.35)' : 'rgba(255,255,255,0.16)';
  ctx.fillRect(x + 8, y + 22, w - 16, 6);
  ctx.fillStyle = reloading ? '#f2c14e' : COLOR.text;
  ctx.fillRect(x + 8, y + 22, Math.max(0, Math.min(1, progress)) * (w - 16), 6);

  ctx.font = '13px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = COLOR.text;
  const label = reloading
    ? t('reloading', { time: left.toFixed(1) })
    : t('balls', { count, max });
  ctx.fillText(label, x + 8, y + 4);
  ctx.restore();
}
