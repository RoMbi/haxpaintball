// Phase 0 counters. Read-only. No physics, net, or render changes.
//
// Hot path (note) only writes into preallocated slots. Sorting, strings, and
// the HUD node are created once per report (~1 s), never per frame.

const REPORT_MS = 1000;
const HARD_SNAP_PX = 8;
const FRAME_CAP = 240;
const DRAW_CAP = 240;
const STEPS_CAP = 64;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return sum / values.length;
}

export function createClientMetrics() {
  const frames = new Float64Array(FRAME_CAP);
  const draws = new Float64Array(DRAW_CAP);
  const steps = new Uint8Array(STEPS_CAP);
  let frameCount = 0;
  let drawCount = 0;
  let stepCount = 0;
  let frameWrite = 0;
  let drawWrite = 0;
  let stepWrite = 0;
  let hardSnaps = 0;
  let reconcileChecks = 0;
  let maxSnapPx = 0;
  let maxAhead = 0;
  let reconcilePhase = '';
  let reconcileAlive = '';
  let reconcileWhere = '';
  let reconcileTick = 0;
  let reconcileInvuln = 0;
  let snapAgeMs = 0;
  let snapBuffer = 0;
  let hasSnap = false;
  let lastReport = 0;
  let hud = null;

  function pushFrame(ms) {
    frames[frameWrite] = ms;
    frameWrite += 1;
    if (frameWrite === FRAME_CAP) frameWrite = 0;
    if (frameCount < FRAME_CAP) frameCount += 1;
  }

  function pushDraw(ms) {
    draws[drawWrite] = ms;
    drawWrite += 1;
    if (drawWrite === DRAW_CAP) drawWrite = 0;
    if (drawCount < DRAW_CAP) drawCount += 1;
  }

  function pushSteps(n) {
    const clamped = n > 255 ? 255 : n;
    steps[stepWrite] = clamped;
    stepWrite += 1;
    if (stepWrite === STEPS_CAP) stepWrite = 0;
    if (stepCount < STEPS_CAP) stepCount += 1;
  }

  function copySorted(buffer, count, write) {
    const out = new Array(count);
    const start = count === buffer.length ? write : 0;
    for (let i = 0; i < count; i += 1) out[i] = buffer[(start + i) % buffer.length];
    out.sort((a, b) => a - b);
    return out;
  }

  function line() {
    const frameSorted = copySorted(frames, frameCount, frameWrite);
    const drawSorted = copySorted(draws, drawCount, drawWrite);
    const stepValues = copySorted(steps, stepCount, stepWrite);
    const frameP95 = percentile(frameSorted, 0.95);
    const drawP95 = percentile(drawSorted, 0.95);
    const age = hasSnap ? Math.round(snapAgeMs) : -1;
    return [
      '[hax metrics]',
      'frame',
      mean(frameSorted).toFixed(2) + 'ms',
      'p95',
      frameP95.toFixed(2) + 'ms',
      frameP95 < 8 ? 'ok' : 'slow',
      '| draw p95',
      drawP95.toFixed(2) + 'ms',
      '| steps/frame',
      mean(stepValues).toFixed(2),
      '| snap age',
      age < 0 ? 'n/a' : age + 'ms',
      '| snap buf',
      String(snapBuffer),
      '| reconcile >8px',
      hardSnaps + '/' + reconcileChecks,
      hardSnaps ? 'HARD' : 'ok',
      '| max jump',
      maxSnapPx.toFixed(1) + 'px',
      '| ahead',
      String(maxAhead),
      '| at',
      reconcileWhere || '-',
      reconcilePhase || '-',
      reconcileAlive || '-',
      't' + reconcileTick,
      'inv' + reconcileInvuln.toFixed(1),
    ].join(' ');
  }

  function paintHud(text) {
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'metrics';
      hud.setAttribute('aria-hidden', 'true');
      const style = hud.style;
      style.position = 'fixed';
      style.left = '8px';
      style.bottom = '8px';
      style.zIndex = '4';
      style.maxWidth = 'calc(100% - 16px)';
      style.padding = '4px 6px';
      style.font = '11px/1.3 ui-monospace, monospace';
      style.color = '#c9d2dc';
      style.background = 'rgba(7, 8, 12, 0.72)';
      style.pointerEvents = 'none';
      style.whiteSpace = 'pre-wrap';
      document.body.appendChild(hud);
    }
    hud.textContent = text;
  }

  return {
    note(sample) {
      if (!sample) return;
      pushFrame(sample.frameMs);
      pushDraw(sample.drawMs);
      pushSteps(sample.steps | 0);
      if (sample.hasSnap) {
        snapAgeMs = sample.snapAgeMs;
        hasSnap = true;
      }
      if (sample.snapBuffer != null) snapBuffer = sample.snapBuffer | 0;
    },

    // Distance in px of a predicted-vs-replay correction. Counts jumps over 8 px.
    // detail is only stored for the worst jump in the report window.
    noteReconcile(px, detail) {
      if (!Number.isFinite(px)) return;
      reconcileChecks += 1;
      if (px > maxSnapPx) {
        maxSnapPx = px;
        const info = detail || {};
        maxAhead = info.ahead | 0;
        reconcilePhase = info.phase || '';
        reconcileAlive = info.alive || '';
        reconcileWhere = info.where || '';
        reconcileTick = info.tick | 0;
        reconcileInvuln = Number(info.invuln) || 0;
      }
      if (px > HARD_SNAP_PX) hardSnaps += 1;
    },

    // Call once per frame. Logs and paints HUD about once a second.
    maybeReport(nowMs) {
      if (!frameCount) return;
      if (!lastReport) lastReport = nowMs;
      if (nowMs - lastReport < REPORT_MS) return;
      lastReport = nowMs;
      const text = line();
      console.info(text);
      paintHud(text);
      hardSnaps = 0;
      reconcileChecks = 0;
      maxSnapPx = 0;
      maxAhead = 0;
      reconcilePhase = '';
      reconcileAlive = '';
      reconcileWhere = '';
      reconcileTick = 0;
      reconcileInvuln = 0;
    },
  };
}
