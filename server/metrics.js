// Phase 0 tick counters. Read-only. Does not change the tick interval,
// snapshot payload, input handling, or relay.

const REPORT_MS = 5000;
const INTERVAL_CAP = 512;
const TICK_LO = 15;
const TICK_HI = 18;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function createServerMetrics() {
  const intervals = new Float64Array(INTERVAL_CAP);
  let intervalCount = 0;
  let intervalWrite = 0;
  let catchupSteps = 0;
  let catchupCalls = 0;
  let snapBytes = 0;
  let snapCount = 0;
  let snapBytesMax = 0;
  let rooms = 0;
  let lastReport = 0;

  function windowFlag(p95) {
    if (!intervalCount) return 'n/a';
    if (p95 >= TICK_LO && p95 <= TICK_HI) return 'ok';
    if (p95 < TICK_LO) return 'fast';
    return 'slow';
  }

  return {
    // Actual gap between tickRooms calls, in ms. First call has no gap.
    noteTick(gapMs) {
      if (!Number.isFinite(gapMs) || gapMs < 0) return;
      intervals[intervalWrite] = gapMs;
      intervalWrite += 1;
      if (intervalWrite === INTERVAL_CAP) intervalWrite = 0;
      if (intervalCount < INTERVAL_CAP) intervalCount += 1;
    },

    // How many sim steps this tickRooms pass ran to catch up (0 is normal).
    noteCatchup(steps) {
      const n = steps | 0;
      if (n < 0) return;
      catchupSteps += n;
      catchupCalls += 1;
    },

    noteSnapshot(bytes) {
      const n = bytes | 0;
      if (n < 0) return;
      snapBytes += n;
      snapCount += 1;
      if (n > snapBytesMax) snapBytesMax = n;
    },

    noteRooms(count) {
      rooms = count | 0;
    },

    // Logs every few seconds. No-op on the ticks in between.
    maybeReport(nowMs) {
      if (!lastReport) {
        lastReport = nowMs;
        return;
      }
      if (nowMs - lastReport < REPORT_MS) return;
      const elapsed = nowMs - lastReport;
      lastReport = nowMs;

      const sorted = new Array(intervalCount);
      const start = intervalCount === INTERVAL_CAP ? intervalWrite : 0;
      let sum = 0;
      for (let i = 0; i < intervalCount; i += 1) {
        const value = intervals[(start + i) % INTERVAL_CAP];
        sorted[i] = value;
        sum += value;
      }
      sorted.sort((a, b) => a - b);
      const avg = intervalCount ? sum / intervalCount : 0;
      const p95 = percentile(sorted, 0.95);
      const snapAvg = snapCount ? Math.round(snapBytes / snapCount) : 0;

      console.log(
        '[hax metrics] tick avg ' + avg.toFixed(2) + 'ms'
        + ' p95 ' + p95.toFixed(2) + 'ms ' + windowFlag(p95)
        + ' | catch-up steps ' + catchupSteps + ' / ' + catchupCalls + ' calls'
        + ' | snap ' + snapAvg + ' B avg'
        + ' max ' + snapBytesMax + ' B'
        + ' n=' + snapCount
        + ' | rooms ' + rooms
        + ' | window ' + Math.round(elapsed) + 'ms',
      );

      intervalCount = 0;
      intervalWrite = 0;
      catchupSteps = 0;
      catchupCalls = 0;
      snapBytes = 0;
      snapCount = 0;
      snapBytesMax = 0;
    },
  };
}
