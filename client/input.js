import { KEY } from '../shared/constants.js';

export const MAP_WASD = {
  KeyW: KEY.UP,
  KeyA: KEY.LEFT,
  KeyS: KEY.DOWN,
  KeyD: KEY.RIGHT,
  ArrowUp: KEY.UP,
  ArrowLeft: KEY.LEFT,
  ArrowDown: KEY.DOWN,
  ArrowRight: KEY.RIGHT,
  KeyX: KEY.SHOOT,
  Space: KEY.SHOOT,
  KeyZ: KEY.RELOAD,
  ShiftLeft: KEY.SHIFT,
  ShiftRight: KEY.SHIFT,
};

export const MAP_IJKL = {
  KeyI: KEY.UP,
  KeyJ: KEY.LEFT,
  KeyK: KEY.DOWN,
  KeyL: KEY.RIGHT,
  KeyU: KEY.SHOOT,
  KeyO: KEY.RELOAD,
  ShiftLeft: KEY.SHIFT,
  ShiftRight: KEY.SHIFT,
};

const SCROLL_CODES = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function createInput(target, keymap) {
  const held = new Set();
  const map = keymap || {};
  let blocked = false;

  function onKeyDown(event) {
    const tag = event.target && event.target.tagName;
    const code = event.code;
    // Menu open, or a focused field: keys type, they do not steer.
    if (blocked || FIELD_TAGS.has(tag)) return;
    if (SCROLL_CODES.has(code)) event.preventDefault();
    if (event.repeat || !code || !Object.prototype.hasOwnProperty.call(map, code)) return;
    held.add(code);
  }

  function onKeyUp(event) {
    if (event.code) held.delete(event.code);
  }

  function clearHeld() {
    held.clear();
  }

  // Keyup is dropped when the tab blurs. A stuck bit would keep moving or shooting.
  const doc = target.document || null;
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', clearHeld);
  if (doc) doc.addEventListener('visibilitychange', clearHeld);

  function sample() {
    let mask = 0;
    for (const code of Object.keys(map)) {
      if (held.has(code)) mask |= map[code];
    }
    return mask;
  }

  function setBlocked(next) {
    blocked = !!next;
    if (blocked) held.clear();
  }

  function destroy() {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', clearHeld);
    if (doc) doc.removeEventListener('visibilitychange', clearHeld);
    held.clear();
  }

  return { sample, destroy, setBlocked };
}
