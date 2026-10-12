# Spike: Minecraft 26.2 support for mineflayer (CTO, verified)

## Result
A mineflayer bot **connects, spawns and exchanges chat** with a real **PaperMC 26.2**
offline-mode server. This requires the compat layer below because released npm
packages only ship data up to 26.1.

## Environment
- Node v24 / npm 11.
- Java 25 at `/usr/lib/jvm/java-25-openjdk-amd64` (system `java` is 17 — do not use).
- Paper 26.2 build 133, sha256 `bf1dcf627364f8a631ab15250d240eb5a8e89faaac523b391e1c61367fce9ff1`.

## Compat layer
`scripts/apply-compat.js` (run as `postinstall`) applies all required patches:
1. vendors `PrismarineJS/minecraft-data@pc_26_2` (protocol 776) into
   `node_modules/minecraft-data/minecraft-data/data`,
2. regenerates `node_modules/minecraft-data/data.js`,
3. adds `26.2` to `mineflayer/lib/version.js`,
4. adds `26.2 -> pc/1.18/chunk` to `prismarine-chunk/src/index.js`,
5. adds `"26.2"` to the `26.1` feature ranges in `prismarine-physics/lib/features.json`.
6. fixes mineflayer's resource-pack reply (`lib/plugins/resource_pack.js`): it
   passes the pack UUID as a `uuid-1345` object, but minecraft-protocol's UUID
   writer expects a string, so the reply is mis-serialised and the server never
   sends `finish_configuration` — the bot hangs in the configuration phase. The
   extra uuid-less `DECLINED` write is dropped too, since 26.2 requires the UUID.

Remove this layer once 26.2 ships in the released npm packages.

## Verified commands
```bash
# 1. start a real offline server (Java 25)
./scripts/paper-server.sh          # listens on 127.0.0.1:25577

# 2. connect a bot (after npm install has run apply-compat)
MC_VERSION=26.2 node -e "
const mf=require('mineflayer');
const b=mf.createBot({host:'127.0.0.1',port:25577,username:'TestBot_1',auth:'offline',version:'26.2'});
b.once('spawn',()=>{console.log('spawn',b.version);b.chat('hello');});
"
```

## Notes / gotchas
- Do **not** verify with an emulated `minecraft-protocol` server: its released code
  cannot write the new 26.2 `login.toClient.sessionId` UUID field, so login fails.
  Use a real Paper server.
- Vanilla `/say` requires op; use a permitted command (e.g. `/help`) or op the bot.
