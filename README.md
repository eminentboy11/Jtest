# June X Dashboard Edition

A web-managed, multi-session WhatsApp bot platform built on Baileys.

- Public visitors provision a bot through QR or pairing code at `/`.
- Developers manage the fleet through the password-protected `/dev` control room.
- The existing June X multi-session engine remains responsible for sockets,
  authentication, databases, pairing and reconciliation.
- WhatsApp fleet-management commands are not part of this edition.

## Architecture

```text
Public pairing gateway          Developer control room
/                               /dev
        │                            │
        └──────── sessionService ────┘
                         │
                  SessionManager
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   Baileys socket    SQLite/auth      PG/Mongo mirror
```

`platform/sessionService.js` is the platform's only lifecycle interface. It
supports QR/code provisioning, stop, reconnect, permanent deletion, status and
reconciliation. Public routes, `/dev`, and GC do not manipulate legacy WhatsApp
management commands or raw SessionManager boot internals.

## Features

- QR and phone-number pairing-code provisioning
- Three-code pairing budget with stale-socket and concurrency protection
- Multiple independent sessions per process
- Up to four linked sessions for the same WhatsApp number
- Per-session SQLite auth, settings and runtime state
- Optional PostgreSQL and MongoDB mirrors
- Public slot isolation over WebSocket and polling
- Pairing-slot cancellation and failed-provisioning rollback
- Developer session list, stop, reconnect, permanent delete and GC
- Live developer logs
- Per-IP creation limits and one shared platform capacity
- Developer login throttling and expiring bearer tokens
- WebSocket connection limits and unauthenticated timeouts
- Automatic cleanup of abandoned web pairing sessions

## Requirements

- Node.js 20.9+ recommended (minimum declared runtime remains Node.js 18)
- npm
- FFmpeg for media commands
- Optional PostgreSQL and/or MongoDB for durable remote persistence

## Installation

```bash
git clone https://github.com/eminentboy11/Jtest.git
cd Jtest
npm install
cp .env.example .env
```

Set at minimum:

```env
JUNE_PLATFORM=true
JUNE_SESSIONS=[]
ADMIN_PASSWORD=use-a-long-unique-password
```

Then start:

```bash
npm start
```

Open:

```text
http://localhost:5000/       Public pairing gateway
http://localhost:5000/dev    Developer control room
http://localhost:5000/status Engine status dashboard
http://localhost:5000/health Health check
```

## Public API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/` | Pairing page |
| `POST` | `/api/slots` | Create a QR/code pairing slot |
| `GET` | `/api/slots/:slotId` | Poll slot status |
| `POST` | `/api/slots/:slotId/code` | Request another pairing code |
| `DELETE` | `/api/slots/:slotId` | Cancel and clean up an unpaired slot |

Slot IDs are random bearer capabilities. Pairing API responses are marked
`Cache-Control: no-store`.

## Developer API

Login with `ADMIN_PASSWORD` at `/dev`. Successful login issues an in-memory,
eight-hour bearer token.

The developer control room can:

- inspect platform/session/slot status;
- stop a session while preserving authentication;
- reconnect or repair a session;
- permanently delete a session and its scoped artifacts;
- expire pairing slots;
- run garbage collection;
- inspect live logs.

Login failures are rate-limited per resolved client IP. Developer WebSockets
revalidate token expiry and enforce global/per-IP connection limits.

## Capacity

`PLATFORM_MAX_BOTS` is the canonical Dashboard Edition capacity and applies to
both QR and pairing-code provisioning. `JUNE_MAX_SESSIONS` is retained only as
a backward-compatible fallback when `PLATFORM_MAX_BOTS` is not set.

```env
PLATFORM_MAX_BOTS=30
JUNE_MAX_SESSIONS=30
```

Per-number WhatsApp linked-device limit:

```text
phone
phone-2
phone-3
phone-4
```

## Persistence

SQLite remains the local source of truth. Runtime databases and authentication
files are deliberately excluded from Git.

Ignored runtime locations include:

```text
database/
session/
sessions/
data/platform-registry.json
.env
```

For durable deployments, configure PostgreSQL and/or MongoDB:

```env
DATABASE_URL=postgres://...
MONGODB_URI=mongodb+srv://...
```

The web-session metadata registry uses `PLATFORM_MONGODB_URI`, then
`MONGODB_URI`, and otherwise an atomically written local JSON file.

On process restart, active web-managed registry records are rehydrated into the
engine before SessionManager registration. Each bot then independently restores
its local or PostgreSQL/MongoDB auth snapshot and reconnects. Missing/invalid
auth becomes `needs-login` without blocking healthy peer sessions.

The retained owner command `.restart` reconnects only the current WhatsApp
session through `sessionService`; it never exits the shared Node.js process.

## Important environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Unlocks `/dev` |
| `PLATFORM_MAX_BOTS` | Shared QR/code fleet capacity |
| `PLATFORM_CREATES_PER_HOUR` | Public creations per IP per hour |
| `PLATFORM_SLOT_TTL_MIN` | Pairing slot lifetime |
| `PLATFORM_LOGIN_ATTEMPTS` | Failed `/dev` attempts before blocking |
| `PLATFORM_LOGIN_WINDOW_MIN` | Login failure window |
| `PLATFORM_LOGIN_BLOCK_MIN` | Login block duration |
| `PLATFORM_MAX_WS_CONNECTIONS` | Global WebSocket cap |
| `PLATFORM_MAX_WS_PER_IP` | Per-IP WebSocket cap |
| `PLATFORM_WS_AUTH_TIMEOUT_SEC` | Time to authenticate/select a slot |
| `PLATFORM_TRUST_PROXY_HOPS` | Explicit trusted reverse-proxy hop count |
| `JUNE_SESSIONS` | Internal session registry; `[]` is valid |
| `JUNE_PAIRING_MAX_ATTEMPTS` | Pairing-code cap, default 3 |
| `DATABASE_URL` | PostgreSQL mirror |
| `MONGODB_URI` | MongoDB mirror |
| `PLATFORM_MONGODB_URI` | Optional dedicated platform registry MongoDB |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram sticker command integration |
| `OPENWEATHER_API_KEY` | Optional weather command integration |

See `.env.example` for the complete template.

## Reverse proxy configuration

The platform does not blindly trust `X-Forwarded-For`.

- Render, Heroku and Railway default to one trusted proxy hop.
- Direct local/VPS deployments default to no trusted proxy.
- Custom proxy chains must set `PLATFORM_TRUST_PROXY_HOPS` explicitly.

## Tests

```bash
node --test test/*.test.js
```

Current test coverage includes:

- QR and pairing-code provisioning
- failed-provisioning rollback
- public cancellation
- two-session isolation
- stop and reconnect
- permanent deletion
- zero-session startup
- adapter unregister
- shared capacity
- login throttling
- trusted proxy behavior
- no-store responses
- WebSocket security controls
- atomic registry persistence
- embedded-secret regression checks

## Security notes

- Never commit `.env`, SQLite databases, WAL/SHM files or session directories.
- Rotate any credential that was previously committed to repository history.
- Use a unique, high-entropy `ADMIN_PASSWORD`.
- Restrict `/dev` at the reverse proxy as defense in depth where possible.
- Review `npm audit` regularly; some legacy media dependencies may require
  replacement rather than safe in-place upgrades.

## License and credits

- Original June X Ultra: Supreme
- Multi-session and Dashboard Edition: this project
- Core libraries: Baileys, Express, better-sqlite3, PostgreSQL, MongoDB

License: MIT
