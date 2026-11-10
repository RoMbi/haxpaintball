import { TEAM_RED, TEAM_BLUE, TEAM_SPEC } from './constants.js';
import { addPlayer, removePlayer, canStart, start } from './sim.js';

// Shared match-state rules for the browser host and the server host.
// Callers own sockets, the lobby DOM, and when a snapshot is sent.

export function phaseOpen(phase) {
  return phase === 'waiting' || phase === 'match_end';
}

export function rosterOpen(match) {
  return !!match && phaseOpen(match.phase);
}

export function isPlayingSide(team) {
  return team === TEAM_RED || team === TEAM_BLUE;
}

export function dropDisc(player) {
  player.alive = false;
  player.mask = 0;
  player.vx = 0;
  player.vy = 0;
}

// One roster entry: { id, nick, team }. Specs are not discs.
// Open (waiting / match_end): team change is remove+add, nick updates in place,
// a player who left is removed. Mid-round: the disc stays until the round ends
// or the player leaves; leave drops it dead. Never remove+add during a round
// (that respawns with invuln).
export function syncRoster(match, roster) {
  if (!match) return;
  const open = rosterOpen(match);
  const live = new Set();
  for (const entry of roster) {
    if (!entry || !isPlayingSide(entry.team)) continue;
    live.add(entry.id);
    if (!open) continue;
    const disc = match.players.find((player) => player.id === entry.id);
    if (!disc) {
      addPlayer(match, { id: entry.id, nick: entry.nick, team: entry.team });
      continue;
    }
    if (disc.team !== entry.team) {
      removePlayer(match, entry.id);
      addPlayer(match, { id: entry.id, nick: entry.nick, team: entry.team });
    } else {
      disc.nick = entry.nick;
    }
  }
  for (const player of match.players.slice()) {
    if (live.has(player.id)) continue;
    if (open) removePlayer(match, player.id);
    else dropDisc(player);
  }
}

// Between rounds a departed disc is gone. During the round it stays dead.
export function releaseDeparted(match, roster) {
  if (!match || match.phase !== 'round_end') return;
  const live = new Set();
  for (const entry of roster) {
    if (entry && isPlayingSide(entry.team)) live.add(entry.id);
  }
  for (const player of match.players.slice()) {
    if (!live.has(player.id)) removePlayer(match, player.id);
  }
}

// Start only from an explicit Graj / START. Never from the SHOOT bit.
// Paused resumes. Otherwise both sides must already be on the field.
export function tryStart(match) {
  if (!match) return false;
  if (match.phase === 'paused') return start(match);
  if (!canStart(match)) return false;
  return start(match);
}

export function applyRules(match, rules) {
  if (!match || !phaseOpen(match.phase)) return false;
  match.rules = rules;
  match.timeLeft = rules.roundTime;
  return true;
}

export { TEAM_SPEC };
