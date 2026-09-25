# JTEST WEB LITE — 100+ Bots Capable

> **Fully web-based, no trash env.** No `JUNE_SESSIONS`, no `JUNE_PLATFORM=true`, no dev dashboard, no external session server. Just `npm start` and pair at `/`.

## Why Lite?

Previous edition was **9MB + 700 deps (48 packages, ffmpeg, sharp, jimp, ytdl, scrapers, pdfkit, etc)** + 309 commands loaded in memory + SQLite per bot + message store + group caches = **80-150MB RAM per bot** → 30 bots = 4.5GB.

**Lite is:**
- **16 declared deps**, of which 7 are load-bearing for the gateway: `baileys, express, qrcode, dotenv, pino, ws, awesome-phonenumber`
- **No database engine at all** — no `better-sqlite3`, no `sql.js`, no `mongodb`, no `pg`. Storage is one plain JSON file per bot (see [Data Storage](#data-storage))
- **No `sharp`, no scrapers, no `moment`** — media/scraper commands were removed with the command purge
- **File auth** `auth/<botId>/creds.json`
- **No message store**, no group metadata cache, no anti-delete queues
- **No dev dashboard** (`/dev` removed), no `logStore`, no MongoDB registry
- **No JUNE_SESSIONS env** — sessions only via web UI at `/`, persisted in `data/platform-registry.json`
- **No JUNE_PLATFORM toggle** — always web
- **2 commands shipped** (`.ping`, `.uptime`) behind a real hot-reloading loader — drop a file in `commands/` and it registers without a restart

**Measured** (Node 20, `--expose-gc`, 0 bots paired):

| | before | after |
|---|---|---|
| Idle RSS, whole app | 99.6 MB | **87.9 MB** |
| Cold boot to "Server started" | 437 ms | **321 ms** |
| `database.js` alone — boot | 119 ms | **15 ms** |
| `database.js` alone — RSS | 57.4 MB | **39.5 MB** |
| Resident modules for the DB layer | 54 | **4** |
| Repo JS | 14,773 lines | **8,956 lines** |
| `node_modules` | 276 MB / 282 pkgs | **230 MB / 240 pkgs** |

**Per bot, once populated** (8 groups × 40 members × 7 days of activity): **+0.41 MB RSS**, **44 KB on disk**. 25 such bots add 10.3 MB total — the database is no longer a scaling factor. Remaining per-bot cost is the Baileys socket itself (~15–25 MB), so a 500 MB VPS realistically carries **~20 bots**, and a 4 GB box ~120–150.

## Quick Start (VPS)

```bash
git clone https://github.com/eminentboy11/Jtest && cd Jtest
npm install --no-audit
echo "PORT=3000
PLATFORM_MAX_BOTS=100
PLATFORM_SLOT_TTL_MIN=15
PLATFORM_CREATES_PER_HOUR=10" > .env
node index.js
# open http://YOUR_IP:3000/
```

PM2:
```bash
npm i -g pm2
pm2 start index.js --name jtest-lite -- --max-old-space-size=3072
pm2 save && pm2 startup
```

Docker:
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --omit=dev
COPY . .
EXPOSE 3000
CMD ["node","index.js"]
```

## How It Works

1. User visits `/` → `pair.html`
2. Chooses QR or pairing code + phone
3. `POST /api/slots` → creates slot + provisions bot via `sessionService.provision`
4. WebSocket watches slot: `{"type":"watch_slot","slotId":"..."}`
5. Bot boots with file auth `auth/<botId>/`, QR rendered via `qrcode`, code via `sock.requestPairingCode`
6. On `open`, registry marks paired, slot → `paired`
7. GC sweeps expired slots every 60s

Sessions persist in `data/platform-registry.json` + `auth/`. No env editing.

## Data Storage

There is no database engine. Each bot owns exactly one JSON file:

```
data/bots/<botId>.json
```

Inside it, eight flat sections — only keys somebody actually wrote are stored, so a fresh bot's file is under 1 KB and defaults fill in at read time:

```jsonc
{
  "schemaVersion": 1,
  "settings":    { "botName": "…", "prefix": ".", "mode": "public" },
  "groups":      { "<groupJid>": { "welcome": true, "antilink": false } },
  "users":       { "<userJid>":  { "name": "…" } },
  "warnings":    { "<groupJid>": { "<userJid>": { "count": 2, "entries": [] } } },
  "moderators":  { "<groupJid>": ["<userJid>"] },
  "muted":       { "<groupJid>": { "<userJid>": 1730000000000 } },
  "groupStats":  { "<groupJid>": { "2026-09-25": { "total": 5, "users": {}, "hours": {} } } },
  "lidMap":      { "lidToPn": {}, "pnToLid": {} },
  "kv":          {}
}
```

**How a call finds the right file.** `index.js` wraps every inbound message in `database.runAsBot(bot.id, …)`, which uses Node's `AsyncLocalStorage` to tag the whole async chain. Any `database.*` call made while handling that message — including ones fired after an `await` — resolves to that bot's file. Calls made outside any bot context (boot-time reads, timers) fall back to the default bot.

This replaced a design where each bot got its own SQLite file but 181 modules had already captured the *default* handle at `require()` time, so every bot silently shared one database: bot A disabling a command disabled it for bot B, and the last bot to set `botName` won. `runAsBot` resolves the bot at call time instead of import time, which is what makes concurrent bots actually independent.

**Writes.** Debounced 250 ms per bot, then written to a temp file and `rename()`d into place, so a crash mid-write cannot truncate a bot's data. `process.exit()` is covered by an `exit` handler that flushes synchronously. A file that fails to parse is renamed to `<botId>.json.corrupt-<timestamp>` and the bot starts fresh rather than taking the process down.

**Ops.**
```js
database.listBotIds()          // every bot with a file on disk
database.botDataFile(botId)    // resolved path
database.flush()               // write all pending changes now
database.resetBotData(botId)   // wipe one bot
```

`data/` is gitignored. To back up, copy the directory — no dump tool, no migration, no lock files. Edit a bot's settings by hand with any text editor while the server is stopped.

## APIs (Lite)

**Public (no auth):**
- `GET /` → pairing UI
- `POST /api/slots` → `{mode:'qr'|'code', phoneNumber?}`
- `GET /api/slots/:slotId` → status
- `DELETE /api/slots/:slotId` → cancel
- `POST /api/slots/:slotId/code` → another code

**System:**
- `GET /health` → OK
- `GET /health/details` → `{bots, maxBots, memory}`
- `GET /status` → simple HTML list

**WebSocket:**
- `ws://host/` → send `{"type":"watch_slot","slotId":"..."}`
- Receives `{type:"slot", slot:{qr, codes, status}}`

No `/dev/*` — dev dashboard removed completely.

## What Consumes RAM / Space? (Old vs Lite)

**Heavy in old:**
1. `ffmpeg-static` ~186MB binary + `fluent-ffmpeg` + `sharp` ~50MB + `jimp` ~30MB — sticker/video conversion, loaded even if unused
2. `better-sqlite3` native per bot (5-10MB handle) + `sql.js` WASM + per-bot DB file
3. `Baileys` message store `Map<JID, Map<msgId, msg>>` grows unbounded, group metadata cache, presence store
4. 309 commands `require()` at boot — each file closure, many require `axios, cheerio, moment, pdfkit, mammoth` etc
5. `@bochilteam/scraper`, `ruhend-scraper`, `yt-search`, `ytdl-core`, `g-i-s`, `wa-sticker-formatter`, `webp-converter`, `node-webpmux` — media downloaders
6. `mongodb`, `pg` drivers + platform registry dual backend
7. `logStore` keeps 200+ logs in memory + dev WS broadcasts
8. `moment-timezone` ~2MB locales, `pdfkit`, `docx`, `mammoth`, `pdf-parse`
9. Anti-delete + group stats + auto-react caches per bot
10. `.env` watcher + hot-reload + `JUNE_SESSIONS` JSON parsing every 15s

Items **2 and 6 are now gone** — no database engine is installed at all, and the DB layer's module count dropped from 54 to 4. Items 3, 4, 7, 8, 9 and 10 went with the command purge.

**Still riding along**, each pulled in by exactly one `utils/` file that nothing currently requires — the largest remaining win, worth ~123 MB of `node_modules`:

| package | size | only required by |
|---|---|---|
| `ffmpeg-static` | 77 MB | `utils/ffmpegPath.js` |
| `webp-converter` | 33 MB | `utils/sticker.js` |
| `fluent-ffmpeg` | 13 MB | `utils/sticker.js` |

They are left declared so that restoring a sticker/video command from git history (`git checkout 16d1f45 -- commands/<path>`) keeps working. Delete them only if you are sure those commands are not coming back.

## Scaling

Budget from measured numbers, not estimates: **88 MB fixed** for the gateway with zero bots, then **~15–25 MB per bot** for the Baileys socket plus **~0.4 MB** for its data.

| VPS | realistic bots | notes |
|---|---|---|
| 500 MB | **~20** | 412 MB left after the fixed cost |
| 1 GB | ~40 | |
| 4 GB | ~120–150 | leave headroom for message bursts |

- Set `PLATFORM_MAX_BOTS` to your real ceiling — it is a hard gate, not a hint
- Put `auth/` and `data/` on SSD; both are small-file workloads
- Monitor `GET /health/details` → `memory.heapUsed`
- If heap passes ~80% of the box, lower the cap rather than adding swap

**One process per `data/` directory.** The store is a JSON file per bot with no cross-process locking, so PM2 cluster mode or two instances sharing `data/` will have them overwrite each other — last writer wins. Scale by running separate instances with separate `JUNE_DATA_DIR` values behind a load balancer, splitting bots across them. Within one instance, bots are fully isolated from each other.

## Env Vars (Lite)

No `JUNE_SESSIONS`, no `JUNE_PLATFORM`, no `ADMIN_PASSWORD`, no `SESSION_ID`, no `MONGODB_URI`.

Only:
- `PORT` (default 3000)
- `PLATFORM_MAX_BOTS` (default 100)
- `PLATFORM_SLOT_TTL_MIN` (default 15)
- `PLATFORM_CREATES_PER_HOUR` (default 10)
- `PLATFORM_MAX_WS_CONNECTIONS` (200)
- `PLATFORM_MAX_WS_PER_IP` (20)
- `LOG_LEVEL` (silent/info)
- `JUNE_DATA_DIR` (default `<repo>/data/bots`) — where the per-bot JSON files live
- `JUNE_DB_FLUSH_MS` (default 250) — write debounce per bot; raise it on slow disks

Fully web-based edition — nothing like switching mode through env.

## License MIT
