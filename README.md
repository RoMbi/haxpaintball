# HaxPaintball

Top-down paintball in the style of Haxball. You aim where you move. There is no mouse crosshair. One hit eliminates.

The server serves the page and the lobby. By default the host's browser runs the 60 Hz match, and guests send input and draw its snapshots. When creating a room you can hand the match to the server, so nobody has to keep a host tab open.

The lobby is in Polish by default. A language select in the top-right corner switches it to English. The choice is stored in `localStorage` under `haxpaintball.lang` and comes back after a refresh. Strings live in `client/i18n.js`. The server sends status and error codes. The client turns them into a sentence in the selected language.

Tunable numbers live in `shared/constants.js`. Do not copy them into the server or the client.

## Run

Node.js with ESM (`import`) and npm. No database, no accounts, no `.env`.

```bash
npm install
npm start
```

Open [http://localhost:8080](http://localhost:8080).

Another port:

```bash
PORT=3000 npm start
```

Do not open `client/index.html` through `file://`, and do not put a plain static server in front of it. Modules, maps, and the lobby WebSocket only work through `node server/index.js`.

## Container

Build and start in one step:

```bash
docker compose up --build
```

The image alone, without compose:

```bash
docker build -t haxpaintball .
docker run --rm -p 8080:8080 haxpaintball
```

The runtime image is `node:22` and starts `node server/index.js` as user `node`. Compose maps `${PORT:-8080}` to `8080` in the container. The process inside always listens on `8080`.

## How to play

1. Enter a nick (max 16 characters) and create a room.
2. Tick **Host na serwerze** / **Host on server** if the machine serving the page should run the match instead of your browser. Closing your tab then does not end the room.
3. Friends open the same URL and join with the room code (4 characters, no `I`, `O`, `0`, `1`). **Kopiuj** / **Copy** puts that code on the clipboard. On HTTPS and localhost it uses the async clipboard API. On plain HTTP, and when that API is rejected, it falls back to a temporary textarea and `document.execCommand('copy')`. The status line shows **Skopiowano kod** / **Code copied** only when the copy actually landed.
4. The host sets the map, teams, round time, and wins needed, then clicks **Graj** / **Play**.
5. A match starts only when both teams have at least one player.
6. Without that option, closing the host tab closes the room. Restarting the server drops every room. Nothing is saved.

Controls:

| Action | Keys |
|---|---|
| Move | WASD or arrows |
| Shoot | `X` or space |
| Reload | `Z` |
| Zoom | Page Up/Down, `+`/`-`, wheel, `1`-`5` |

A second player on the same keyboard uses IJKL, shoots with `U`, and reloads with `O`.

Teams are `red`, `blue`, and `spec`. A spectator does not enter the match. A room holds 8 people. Joiners start as spectators.

## Match

- Simulation step is 60 Hz. Snapshots during a match go out every 2 ticks (30 Hz).
- A player is a disc. Collisions are disc-disc and disc-segment. Players push each other. They do not overlap.
- Facing and acceleration follow the input at 90 degrees per 150 ms, not the raw keys. With no input, the last facing stays.
- A shot does not pass through walls and does not bounce. Friendly fire is off.
- One hit eliminates. After a spawn there is 1 s of invulnerability, and no shot in that time.
- Hopper holds 50. An empty reload takes 5 s. A partial reload is proportional.
- Default round is 180 s, match to 5 wins. The lobby offers 1-10 minutes and 1-20 wins. The code accepts 60-600 s and 1-20 wins.
- When time runs out, the team with more players alive wins. A tie is overtime until one side is gone.
- Paint is visual only. It does not affect physics.

## Layout

Three layers. Do not mix them.

| Layer | Role |
|---|---|
| `server/` | Static files, rooms, SDP/ICE, relay. It runs physics only for a room with the host on the server. |
| `client/` | Loop, lobby, rendering. In a normal room the host's browser is the match authority. |
| `shared/` | Constants, collisions, simulation, message names. The contract for host, guest, and server. |

- Physics and collisions stay in `shared/sim.js`. A guest predicts with the same code the authority runs, whether that authority is a browser or the server. Do not copy that loop a second time.
- A map is JSON: `bounds`, `segments`, `discs`, `spawns.red`, `spawns.blue`. Physics does not know the shape of a field.
- A new map needs three things: a file in `maps/`, an entry in `m- Code comments are in English, and only where they explain a tuning choice. Lobby copy is in `client/i18n.js`, Polish and English. The select is hidden during a match and returns with the Lobby button. Names such as `HaxPaintball`, `Nick`, `Red`, `Blue`, `Spec`, and room codes stay as they are. The `?metrics=1` HUD is not translated.protocol is JSON with a `t` field. Names are in `shared/protocol.js`. Do not send bare strings from the client.
- Input is the `KEY` bit mask from `shared/constants.js`.
- The server only serves `client`, `shared`, and `maps`. Paths with `..` are rejected.
- Code comments are in English, and only where they explain a tuning choice. Lobby copy is in Polish.
- There is no bundler, linter, or database. `npm start` is the deploy. `npm test` runs `shared/sim.test.js`.
