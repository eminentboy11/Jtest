# JTEST WEB LITE — 100+ Bots Capable

> **Fully web-based, no trash env.** No `JUNE_SESSIONS`, no `JUNE_PLATFORM=true`, no dev dashboard, no external session server. Just `npm start` and pair at `/`.

## Why Lite?

Previous edition was **9MB + 700 deps (48 packages, ffmpeg, sharp, jimp, ytdl, scrapers, pdfkit, etc)** + 309 commands loaded in memory + SQLite per bot + message store + group caches = **80-150MB RAM per bot** → 30 bots = 4.5GB.

**Lite is:**
- **7 deps only**: `baileys, express, qrcode, dotenv, pino, ws, awesome-phonenumber`
- No `better-sqlite3`, no `ffmpeg-static` (186MB), no `sharp`, no `jimp`, no scrapers, no `moment`, no `mongodb/pg`, no `sql.js`
- **File auth** `auth/<botId>/creds.json` — no SQLite per bot
- **No message store**, no group metadata cache, no anti-delete queues, no auto-react, no command loader (only ping)
- **No dev dashboard** (`/dev` removed), no `logStore`, no MongoDB registry
- **No JUNE_SESSIONS env** — sessions only via web UI at `/`, persisted in `data/platform-registry.json`
- **No JUNE_PLATFORM toggle** — always web

**Result:** ~15-25MB per bot → **100 bots ≈ 1.5-2.5GB RAM** (vs 8-15GB before). Fits in 25% of an 8GB VPS (2GB).

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

**Lite removes all above.** Only `baileys` + `express` + `qrcode` remain. Per-bot RAM ~15-25MB.

## Scaling to 100+ Bots

- Set `PLATFORM_MAX_BOTS=100` (or 200)
- Use `auth/` on fast disk (SSD)
- Disable heavy commands (already done)
- Monitor `GET /health/details` → `memory.heapUsed`
- If heap > 80% of VPS, lower cap or add another instance with shared `data/` via NFS or use PM2 cluster

Example: 4GB VPS → 100 bots ≈ 2GB (50%) → fits in 25% of 8GB VPS (2GB). For true 25% of 4GB (1GB), host ~40-50 bots per instance.

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

Fully web-based edition — nothing like switching mode through env.

## License MIT
