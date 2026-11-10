export const DT = 1 / 60;
export const PLAYER_RADIUS = 15;
// Marker grip, matching drawMarker. Canvas Y grows down, so right is (-fy, fx).
export const MARKER_ALONG = 0.42;
export const MARKER_RIGHT = 0.62;
export const MARKER_TIP = 13.4;
export const PLAYER_ACCEL = 900; // plan started at 280, but 280/friction never reaches max speed
export const PLAYER_FRICTION = 3.2; // exponential decay rate: vel *= exp(-FRICTION * dt)
export const PLAYER_RELEASE_FRICTION = 8; // coast after release; shorter than the original 3.2 slide
export const PLAYER_MAX_SPEED = 230;
// 90° in 150 ms. Facing and acceleration both follow this, not the raw keys.
export const PLAYER_TURN_RATE = (Math.PI / 2) / 0.15;
export const BULLET_RADIUS = 4;
export const BULLET_SPEED = 640;
export const BULLET_INHERIT = 0.35;
export const BULLET_LIFE = 1;
export const BULLET_COOLDOWN = 0.35; // held trigger, old kick-like rate
export const BULLET_TAP_RATE = 1 / 14; // floor so a tap can still outrun a hold
export const BULLET_SPREAD = 2.0 * Math.PI / 180; // max hook, degrees stepped by 0.1
export const BULLET_SPREAD_STEP = 0.1 * Math.PI / 180;
export const BULLET_SPIN = 3.4; // rad/s, visual tumble only, starts at mid-flight
export const BULLET_IGNORE = 0.05;
export const SPAWN_INVULN = 1;
export const ROUND_TIME = 180;
export const ROUND_TIME_MIN = 60;
export const ROUND_TIME_MAX = 600;
export const ROUND_END_PAUSE = 2.5;
export const WINS_NEEDED = 5;
export const WINS_MIN = 1;
export const WINS_MAX = 20;
export const MAG_SIZE = 50;
export const RELOAD_EMPTY = 5; // full hopper, 1 s per 10 balls
export const MAX_PAINT = 80;
export const SNAPSHOT_EVERY = 2; // host sends snapshot every N ticks (30 Hz)
export const KEY = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, SHOOT: 16, SHIFT: 32, RELOAD: 64 };
export const TEAM_RED = 'red';
export const TEAM_BLUE = 'blue';
export const TEAM_SPEC = 'spec';
export const COLOR = {
  floor: '#243028',
  wall: '#d7dde2',
  red: '#e23d3d',
  blue: '#3d7de2',
  nose: '#ffffff',
  dead: '#666666',
  text: '#f2f2f2',
  bulletCore: '#ffffff',
};
