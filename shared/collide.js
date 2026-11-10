export function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((px - x1) * dx + (py - y1) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  return { x: x1 + t * dx, y: y1 + t * dy, t };
}

export function resolveDiscSegment(disc, seg) {
  const closest = closestPointOnSegment(disc.x, disc.y, seg.x1, seg.y1, seg.x2, seg.y2);
  const dx = disc.x - closest.x;
  const dy = disc.y - closest.y;
  const dist2 = dx * dx + dy * dy;
  const r = disc.r;
  if (!(dist2 < r * r)) return null;

  const dist = Math.sqrt(dist2);
  let nx;
  let ny;
  if (dist > 0) {
    nx = dx / dist;
    ny = dy / dist;
  } else {
    const sx = seg.x2 - seg.x1;
    const sy = seg.y2 - seg.y1;
    const slen = Math.hypot(sx, sy);
    if (slen > 0) {
      nx = -sy / slen;
      ny = sx / slen;
    } else {
      nx = 1;
      ny = 0;
    }
  }

  const pen = r - dist;
  disc.x += nx * pen;
  disc.y += ny * pen;

  const vn = disc.vx * nx + disc.vy * ny;
  if (vn < 0) {
    disc.vx -= vn * nx;
    disc.vy -= vn * ny;
  }

  return { nx, ny, px: closest.x, py: closest.y };
}

export function resolveDiscDisc(a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (!(dist < minDist)) return false;

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

  const overlap = minDist - dist;
  const half = overlap * 0.5;
  a.x -= nx * half;
  a.y -= ny * half;
  b.x += nx * half;
  b.y += ny * half;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    const impulse = vn * 0.5;
    a.vx += impulse * nx;
    a.vy += impulse * ny;
    b.vx -= impulse * nx;
    b.vy -= impulse * ny;
  }

  return true;
}

export function hitsCircle(x, y, r, cx, cy, cr) {
  const dx = x - cx;
  const dy = y - cy;
  const rad = r + cr;
  return dx * dx + dy * dy <= rad * rad;
}

export function segmentIntersection(x1, y1, x2, y2, x3, y3, x4, y4) {
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

// A disc of radius r is hidden only when every sightline from the eye to it
// hits a wall or a pillar before the disc. A single clear tangent means a sliver shows.
export function discHidden(map, eyeX, eyeY, x, y, r) {
  if (!map || !Number.isFinite(eyeX) || !Number.isFinite(eyeY)) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const radius = r > 0 ? r : 0;
  const dx = x - eyeX;
  const dy = y - eyeY;
  const dist = Math.hypot(dx, dy);
  if (dist <= radius + 1e-6) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const px = -ny;
  const py = nx;
  const along = (radius * radius) / dist;
  const side = radius * Math.sqrt(dist * dist - radius * radius) / dist;
  const tx = x - nx * along;
  const ty = y - ny * along;

  const walls = wallsOf(map);
  const pillars = map.discs || [];
  const rays = [
    { x, y },
    { x: tx + px * side, y: ty + py * side },
    { x: tx - px * side, y: ty - py * side },
  ];
  for (let i = 0; i < rays.length; i++) {
    if (!rayBlocked(eyeX, eyeY, rays[i].x, rays[i].y, walls, pillars)) return false;
  }
  return true;
}

// Built once per map object. discHidden runs for every player, bullet and paint
// spot, so bounds.concat(segments) on each call was a per-frame allocation.
const wallCache = new WeakMap();

function wallsOf(map) {
  const bounds = map.bounds || [];
  const segments = map.segments || [];
  let walls = wallCache.get(bounds);
  if (walls && wallCache.get(segments) === walls) return walls;
  walls = new Array(bounds.length + segments.length);
  for (let i = 0; i < bounds.length; i++) walls[i] = bounds[i];
  for (let i = 0; i < segments.length; i++) walls[bounds.length + i] = segments[i];
  wallCache.set(bounds, walls);
  wallCache.set(segments, walls);
  return walls;
}

function rayBlocked(eyeX, eyeY, x, y, walls, pillars) {
  for (let i = 0; i < walls.length; i++) {
    const wall = walls[i];
    if (!wall) continue;
    const hit = segmentIntersection(eyeX, eyeY, x, y, wall.x1, wall.y1, wall.x2, wall.y2);
    if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6) return true;
  }
  for (let i = 0; i < pillars.length; i++) {
    const pillar = pillars[i];
    if (!pillar) continue;
    // Inflate slightly so a ray that skims the drawn disc still counts as blocked.
    // A zero-width ray against the exact radius misses on float error and flickers.
    const t = rayCircleT(eyeX, eyeY, x, y, pillar.x, pillar.y, (pillar.radius || 0) + 0.75);
    if (t != null && t > 1e-6 && t < 1 - 1e-6) return true;
  }
  return false;
}

function rayCircleT(x1, y1, x2, y2, cx, cy, r) {
  if (!(r > 0)) return null;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const fx = x1 - cx;
  const fy = y1 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  // Near-tangents go slightly negative from float error and would be treated as a miss.
  const disc = b * b - 4 * a * c;
  if (disc < -1e-6 * a) return null;
  const root = Math.sqrt(Math.max(0, disc));
  const t0 = (-b - root) / (2 * a);
  if (t0 > 0 && t0 < 1) return t0;
  const t1 = (-b + root) / (2 * a);
  if (t1 > 0 && t1 < 1) return t1;
  return null;
}
