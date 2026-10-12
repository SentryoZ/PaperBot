# Paper 26.2 Test-Bot Manager

A small, web-managed tool for running Minecraft test bots against an
**offline-mode PaperMC 26.2** server. Create bots with random names, watch
in-game chat and system messages, broadcast chat, run commands, and let bots
accept (or decline) server resource packs.

Reference project: <https://github.com/crpmax/mc-bots>

## Requirements

- **Node.js 24+ / npm 11+**
- **Java 25** to run the bundled Paper server. The system default `java` is
  usually 17 and will **not** work:
  `/usr/lib/jvm/java-25-openjdk-amd64/bin/java`.

## Install

```bash
npm install          # installs deps and runs scripts/apply-compat.js (postinstall)
```

`apply-compat.js` adds Minecraft **26.2** support, which the released npm
packages (`mineflayer@4.39.0`, `minecraft-data@3.117.0`, …) do not ship yet.
It prefers the vendored data slice in `vendor/minecraft-data-26.2/` (offline)
and falls back to downloading the PrismarineJS/minecraft-data `pc_26_2`
tarball. It is idempotent — re-run any time with:

```bash
npm run compat
```

Set `MC_VERSION` to target a different version (default `26.2`).

## Run

```bash
npm start            # http://127.0.0.1:3000  (API + static UI)
```

Then, in another shell, start a Paper 26.2 server in offline mode:

```bash
./scripts/paper-server.sh       # downloads Paper 26.2, listens on 127.0.0.1:25577
```

Open <http://127.0.0.1:3000>, add bots, and watch them connect. Or drive the
API directly.

## Smoke test

```bash
npm run smoke        # boots a real Paper 26.2 server, runs the bot engine, prints PASS/FAIL
```

## API

Base URL `http://127.0.0.1:3000`. Set `API_HOST` / `API_PORT` to override the
bind address. WebSocket endpoint: `WS /ws` (events: `chat`, `system`,
`bot_state`, `log`).

| Method   | Path                        | Body / notes                                                        |
| -------- | --------------------------- | ------------------------------------------------------------------- |
| `GET`    | `/api/status`               | server version, settings, bot counts, uptime                        |
| `GET`    | `/api/settings`             | current settings                                                    |
| `PUT`    | `/api/settings`             | any of the settings keys below                                      |
| `GET`    | `/api/bots`                 | all bots with state                                                 |
| `POST`   | `/api/bots`                 | `{count, names?, prefix?, randomNames?}`                            |
| `DELETE` | `/api/bots/:id`             | disconnect one bot                                                  |
| `POST`   | `/api/bots/disconnect-all`  | disconnect every bot                                                |
| `POST`   | `/api/chat`                 | `{message, botIds?}`                                                |
| `POST`   | `/api/command`              | `{command, botIds?}` (a leading `/` is added if missing)            |

`botIds` omitted/empty targets every connected bot.

### Settings

Persisted to `config.json` in the project root.

| Key                  | Default      | Meaning                                      |
| -------------------- | ------------ | -------------------------------------------- |
| `host`               | `127.0.0.1`  | target server host                           |
| `port`               | `25577`      | target server port                           |
| `version`            | `26.2`       | Minecraft protocol version                   |
| `acceptResourcePack` | `true`       | accept server resource packs                 |
| `nicknamePrefix`     | `PaperBot`   | prefix for generated names (`prefix` mode)   |
| `nicknameMode`       | `random`     | `random` realistic names or `prefix` names   |
| `connectDelayMin`    | `300`        | min ms between bot logins                    |
| `connectDelayMax`    | `1500`       | max ms between bot logins                    |

## Layout

```
src/
  index.js          entry point (HTTP + WS)
  config.js         config.json load/save
  names.js          realistic random name generator
  bot-manager.js    mineflayer bot lifecycle, chat, commands, resource packs
  server.js         Express + ws API
public/             static dashboard (no build step)
scripts/
  apply-compat.js   Minecraft 26.2 compat patches (postinstall)
  paper-server.sh   download + run Paper 26.2 offline
  smoke.js          end-to-end test against a real Paper 26.2 server
vendor/
  minecraft-data-26.2/  vendored 26.2 protocol data (dataPaths.json + pc/26.2)
```

## Notes

- Bots use offline auth (`auth: 'offline'`), matching `online-mode=false`.
- Resource packs: during the configuration phase the protocol layer must answer
  the pack or the server never finishes configuration, so mineflayer answers
  automatically; the manager observes and logs it. Setting
  `acceptResourcePack=false` declines packs offered later (in the play state).
- Emulated `minecraft-protocol` servers cannot write the 26.2 login-success
  `sessionId` field, so **always verify against a real Paper server**.
- `/say`/`/kick` require operator permission; from the server console they work
  without op. `/help` works for every player.
