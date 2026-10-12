# Verification

Reproducible steps to run the Paper 26.2 offline server and prove the
test-bot manager works end-to-end, plus the observed output from the last run.

Two levels:

1. **Automated smoke test** — `npm run smoke` boots a real Paper 26.2 server and
   asserts the Definition-of-Done behaviours. Use this as the fast check.
2. **Manual end-to-end** — start the app and a server, add bots from the
   dashboard, chat and run a command. Use this to confirm the user-facing flow.

---

## Prerequisites

| Thing | Check | Expected |
| --- | --- | --- |
| Node.js | `node -v` | `v20+` (verified on `v24.21.0`) |
| npm | `npm -v` | `11.x` |
| Java 25 | `/usr/lib/jvm/java-25-openjdk-amd64/bin/java -version` | `openjdk version "25…"` |

The system default `java` is usually **17** and will not run Paper 26.2. The
scripts default to the Java 25 path above; override with `JAVA_BIN` if yours
differs.

Network is needed **once** to download the Paper jar (~65 MB). Afterwards it is
cached in `.paper-server-smoke/paper.jar`.

---

## Step 1 — install (also applies the 26.2 compat layer)

```bash
git clone <this-repo> mc-testbot-manager
cd mc-testbot-manager
npm install
```

`postinstall` runs the compat layer. Verify it independently:

```bash
npm run compat
```

**Observed output (idempotent re-run):**

```text
$ npm run compat

> mc-testbot-manager@1.0.0 compat
> node scripts/apply-compat.js

[compat] using vendored data at vendor/minecraft-data-26.2 (offline)
[compat] staged 26.2 data into node_modules/minecraft-data/minecraft-data/data
[compat] regenerated data.js
[compat] already patched: node_modules/mineflayer/lib/version.js
[compat] already patched: node_modules/prismarine-chunk/src/index.js
[compat] already patched: node_modules/prismarine-physics/lib/features.json
[compat] already patched: node_modules/mineflayer/lib/plugins/resource_pack.js
[compat] OK — minecraft-data 26.2 protocol 776
```

The important line is the last one: **`OK — minecraft-data 26.2 protocol 776`**.
If it prints `[compat] FAILED`, 26.2 data did not resolve and bots will not
connect.

---

## Step 2 — smoke test (automated, real Paper server)

```bash
npm run smoke
```

What it does:

- starts a **real** Paper 26.2 offline server on `127.0.0.1:25578`
  (Java 25; reuses a server already on that port if one is running),
- creates 5 bots, waits for all to spawn, checks chat round-trips and `/help`,
- exercises the resource pack, a server kick + auto-respawn, and
  disconnect-one/all,
- boots the REST API and checks a few endpoints,
- prints `PASS`/`FAIL` per check and exits non-zero on any failure.

Useful env vars: `PAPER_PORT` (default `25578`), `JAVA_BIN`, `PAPER_BUILD`
(default `133`), `SMOKE_KEEP_SERVER=1` (leave the server up for manual poking).

### Expected result

**20/20 checks passed**, exit code `0`.

### Observed output

Raw transcript from the verified run (Node `v24.21.0`, Java 25,
Paper 26.2 build 133):

```text
$ npm run smoke

> mc-testbot-manager@1.0.0 smoke
> node scripts/smoke.js

== Paper 26.2 test-bot manager — smoke ==
[smoke] node v24.21.0, java /usr/lib/jvm/java-25-openjdk-amd64/bin/java
PASS  Paper 26.2 server started
PASS  5 bots created with 5 distinct names  — Isla52, Oliver55, Hana, BiancaCross, Zane
PASS  5 spawn events observed  — 5/5 spawned
PASS  spawn counted in state events
PASS  a bot's chat reached the server (seen by another bot)  — smoke-chat-1791783131771
PASS  a / command executed and the server replied  — /help
PASS  bot accepted the server resource pack
PASS  bot survived the resource pack (still spawned)  — 5/5 still spawned
Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20) {
  errno: -104,
  code: 'ECONNRESET',
  syscall: 'read'
}
PASS  server kick does not crash the app  — kicked Isla52
PASS  kicked bot auto-respawns
PASS  disconnect one bot removes it
PASS  disconnect all removes every bot
PASS  acceptResourcePack=false still connects (best-effort decline, no crash)  — bot SmokeDecline
PASS  settings persist to config.json
PASS  settings honoured on reconnect (prefix applied)  — Smoke_Persist
PASS  GET /api/status
PASS  GET /api/bots
PASS  PUT /api/settings persists
PASS  POST /api/chat with no bots is a no-op
PASS  POST /api/chat validates input

== summary ==
20/20 checks passed
```

The token `smoke-chat-1791783131771` and the random names are generated per run,
so they differ each time; the `PASS`/`FAIL` lines and the `20/20` summary are
the stable assertions.

The `Error: read ECONNRESET` lines are **benign Node noise**: the kick test
deliberately drops a live socket, and the socket's error is printed to stderr
while the check still reports `PASS`. It does not fail the run (exit code 0).


---

## Step 3 — manual end-to-end (dashboard)

Three terminals.

**Terminal A — the manager:**

```bash
npm start
# → paper-test-bots listening on http://127.0.0.1:3000
# →   target server: 127.0.0.1:25577 (MC 26.2)
```

**Terminal B — the Paper 26.2 offline server:**

```bash
./scripts/paper-server.sh
# → Starting Paper 26.2 on port 25577 (Ctrl+C to stop)...
# wait for: Done (…s)! For help, type "help"
```

It writes `.paper-server/server.properties` with `online-mode=false` and
`server-port=25577`, so bots can join. To use your own server instead, set
`online-mode=false` there and point the manager at it.

**Terminal C / browser:**

1. Open <http://127.0.0.1:3000> and confirm **Settings** show
   `host 127.0.0.1`, `port 25577`, `version 26.2`, `acceptResourcePack true`.
2. Click **Add bots** (count 5). The list should fill with 5 bots whose state
   becomes **spawned**. Names are distinct and random.
3. In the server console (Terminal B) you should see join messages such as
   `Vera joined the game`.
4. Type a chat message in the dashboard and send it; it appears in Terminal B
   and in the other bots' chat panels.
5. Run `/help` as a bot; the server's help output shows up in that bot's chat
   feed.
6. Click a bot's **Disconnect**, then **Disconnect all** — the list empties.
7. Add a bot again; stop and restart `npm start`, and confirm the host/port
   settings persisted (they are read from `config.json`).

**API-only equivalent (no browser):**

```bash
curl -s http://127.0.0.1:3000/api/status
curl -s -X POST http://127.0.0.1:3000/api/bots \
  -H 'content-type: application/json' -d '{"count":5}'
curl -s http://127.0.0.1:3000/api/bots
curl -s -X POST http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' -d '{"message":"hello"}'
curl -s -X POST http://127.0.0.1:3000/api/command \
  -H 'content-type: application/json' -d '{"command":"/help"}'
```

Expected: `/api/status` returns `"ok":true` with a `counts.spawned` that rises
as bots connect; `/api/bots` lists them; the chat/command calls return
`{"delivered":[…],"count":N}` with `N>0`.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Server exits with an UnsupportedClassVersion / "Java 17" error | wrong Java | export `JAVA_BIN=/usr/lib/jvm/java-25-openjdk-amd64/bin/java` |
| `[smoke] ERROR: server failed to start` | port busy or too little RAM | set `PAPER_PORT=25579`, free memory; the smoke timeout is 180 s |
| Bot stays `connecting` then `error` | 26.2 compat not applied, or server is `online-mode=true` | run `npm run compat`; set `online-mode=false` |
| Bot hangs in configuration after a resource pack | 26.2 resource-pack UUID patch missing | re-run `npm run compat` (patch 6) |
| `EADDRINUSE` on `3000` | something already on the port | `API_PORT=3100 npm start` |
| Random names not applied | called with `randomNames:false` and no `names` | pass `{"count":N}` (defaults to random) or explicit `names` |

For the internals behind the compat fixes, see
[`ARCHITECTURE.md`](ARCHITECTURE.md) and [`SPIKE-26.2.md`](../SPIKE-26.2.md).
