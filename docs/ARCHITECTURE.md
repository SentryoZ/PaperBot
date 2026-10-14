# Architecture

How the Paper 26.2 test-bot manager is put together, how it copes with a
Minecraft version the released ecosystem does not yet support, and how to drop
that compatibility layer later.

---

## 1. Components

```
                    ┌──────────────────────────┐
   browser  ───────▶│  public/  (dashboard UI)  │
   (WS /ws) ◀───────┤  index.html app.js styles │
                    └────────────┬─────────────┘
                                 │ REST + WebSocket
                    ┌────────────▼─────────────┐
                    │  src/server.js            │  Express + ws
                    │  REST routes, /ws fan-out │
                    └────────────┬─────────────┘
                          calls  │  events ('event')
                    ┌────────────▼─────────────┐
                    │  src/bot-manager.js       │  EventEmitter
                    │  create/chat/command/...  │  bot lifecycle
                    └───┬──────────┬────────────┘
             ┌──────────▼──┐  ┌────▼──────────┐
             │ src/names.js│  │ src/config.js │
             │ random names│  │ config.json   │
             └─────────────┘  └───────────────┘
                                 │ mineflayer
                    ┌────────────▼─────────────┐
                    │  mineflayer + patched     │
                    │  minecraft-data 26.2      │  ← scripts/apply-compat.js
                    └────────────┬─────────────┘
                                 │ Minecraft protocol 776
                    ┌────────────▼─────────────┐
                    │  PaperMC 26.2 (offline)   │  ← scripts/paper-server.sh
                    └──────────────────────────┘
```

### Engine — `src/bot-manager.js`

- Owns a `Map<id, entry>` of bots and the live `mineflayer` client for each.
- `createBots({count, names?, prefix?, randomNames?})` builds entries, assigns
  names (via `src/names.js` when random), then staggers each login across the
  `connectDelayMin`…`connectDelayMax` window with `setTimeout`.
- Control surface: `list()`, `get(id)`, `chat(message, botIds?)`,
  `command(command, botIds?)`, `disconnectBot(id)`, `disconnectAll()`,
  `shutdown()`.
- Emits a single `'event'` stream with payloads `{ ts, type, … }` where `type`
  is one of `chat`, `system`, `bot_state`, `log`.
- Uses offline auth (`auth: 'offline'`), which matches `online-mode=false`.
- Resource packs: observes the `resource_pack_send` packet and mineflayer's
  `resourcePack` event and accepts/declines per `acceptResourcePack`. Any
  failure is logged, never thrown, so a pack can't kill a connection.

### Configuration — `src/config.js`

- `ConfigStore` loads/saves `config.json`, merges over `DEFAULTS`, and
  `sanitize()`s every patch to the known settable keys with type coercion.
- Unknown keys are dropped; `GET/PUT /api/settings` operate on this store.
- `MC_VERSION` env var seeds the default `version`.

### Names — `src/names.js`

- `generateNames(count, taken)` draws from a first/last-name list, mixes three
  shapes (first, first+last, first+number), keeps results unique and 3–16
  chars, and avoids collisions with names already in use.

### API — `src/server.js`

- `createServer({config, manager, apiHost, apiPort})` mounts Express JSON +
  the static `public/` dashboard, all `/api/*` routes, a JSON 404 fallback, and
  a `WebSocketServer` on `/ws`.
- Every `manager` `'event'` is broadcast to all connected sockets.
- A new socket immediately receives a `status` snapshot (settings + bots).

### UI — `public/`

- Plain HTML/CSS/JS, no build step and no framework. Talks to the same REST +
  WS API a script would use; `npm start` serves it from `src/server.js`.

### Scripts — `scripts/`

| Script | Role |
| --- | --- |
| `apply-compat.js` | postinstall: patch node_modules for Minecraft 26.2 (see §2) |
| `paper-server.sh` | download + run Paper 26.2 offline with Java 25 |
| `smoke.js` | boot a real server and assert the DoD behaviours end-to-end |

---

## 2. Version / compat strategy

### The problem

Minecraft **26.2** speaks protocol **776**. The released npm ecosystem stops at
**26.1**:

| Package | Released | 26.2? |
| --- | --- | --- |
| `mineflayer` | 4.39.0 | no |
| `minecraft-data` | 3.117.0 | no (data ends at 26.1) |
| `minecraft-protocol` | 1.68.0 | no |

Without help, mineflayer refuses to connect to 26.2 (unknown version) or hangs
mid-configuration. The 26.2 protocol data does exist on the
`PrismarineJS/minecraft-data` branch `pc_26_2` (protocol 776, dataVersion
4903), but the npm wrapper package has no such branch, so `data.js` has to be
regenerated after vendoring.

### The approach: vendor + idempotent postinstall patch

`scripts/apply-compat.js` runs automatically after `npm install` (and via
`npm run compat`). It is idempotent — re-running is safe — and works offline
from a vendored slice:

1. **Stage data** — copy `vendor/minecraft-data-26.2/` (`dataPaths.json` + all
   vendored `pc/<version>/**` trees) into `node_modules/minecraft-data/…/data`.
   Besides `pc/26.2/**`, the upstream `dataPaths.json` references a few files
   the released package does not ship (`pc/26.1/proto.yml`,
   `pc/1.20.3/windows.json`), so those are vendored too. If the vendored slice
   is missing, fall back to downloading the `pc_26_2` tarball (cached in
   `.compat-cache/`).
2. **Regenerate** `node_modules/minecraft-data/data.js`
   (`bin/generate_data.js`) so the new version is resolvable.
3. **mineflayer versions** — append `'26.2'` to `lib/version.js`
   `testedVersions`.
4. **prismarine-chunk** — add `26.2 → ./pc/1.18/chunk` to the protocol map.
5. **prismarine-physics** — add `"26.2"` to every `features.json` range that
   lists `"26.1"`.
6. **resource-pack reply fix** — mineflayer's `lib/plugins/resource_pack.js`
   passes a `uuid-1345` object where minecraft-protocol's UUID writer expects a
   string, so the reply is mis-serialised and the server never sends
   `finish_configuration` (the bot hangs). The patch stringifies the UUID and
   drops the extra uuid-less `DECLINED` write that 26.2 rejects.

Patches 3–6 skip cleanly when the target file is already patched or missing, so
the layer survives partial installs and future package changes gracefully.

### Verified against a real server, not a mock

An emulated `minecraft-protocol` **server** cannot write the new 26.2
login-success `sessionId` UUID field in the released code, so it is useless for
validating 26.2 login. Every verification in this repo therefore runs against a
**real PaperMC 26.2** server (`scripts/paper-server.sh`, `npm run smoke`). The
`SPIKE-26.2.md` file records the original spike that proved this.

### Version override

`MC_VERSION` (env) or the `version` setting selects the protocol version. The
default is `26.2`; the compat script honours `MC_VERSION` too, so the same repo
can be pointed at `26.1` (which needs no patching) for comparison.

---

## 3. Dropping the compat layer

The layer is intentionally isolated so removal is mechanical. Do it once 26.2
(protocol 776) is in the **released** npm packages:

1. **Bump deps** to the first releases that include 26.2:
   `mineflayer`, `minecraft-data`, `minecraft-protocol` (and transitively
   `prismarine-chunk` / `prismarine-physics`). `package.json` pins exact
   versions today; update them.
2. **Delete the vendored data** — remove `vendor/minecraft-data-26.2/`
   and the `.compat-cache/` fallback cache.
3. **Delete the patch script** — remove `scripts/apply-compat.js`.
4. **Unwire it** — drop the `"compat"` and `"postinstall"` entries from
   `package.json` `scripts`.
5. **Keep the default version** — leave `version: '26.2'` (now first-class);
   `MC_VERSION` still works for targeting other versions.
6. **Verify** — run `npm install && npm run smoke`; it must still print
   `20/20 checks passed` (or more) without any `[compat]` log lines.
7. **Update docs** — remove the compat section from `README.md` and this
   section, and note the 26.2 requirement only in `docs/VERIFY.md` if the
   minimum supported version changed.

A quick way to confirm the patch is no longer needed: after bumping deps, run
`npm run compat`. If mineflayer already resolves 26.2, the script's patch steps
report `already patched`/`skip` and the sanity check still prints
`OK — minecraft-data 26.2 protocol 776`. When that is true with the script
absent, the layer is redundant.

---

## 4. Bot lifecycle

```
pending ──(timer)──▶ connecting ──login──▶ connected ──spawn──▶ spawned
                         │                     │                  │
                         │                     │        kicked ───┤
                         ▼                     ▼                  ▼
                       error ◀─────────────────┴─────────── disconnected
                         │                                        │
                         └──────── auto-respawn (2s) ─────────────┘
                                   (unless removed by the user)
```

- States are surfaced per bot and counted in `GET /api/status`
  (`total`/`spawned`/`connected`/`errored`).
- `disconnectBot` marks a bot `removed` before quitting, which suppresses the
  auto-respawn; a server-initiated kick or drop does not.
- Each bot keeps the last 20 chat/system lines; up to 200 are retained
  internally.

## 5. Event model

Every engine event flows to clients unchanged over `WS /ws`:

| `type` | Key fields | Meaning |
| --- | --- | --- |
| `bot_state` | `botId, name, state, error` | lifecycle transition |
| `chat` | `botId, name, position, message` | incoming chat / system message |
| `system` | `botId, name, message, resourcePack?` | spawn notice, resource-pack notice |
| `log` | `level, message, botId?` | manager-level diagnostics |

The same objects are what a client would poll from `GET /api/bots` (minus the
`log` stream), so the UI and the REST API stay consistent.
