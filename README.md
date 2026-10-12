# Paper 26.2 Test-Bot Manager

A small, web-managed tool for putting **Minecraft test bots** on a
**PaperMC 26.2 offline-mode** server. Create bots with random names, watch
in-game chat and system messages, broadcast chat, run commands, and let bots
accept (or decline) server resource packs.

Inspired by <https://github.com/crpmax/mc-bots>.

> **What it is not:** a gameplay bot. It joins, chats, runs commands and
> reports what the server says. It does not move, mine or fight.

---

## Features

- **Add bots on demand** — create one or many at once, with random realistic
  names or a shared prefix.
- **See and send chat** — per-bot incoming chat/system messages, broadcast chat
  as all or selected bots.
- **Run commands** — send `/` commands as all or selected bots (a leading `/`
  is added for you).
- **Resource-pack control** — accept server resource packs by default, or
  decline them; a decline never hangs or crashes a bot.
- **Live dashboard** — a no-build static UI plus a WebSocket feed of every
  event (`chat`, `system`, `bot_state`, `log`).
- **Auto-respawn** — a kicked/disconnected bot reconnects automatically unless
  you removed it.
- **Settings persist** to `config.json` and are honoured on the next connect.

---

## Requirements

| Requirement | Notes |
| ----------- | ----- |
| **Node.js 20+** (24 recommended) | tested on Node 24 / npm 11 |
| **Java 25** | only to run the bundled Paper server. The system `java` is usually 17 and will **not** run Paper 26.2 — use `/usr/lib/jvm/java-25-openjdk-amd64/bin/java`. |
| **A PaperMC 26.2 server** | offline mode (`online-mode=false`). The repo can download one for you. |

---

## Quickstart (clone → running app → connected bots)

```bash
# 1. get the code
git clone <this-repo> mc-testbot-manager
cd mc-testbot-manager

# 2. install — also runs the 26.2 compat layer via `postinstall`
npm install

# 3. start the manager (API + dashboard) on http://127.0.0.1:3000
npm start

# 4. in a second terminal, start a Paper 26.2 server in offline mode
#    (downloads the jar on first run, listens on 127.0.0.1:25577)
./scripts/paper-server.sh

# 5. open http://127.0.0.1:3000, set the target host/port in Settings,
#    then click "Add bots". Watch them appear as `spawned`.
```

Prefer the API? From a third terminal:

```bash
curl -s -X POST http://127.0.0.1:3000/api/bots \
  -H 'content-type: application/json' \
  -d '{"count":5,"randomNames":true}'
curl -s -X POST http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"hello from the bots"}'
```

That is the whole loop. For a reproducible end-to-end verification (including
the raw `npm run smoke` transcript), see [`docs/VERIFY.md`](docs/VERIFY.md).

---

## Install

```bash
npm install
```

`npm install` runs `scripts/apply-compat.js` as a `postinstall` step. It adds
Minecraft **26.2** support, which the released npm packages
(`mineflayer@4.39.0`, `minecraft-data@3.117.0`, …) do not ship yet. See
[The 26.2 compat layer](#the-262-compat-layer).

Re-run it any time (idempotent):

```bash
npm run compat
```

Set `MC_VERSION` to target a different version (default `26.2`).

---

## Run

```bash
npm start            # dashboard + API on http://127.0.0.1:3000
```

Bundle the Paper server (offline, port 25577):

```bash
./scripts/paper-server.sh
```

Environment overrides:

| Variable | Default | Effect |
| -------- | ------- | ------ |
| `API_HOST` | `127.0.0.1` | dashboard/API bind address |
| `API_PORT` / `PORT` | `3000` | dashboard/API port |
| `PAPER_PORT` | `25577` | port `paper-server.sh` listens on |
| `PAPER_DIR` | `<repo>/.paper-server` | server data directory |
| `JAVA_BIN` | `/usr/lib/jvm/java-25-openjdk-amd64/bin/java` | Java used to run Paper |
| `MC_VERSION` | `26.2` | protocol version bots request |

---

## Connect to a PaperMC 26.2 offline server

Bots authenticate **offline** (`auth: 'offline'`), so the target server must
run with `online-mode=false`. In the server's `server.properties`:

```properties
online-mode=false
server-port=25577
```

The bundled `scripts/paper-server.sh` writes exactly this (plus `eula=true`)
for you. If you already run a server, just set `online-mode=false` and point the
manager's **Settings → host / port** at it (defaults `127.0.0.1:25577`).

> An `online-mode=true` server will reject the bots — it expects Mojang session
> auth, which offline bots do not have.

---

## Configure

All settings live in `config.json` in the project root and are exposed through
`GET/PUT /api/settings` and the dashboard's **Settings** panel.

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | target server host |
| `port` | `25577` | target server port |
| `version` | `26.2` | Minecraft protocol version |
| `acceptResourcePack` | `true` | accept server resource packs |
| `nicknamePrefix` | `PaperBot` | prefix for generated names (prefix mode) |
| `nicknameMode` | `random` | `random`/`realistic` names, `prefix`, or `custom` |
| `connectDelayMin` | `300` | min ms between bot logins |
| `connectDelayMax` | `1500` | max ms between bot logins |

Example:

```bash
curl -s -X PUT http://127.0.0.1:3000/api/settings \
  -H 'content-type: application/json' \
  -d '{"host":"127.0.0.1","port":25577,"version":"26.2","acceptResourcePack":true}'
```

---

## Add more bots

**From the UI:** open the dashboard and use the **Add bots** control — choose a
count and click add.

**From the API:**

```bash
# 5 bots with random realistic names (default)
curl -s -X POST http://127.0.0.1:3000/api/bots \
  -H 'content-type: application/json' -d '{"count":5}'

# explicit names
curl -s -X POST http://127.0.0.1:3000/api/bots \
  -H 'content-type: application/json' -d '{"count":2,"names":["Alfa","Bravo"]}'

# a shared prefix instead of random names
curl -s -X POST http://127.0.0.1:3000/api/bots \
  -H 'content-type: application/json' -d '{"count":3,"prefix":"TestBot_"}'
```

Notes:

- Each call creates up to **50** bots; logins are staggered across the
  configured `connectDelayMin`…`connectDelayMax` window so a large batch does
  not slam the server at once.
- Random names are drawn from a realistic first-name/last-name list and are kept
  unique across the current bot set and 3–16 chars long.
- Remove a bot with `DELETE /api/bots/:id`, or all of them with
  `POST /api/bots/disconnect-all`.

---

## Chat and commands

```bash
# chat as every connected bot
curl -s -X POST http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' -d '{"message":"hi everyone"}'

# chat as selected bots only
curl -s -X POST http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' -d '{"message":"hi","botIds":["bot-...","bot-..."]}'

# run a command (the leading "/" is optional)
curl -s -X POST http://127.0.0.1:3000/api/command \
  -H 'content-type: application/json' -d '{"command":"/help"}'
```

Incoming chat and system messages are streamed to the dashboard over
`WS /ws` and are also kept per bot (last 20 shown by `GET /api/bots`).
Commands that need operator permission (`/say`, `/kick`, …) will be refused
unless the bot is op; `/help` works for everyone.

---

## HTTP + WebSocket API

Base URL `http://127.0.0.1:3000` (override with `API_HOST` / `API_PORT`).

| Method | Path | Body / notes |
| --- | --- | --- |
| `GET` | `/api/status` | server version, settings, bot counts, uptime |
| `GET` | `/api/settings` | current settings |
| `PUT` | `/api/settings` | any settings key from the table above |
| `GET` | `/api/bots` | all bots with state |
| `POST` | `/api/bots` | `{count, names?, prefix?, randomNames?}` |
| `DELETE` | `/api/bots/:id` | disconnect one bot |
| `POST` | `/api/bots/disconnect-all` | disconnect every bot |
| `POST` | `/api/chat` | `{message, botIds?}` |
| `POST` | `/api/command` | `{command, botIds?}` |

`botIds` omitted/empty targets every connected bot. WebSocket endpoint:
`WS /ws`, emitting JSON events of type `chat`, `system`, `bot_state` or `log`.

---

## The 26.2 compat layer

**Why it exists.** Released `mineflayer@4.39.0` / `minecraft-data@3.117.0`
only ship protocol data up to Minecraft **26.1**. Minecraft 26.2 (protocol
**776**) is not in any released npm package, so an unpatched mineflayer cannot
even log in to a 26.2 server.

**What it does.** `scripts/apply-compat.js` runs on `postinstall` and applies,
idempotently:

1. Stage the vendored 26.2 data from `vendor/minecraft-data-26.2/`
   (offline; falls back to downloading the `PrismarineJS/minecraft-data`
   `pc_26_2` tarball) into `node_modules/minecraft-data`.
2. Regenerate `node_modules/minecraft-data/data.js`.
3. Add `'26.2'` to mineflayer's `testedVersions`.
4. Map `26.2 → pc/1.18/chunk` in `prismarine-chunk`.
5. Add `"26.2"` to every `prismarine-physics` feature range that lists `"26.1"`.
6. Fix mineflayer's resource-pack reply so the 26.2 configuration phase can
   finish (the released code passes a UUID object where a string is expected,
   so the server never completes configuration and the bot hangs).

**Removal path.** Delete the layer once 26.2 reaches the released npm packages:
bump `mineflayer`/`minecraft-data`/`minecraft-protocol`, delete `vendor/` and
`scripts/apply-compat.js`, drop the `compat`/`postinstall` entries in
`package.json`, and keep (or raise) the default `version`. Full detail and the
drop-in checklist are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#dropping-the-compat-layer).

---

## Verification

Two levels, both reproducible:

- **`npm run smoke`** — boots a real Paper 26.2 offline server, drives the bot
  engine and the REST API, and asserts the DoD behaviours. Last observed run:
  **20/20 checks passed** (see the full transcript in
  [`docs/VERIFY.md`](docs/VERIFY.md#observed-output)).
- **Manual end-to-end** — start the app + a Paper server, add bots from the UI,
  chat and run a command. Steps and expected output: [`docs/VERIFY.md`](docs/VERIFY.md#manual-end-to-end).

---

## Project layout

```
src/
  index.js          entry point (HTTP + WS, reads API_HOST/API_PORT)
  config.js         config.json load/save + defaults
  names.js          realistic random name generator
  bot-manager.js    mineflayer bot lifecycle, chat, commands, resource packs
  server.js         Express + ws REST/WS API
public/             static dashboard (HTML/CSS/JS, no build step)
scripts/
  apply-compat.js   Minecraft 26.2 compat patches (postinstall)
  paper-server.sh   download + run Paper 26.2 offline
  smoke.js          end-to-end test against a real Paper 26.2 server
vendor/
  minecraft-data-26.2/  vendored 26.2 protocol data (dataPaths.json + pc/26.2)
docs/
  ARCHITECTURE.md   components, version/compat strategy, removal path
  VERIFY.md         exact run/verify steps + observed output
SPIKE-26.2.md       the original 26.2 feasibility spike notes
```

## Limitations

- **Offline mode only.** Bots use `auth: 'offline'`; they cannot join an
  `online-mode=true` server.
- **One shared target.** `host`/`port`/`version` are global settings; all bots
  talk to the same server.
- **26.2 needs the compat layer.** Until upstream ships 26.2, `npm install`
  must run the postinstall patch; a bare `npm ci --ignore-scripts` will leave
  bots unable to connect.
- **Emulated servers can't verify 26.2.** The released `minecraft-protocol`
  server code cannot write the new 26.2 `sessionId` field, so always test
  against a real Paper server (as `npm run smoke` does).
- **Resource packs in the configuration phase are auto-answered** by the
  protocol layer regardless of `acceptResourcePack`; the setting applies to
  packs offered later, in the play state.
- **Bots are in-memory.** Restarting the app clears the bot list; only settings
  persist (`config.json`).
- **No API auth/TLS.** The API and dashboard bind to `127.0.0.1` and are meant
  for local testing; do not expose them.
- **Non-op by default.** Commands needing operator permission are refused until
  the bot is op.

## Notes

- Bots request `version: '26.2'`; override with `MC_VERSION` or the `version`
  setting.
- `/say` / `/kick` require operator permission; from the server console they
  work without op. `/help` works for every player.
- Background: [`SPIKE-26.2.md`](SPIKE-26.2.md) records the verified 26.2
  feasibility results and the exact patches.
