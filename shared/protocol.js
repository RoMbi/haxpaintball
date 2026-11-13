export const ClientMsg = {
  CREATE: 'create',
  JOIN: 'join',
  SIGNAL: 'signal',
  RELAY: 'relay',
  LEAVE: 'leave',
  TEAM: 'team',
  SHUFFLE: 'shuffle',
  MAP: 'map',
  START: 'start',
  RULES: 'rules',
  INPUT: 'input',
};
export const ServerMsg = {
  CREATED: 'created',
  JOINED: 'joined',
  ROSTER: 'roster',
  SIGNAL: 'signal',
  RELAY: 'relay',
  CLOSED: 'closed',
  ERROR: 'error',
  SNAPSHOT: 'snapshot',
};
// input may include ack (last painted event) and shot (last shot edge, resent until shotAck).
export const GameMsg = { INPUT: 'input', SNAPSHOT: 'snapshot' };
export function encode(obj) { return JSON.stringify(obj); }
export function decode(raw) {
  if (typeof raw !== 'string') raw = raw.toString();
  return JSON.parse(raw);
}
