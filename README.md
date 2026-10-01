# JTEST WEB LITE — 100+ Bots Capable

> **Fully web-based, no trash env.** No `JUNE_SESSIONS`, no `JUNE_PLATFORM=true`, no dev dashboard, no external session server. Just `npm start` and pair at `/`.

## Why Lite?

Previous edition was **9MB + 700 deps (48 packages, ffmpeg, sharp, jimp, ytdl, scrapers, pdfkit, etc)** + 309 commands loaded in memory + SQLite per bot + message store + group caches = **80-150MB RAM per bot** → 30 bots = 4.5GB.

**Lite is:**
- **10 declared deps**, every one required by live code (asserted by `test/structure.test.js`): `baileys, express, qrcode, dotenv, pino, ws, awesome-phonenumber, axios, node-webpmux, chalk`
- **No database engine at all** — no `better-sqlite3`, no `sql.js`, no `mongodb`, no `pg`. Storage is one plain JSON file per bot (see [Data Storage](#data-storage))
- **No `ffmpeg-static`, no `sharp`, no `jimp` dep** — `.sticker` converts through the *system* ffmpeg (`apt install ffmpeg`), which costs zero bytes of `node_modules` and zero idle RSS
- **File auth** `auth/<botId>/creds.json`
- **No message store** and no group metadata cache; `.antidelete` keeps a capped 1,000-entry replay cache in the per-bot JSON instead
- **No dev dashboard** (`/dev` removed), no `logStore`, no MongoDB registry
- **No JUNE_SESSIONS env** — sessions only via web UI at `/`, persisted in `data/platform-registry.json`
- **Tiered storage** — HOT RAM (LRU bot stores, idle unload) → WARM disk (`data/` + `auth/`) → COLD GitHub (`june-web-data`: one `bots/<id>.tar.gz` per offline+idle bot, pushed over the git wire protocol, zero REST quota). Live bots are never archived; waking a cold bot is one pull+extract. `JUNE_DATA_REPO` empty = feature off
- **Quiet console by default** — per-bot lifecycle chatter (event dumps, close reasons, pairing attempts, purge traces) logs only with `DEBUG=true` in env; otherwise only actionable lines print
- **No JUNE_PLATFORM toggle** — always web
- **Process commands are scoped like a multi-tenant system should be** — one process runs up to 100 bots, so anything that ends a process is a dev decision and anything a tenant may do touches their own bot only:
  - `.upgrade` — **devs only, silently ignored for everyone else.** Exits `44`, which the auto-sync loader reads as "re-sync and relaunch me": the container stays up and every bot is back in seconds with the new code on `main`
  - `.shutdown` — **devs only, silently ignored for everyone else.** Runs the real graceful close, then exits `45` (stay down)
  - `.restart` — that bot's **owner**, and it reboots **only the bot the message arrived on** (`sessionService.reconnect(botId)`); other tenants never notice. It cannot fetch new code — only `.upgrade` re-syncs. Non-owners are ignored silently
  - see **Loader protocol** below for the exit codes and the loader-side contract
- **391 commands shipped** behind a real hot-reloading loader — drop a file in `commands/` and it registers without a restart:
  - health: `.ping`, `.uptime`
  - moderation: `.antispam`, `.antiviewonce`, `.antibot`, `.antiforward`, `.antitagadmins`, `.antidelete`, `.antiall`
  - group admin (ported from the June X / `..wdp` core): `.kick`, `.promote`, `.demote`, `.hidetag`, `.grouplink`, `.revoke`, `.setgname`, `.setgdesc`, `.staff`
  - warnings & mutes: `.warn`, `.resetwarn`, `.mute`, `.unmute` (per-user mutes ride the handler's delete-on-sight list; no-target `.mute`/`.unmute` lock/reopen the group)
  - welcome / goodbye: `.welcome`, `.setwelcome`, `.goodbye`, `.setgoodbye` (template variables `@user @group groupDesc time #memberCount botName`, optional `nopp` text-only mode)
  - utility: `.menu`, `.help`, `.sticker`, `.vv`/`.vv2`, `.save`, `.mygroups`, `.chatbot`
  - owner tools: `.mode`, `.setprefix`, `.setfont`, `.setbotpp`, `.autoreact`, `.autotyping`, `.autorecording`, `.autorecordtype`, `.add`, `.all`, `.tagall`
  - rich-app games: `.ttt2`, `.tod`, `.snake`
  - group membership (ported from `..wdp`): `.join`, `.leave`, `.approve`, `.reject`
    (join requests), `.kickinactive`, `.kickactive` (activity-driven sweeps),
    `.groupinfo`
  - owner blocking: `.block`, `.unblock` (mention, reply, or raw phone number)
  - group extras: `.poll` (native WhatsApp polls), `.myactivity`, `.autosticker`
  - link gates: `.nsfw` and `.detect` — see below

  **Link gates.** `nsfw` and `detect` existed in `DEFAULT_GROUP_SETTINGS` as
  dormant keys that nothing read; both now have commands *and* real enforcement
  in `handler.js`'s content-protection chain, next to antilink. Rules live in
  `utils/contentGates.js` so the commands and the handler cannot drift apart.

  | setting | default | effect |
  |---|---|---|
  | `nsfw` | **off** | adult-content links from non-admins are deleted; `.nsfw on` allows them |
  | `detect` | **off** | `.detect on` deletes deceptive links (raw IPs, punycode/look-alike domains, shorteners, high-risk TLDs) |

  `.detect` is *not* a second `.antibot`: `.antibot` detects bot **accounts** and
  kicks them, `.detect` scans link **content** and removes the message.

  **`.snipe`** reports recently deleted messages (who/when/type/preview) from
  antidelete's delete record — it does not keep a second copy of every message,
  and it does not re-send media (that stays `.antidelete`'s job). Because
  antidelete is what captures, `.snipe` needs it enabled and says so plainly
  rather than reporting an empty chat.

  ### June X (`..wdp`) parity

  This edition is being brought up to the `..wdp` June X command surface, with
  **web edition + multi-bot** as the only intended differences. Phase 1 landed
  the high-traffic categories:

  | wave | what |
  |---|---|
  | owner (58) | `.addsudo`, `.broadcast`, `.upgrade`, `.shutdown`, `.restart`, `.setmenu`, `.setpack`, `.stealth`, `.antiedit`, `.anticall`, status automation, … |
  | general (43) | `.botinfo`, `.botstatus`, `.alive`, `.getpp`, `.take`, `.attp`, `.fancytext`, `.qr`, `.tts`, `.write`, `.google`, `.ssweb`, … |
  | admin (61) | the full anti-* family (`.antilink`, `.antibadword`, `.antiimage`, `.antivideo`, `.antisticker`, `.antigif`, `.anticontact`, …), `.clean`, `.vcf`, `.killgc`, `.demoteall`, … |
  | media (24) | `.play`, `.song`, `.video`, `.yts`, `.lyrics`, plus the downloaders (`.spotify`, `.soundcloud`, `.tiktok`, `.instagram`, …) |
  | fun (18) | `.joke`, `.fact`, `.ship`, `.meme`, `.wyr`, `.paranoia`, … plus `.tetris` in games |
  | tools (33) | `.fetch`, `.catbox`, `.llama`, `.ocr`, `.shorturl`, `.quotedinfo`, `.audioeffects`, … |
  | utility (9) | `.calc`, `.translate`, `.weather`, `.wame`, `.pin` |
  | anime / reaction / sports / movies / religeon / ai / stalker / notes / convert | `.waifu`, `.kiss`, `.fifaupcoming`, `.moviebox`, `.bible`, `.chatgpt`, `.gitstalk`, `.addnote`, `.togif`, … |

  Several files register many commands from one module (`.reactions` alone is 58,
  `.sports` 19, `.ai` 14, `.movies` 14), which is why the file count is lower
  than the command count.

  **What parity does not mean here.** `..wdp` stores data in SQLite. This edition
  keeps its per-bot JSON store — that decision is what makes multi-bot work (one
  store per bot, bot resolved per call) and it is not negotiable, so every
  `database.*` call the ported commands make was reimplemented on the JSON store
  rather than importing a driver. `mongodb`, `pg`, `better-sqlite3` and `sql.js`
  stay out; a test asserts no file in the tree requires them.

  **Phase 2** ported the remaining categories (fun, tools, utility, anime,
  stalker, notes, convert, media, sports, movies, religeon, reaction, ai,
  aivideo). With the additions since — the `.git` restore and `.upgrade` — the
  loader now stands at **391 commands / 700 aliases across 18 categories**. All
  three deps it needed are light: `cheerio`, `form-data`, `ruhend-scraper`.

  **`.git` / `.github` — restored on request.** This command is
  `javascript-obfuscator` output, kept obfuscated as in `..wdp`. Three things
  are worth knowing about it:

  1. **It points at a third party's repository.** It is hardcoded to
     `https://github.com/Vinpink2/June-Ultra` — the upstream June X project, not
     this repo. If you would rather it show your own, change `GITHUB_USER` /
     `GITHUB_REPO` near the top of `commands/tools/git.js`.
  2. **The three computed `require()` calls were replaced with literals**
     (`gifted-btns`, `axios`, `path`, resolved from its own string table). The
     file is otherwise unchanged. Without this it trips the module-graph
     invariant in `test/structure.test.js`, which allows computed requires in
     exactly two places.
  3. **It loads `utils/menu1.jpg` as its header image.** `..wdp` references
     that file but never shipped it, so the original rendered without an image.
     Jtest now has one, drawn to match the existing menu family (360x360 JPEG,
     same neon June X Ultra styling). It is the only generated asset in the
     repo; the other four `menu*.jpg` are the originals.

  **Deliberately not ported** (each for a concrete reason, not oversight):

  | excluded | why |
  |---|---|
  | `design/` (30 files: the 29 `*logo` + `.logomenu`) | every logo needs `@napi-rs/canvas`, which `..wdp` never declares — they don't load there either |
  | `textmaker/` (18) | every file calls `mumaker.ephoto('en.ephoto360.com/…')` — this *is* the ephoto360 surface, just under a different folder |
  | `ephoto360/` (1) | scrapes ephoto360.com |
  | `aivideo/` (6: `ephotoVideo` + the 4 that require it + `videomenu`) | same `mumaker`/ephoto360 family; `videomenu` is a menu listing only those |
  | `convert/docconvert` | needs `xlsx` (undeclared in `..wdp`, so broken there too) |
  | `tools/encrypt` | needs `js-confuser` |
  | ~~`tools/git`~~ | **restored on request** — see below |
  | `general/write`, `owner/groupstatus` | need `sharp` / `fluent-ffmpeg` |
  | `owner/viewonce`, `fun/tod`, `fun/ttt2` | byte-identical to commands already shipped (`general/vv.js`, `games/tod.js`, `games/ttt2.js`) |

  **Two `..wdp` commands are deliberately not carried over**, because they are
  the only two that need a dependency this edition refuses on RAM grounds:
  `.write` (needs `sharp`) and `.groupstatus` (needs `fluent-ffmpeg`).
  `ffmpeg-static` is likewise not shipped — `utils/ffmpegPath.js` resolves the
  host's own ffmpeg, because the prebuilt binary would roughly halve how many
  bots fit in a 500 MB VPS.

  This edition now carries the June X command surface itself rather than a
  reduced copy of it; the remaining gap is the 16 categories listed above.
- **Zero unreachable code** — every `.js` file in the repo is reachable from `index.js` or `commands/`, asserted on every test run

**Measured** (Node 20, `--expose-gc`). The database columns compare against a worktree of the previous commit, same script, same session:

| | before | after |
|---|---|---|
| `database.js` boot | 119 ms | **15 ms** |
| `database.js` RSS | 57.4 MB | **39.5 MB** |
| Resident modules for the DB layer | 54 | **4** |
| Whole-app cold boot | 437 ms | **~350 ms** |
| Whole-app idle RSS, settled, 0 bots | 99.6 MB | **87–92 MB** |
| Repo JS | 67,320 → 14,773 lines | **5,516 lines** |
| Repo JS files | — | **27** |
| Declared deps | 36 → 20 | **12** |
| `node_modules` | 471 MB → 276 MB | **106 MB / 211 pkgs** |

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

## Loader Protocol

Jtest does not supervise itself. The bot is launched by an external auto-sync
loader (the `..wdp` bootloader), and **that process owns the lifecycle**: it
decides whether a process that just exited should come back, and how. A dying
process cannot restart itself, so Jtest only speaks the protocol on the way out
— two exit codes, defined in `platform/loader.js`:

| exit | meaning | sent by |
|---|---|---|
| `44` | **re-sync and relaunch me.** The loader pulls `main`, re-extracts, and starts the bot again. The panel container never restarts | `.upgrade` |
| `45` | **do not relaunch me.** Shut down and stay down | `.shutdown` |
| any other | an ordinary exit; treat it as one | crashes |

### The graceful close

Before either code is sent, `platform/loader.js` runs `gracefulClose()`:
`global.__JUNE_SHUTDOWN` — registered by `index.js` — ends every bot socket
cleanly, flushes the group counters, writes every bot's JSON store
synchronously, releases the HTTP server and closes the command watcher. It is
guarded by a 10 s timeout and is fail-open, so a stuck or missing routine can
never turn a shutdown into a non-shutdown.

`utils/shutdown.js` *described* this step but could never run it: `index.js`
never registered the global it looked for, so every shutdown in this repo
exited raw, mid-debounce. The registration exists now, and a boot test boots
the real `index.js` and confirms SIGTERM runs the routine.

The re-kill chain lives on the **loader's** side of this contract. `utils/shutdown.js` —
which used to hold them — was deleted, along with its
`database/shutdown-state.json` state file. It was the right idea in the wrong
process: it had the bot kill *itself* three boots in a row to outlast a
supervisor, but a bot that is exiting cannot guarantee it is the one that comes
back next.

### Loader side (paste into the loader)

```js
// 1. after the child exits
const code = status;                       // from the 'exit' listener
if (code === 44) return syncAndRelaunch(); // pull main + relaunch — unchanged
if (code === 45) {                         // stay down
  // re-arm the chain from HERE, where a process is still alive to do it
  const marker = path.join(botDir, 'database', 'shutdown-state.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const left = Number(readJson(marker)?.killsLeft ?? 3) - 1;
  if (left > 0) fs.writeFileSync(marker, JSON.stringify({ killsLeft: left, at: Date.now() }));
  else fs.rmSync(marker, { force: true });
  process.exit(1);                         // the panel may restart us...
}

// 2. before launching the bot on EVERY start
const marker = path.join(botDir, 'database', 'shutdown-state.json');
if (fs.existsSync(marker)) {
  const left = Number(readJson(marker)?.killsLeft ?? 3) - 1;
  if (left > 0) {
    fs.writeFileSync(marker, JSON.stringify({ killsLeft: left, at: Date.now() }));
    console.log(`[SHUTDOWN] chain kill — ${left} left`);
    process.exit(1);                       // ...and we kill ourselves again
  }
  fs.rmSync(marker, { force: true });      // chain spent: boot normally
}
```

`database/` is in the loader's `SKIP_DIRS`, so the marker survives a mirror-clean
— which is the property the original chain depended on too. Three boots, then
the bot stays up: the same behaviour as before, just enforced by the process
that is still running.

Set `JUNE_LOADER=1` in the loader's environment for the bot. `.upgrade` refuses
to exit `44` when it cannot detect a loader, because without one the code would
just take the bot down with nothing to bring it back.


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

Items **2 and 6 are now gone** — no database engine is installed at all, and the DB layer's module count dropped from 54 to 4. Items 3, 4, 7, 8, 9 and 10 went with the command purge. Item 1's ffmpeg/webp half is gone too: `ffmpeg-static` (77 MB), `webp-converter` (33 MB), `fluent-ffmpeg` (13 MB) and `file-type` were dropped along with the 21 unreachable `utils/` files that were their only consumers — **124 MB of `node_modules`**.

**Every declared dependency is required by live code.** `jimp` and `form-data` are present in
`node_modules` only as transitive deps (Baileys and axios respectively) and are not declared.
Restoring further commands from git history may need `npm i jimp` or media tooling again;
the structure suite will tell you the moment a declared dep has no live consumer.

`utils/bot_image.jpg` and `utils/menu*.jpg` (280 KB) are likewise unused now but were the menu command's assets — kept for the same reason.

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
- `JUNE_DB_FLUSH_MS` (default 250) — write debounce per bot; raise it on slow disks
- `CHATBOT_API_KEY` (unset by default) — enables `.chatbot` auto-replies; any OpenAI-compatible endpoint
- `CHATBOT_BASE_URL` (default `https://api.openai.com/v1`) and `CHATBOT_MODEL` (default `gpt-4o-mini`)
- `JUNE_LIBSIGNAL_LOG` (default off, `1` to enable) — Baileys bundles libsignal, which logs session churn straight to `console.*`, bypassing any logger level. By default the routine lifecycle lines and their multi-line `SessionEntry` dumps are suppressed; decrypt failures and key warnings still print. Set this to `1` to see everything while debugging.

Note: an earlier revision of this README listed `LOG_LEVEL`. Nothing in the code reads it; it has been removed rather than left as a lie.

`.sticker` needs a system ffmpeg (`apt install ffmpeg`). It is deliberately not an npm dep: `ffmpeg-static` is ~70 MB on disk and ~50 MB of RSS, which would roughly halve how many bots fit in a 500 MB VPS. Without it the command replies with the install hint instead of failing.

Fully web-based edition — nothing like switching mode through env.

## Tests

```bash
npm test
```

274 tests across 16 suites, using Node's built-in runner — no test framework dependency. Runs serially (`--test-concurrency=1`) because the loader suite writes real temporary files into `commands/`.

| suite | covers |
|---|---|
| `test/database.test.js` | per-bot isolation, sparse storage, concurrency across awaits, atomic writes, corrupt-file quarantine, persistence across a restart |
| `test/hooks.test.js` | the five moderation hooks — fires when enabled, inert when not, and stays per bot |
| `test/dispatch.test.js` | `.ping` / `.uptime` and aliases, removed commands falling through silently, bot-mode gating |
| `test/loader.test.js` | command discovery, alias shadowing, fault tolerance, hot reload through the live dispatch table |
| `test/structure.test.js` | whole-repo invariants: syntax, module graph, dependency hygiene, no committed secrets |
| `test/logging.test.js` | libsignal's session churn staying silenced while decrypt failures still print — driven against the real libsignal `SessionRecord` |
| `test/startup.test.js` | the paired-bot startup card (prefix, owner, platform, counts) and the single-source platform detection behind `global.platform` |
| `test/clean.test.js` | `.clean` reading the antidelete replay cache: newest-first deletion, reply-narrows-to-one-sender, bad-input rejection, and that the module requires no entry point and never ends the process |
| `test/dev-commands.test.js` | the process commands: silence for every non-allowed sender (no reply, no reaction), the `@lid`/`participantAlt` match, `.upgrade` refusing to exit with no loader, `.shutdown` closing every socket then exiting `45`, and `.restart` reconnecting one bot while never calling `process.exit` |

`test/structure.test.js` is the one worth reading if you change the build. It exists because two npm scripts pointed at files that were not in the repo, and nothing caught it:

- **only `.upgrade` and `.shutdown` can end the process** — checked transitively through local `require()`s, so a command that requires a helper that exits is still a command that exits (that is how `.clean` used to reach `index.js`'s exit sites); and neither of the two may call `process.exit()` directly, so the exit codes cannot drift from `platform/loader.js`
- no command may require `index.js`: it runs the platform at require time, exports nothing, and is the one edge that puts every `process.exit` in the entry point within a command's reach
- every script naming a file must point at one that exists
- no file may be unreachable from `index.js` or `commands/` — walked to a fixpoint, because a file referenced only by other dead files is still dead
- no relative `require()` may point at a missing file, except the three optional game modules resolved through `optionalModule()`
- every `database.*` access in live code must resolve to a real export
- no credential-shaped strings anywhere in the repo, with one narrow
  documented exception: the shared Telegram token in
  `commands/general/telegramsticker.js`. That token belongs to a purpose-made
  bot (`@tokenOne222Bot`) and ships on purpose so `.tgs` works on any
  deployment with no setup. The carve-out is one exact value in one exact file —
  any *other* credential-shaped string still fails the test, which
  `test/structure.test.js` also asserts.

Two helpers, `test/_child-reload.js` and `test/_child-exit.js`, are spawned as separate processes to test restart persistence and the exit-flush path. They `process.exit(0)` when run with no arguments, because the Node runner treats *every* `.js` file inside a directory named `test/` as a test file and therefore executes them directly as well — without the `dataDir` their real caller passes. `test/structure.test.js` asserts that stays true.

The suite needs no network and no WhatsApp account: the socket is a recording mock at the edge, and Baileys' `downloadContentFromMessage` is stubbed through a `require.cache` proxy (it is an ESM live binding, so it cannot be monkey-patched).

## License MIT
