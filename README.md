# June X Web — Independent Dashboard Edition

> **⚠️ INDEPENDENT PROJECT NOTICE:** This web version is a **completely different project entirely** — it has **nothing to do with June X family, including any external session server**. All session handling is **self-contained, local, and independent**. No external minting server, no June X family dependency, no `burning-lorena-...koyeb.app` or `JUNE-X~` server flow.

A web-managed, multi-session WhatsApp bot platform built on Baileys — fully independent and self-contained.

- Public visitors provision a bot through QR or pairing code at `/` (local, no external server).
- Developers manage the fleet through the password-protected `/dev` control room.
- Multi-session engine handles sockets, authentication, databases, pairing and reconciliation locally.
- WhatsApp fleet-management commands are not part of this edition — web control only.
- **No June X family, no session server** — everything is local.

## Architecture (Independent)

```text
Public pairing gateway          Developer control room
/                               /dev
        │                            │
        └──────── sessionService ────┘
                         │
                  SessionManager (independent)
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   Baileys socket    SQLite/auth      PG/Mongo mirror (optional)
   (local)           (local)          (local mirror)
```

`platform/sessionService.js` is the platform's only lifecycle interface. It
supports QR/code provisioning, stop, reconnect, permanent deletion, status and
reconciliation — all **self-contained, no external server**. Public routes, `/dev`, and GC do not manipulate legacy WhatsApp
management commands or raw SessionManager boot internals.

## Independence Statement

This project is **fully independent**:
- ❌ No June X family dependency
- ❌ No external session server (`sessionServer.js` removed)
- ❌ No `JUNE-X~` handles minted by external server
- ✅ Self-contained session handling: `JTEST~<base64>` / `WEB-X~<base64>` / `BASE64~<base64>` or raw base64, all local
- ✅ QR and pairing-code provisioning via web gateway at `/` (local)
- ✅ All auth stored locally in `sessions/<id>/` and SQLite `database/june-<id>.db`
- ✅ Optional PostgreSQL/MongoDB mirrors are also local mirrors, not external session server

It is a **completely different project** built for web-managed multi-session WhatsApp bots, using latest June X commands/utils but with independent infrastructure.

## Features (Independent)

- QR and phone-number pairing-code provisioning (local, no external server)
- Three-code pairing budget with stale-socket and concurrency protection
- Multiple independent sessions per process
- Up to four linked sessions for the same WhatsApp number
- Per-session SQLite auth, settings and runtime state (local)
- Optional PostgreSQL and MongoDB mirrors (local mirrors)
- Public slot isolation over WebSocket and polling
- Pairing-slot cancellation and failed-provisioning rollback
- Developer session list, stop, reconnect, permanent delete and GC
- Live developer logs
- Per-IP creation limits and one shared platform capacity
- Developer login throttling and expiring bearer tokens
- WebSocket connection limits and unauthenticated timeouts
- Automatic cleanup of abandoned web pairing sessions
- **No external session server, no June X family**

## Requirements

- Node.js 20.9+ recommended (minimum declared runtime remains Node.js 18)
- npm
- FFmpeg for media commands (auto-provisioned if missing)
- Optional PostgreSQL and/or MongoDB for durable remote persistence (local mirrors)

## Installation (Independent)

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
http://localhost:5000/       Public pairing gateway (independent, no external server)
http://localhost:5000/dev    Developer control room
http://localhost:5000/status Engine status dashboard
http://localhost:5000/health Health check
```

## Public API (Independent)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/` | Pairing page (independent, local QR/code) |
| `POST` | `/api/slots` | Create a QR/code pairing slot (local) |
| `GET` | `/api/slots/:slotId` | Poll slot status |
| `POST` | `/api/slots/:slotId/code` | Request another pairing code |
| `DELETE` | `/api/slots/:slotId` | Cancel and clean up an unpaired slot |

Slot IDs are random bearer capabilities. Pairing API responses are marked
`Cache-Control: no-store`. No external server involved.

## Developer API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/dev/api/login` | Developer login |
| `GET` | `/dev/api/sessions` | List sessions |
| `POST` | `/dev/api/sessions/:id/stop` | Stop a session |
| `POST` | `/dev/api/sessions/:id/reconnect` | Reconnect a session |
| `DELETE` | `/dev/api/sessions/:id` | Permanently delete a session |
| `POST` | `/dev/api/gc` | GC expired slots |

## Session Format (Independent)

This edition uses **independent local formats**, no external server:

- `JTEST~<base64>` — independent, `creds.json` base64, local
- `WEB-X~<base64>` — same, web edition prefix
- `BASE64~<base64>` — generic base64
- Raw base64 (legacy compat)
- Only `JTEST~`, `WEB-X~`, `BASE64~`, or raw base64 accepted — no June X family legacy

All are **self-contained** — no fetch from `burning-lorena-...koyeb.app`, no `JUNE-X~` server flow.

## Multi-Session

See `MULTI_SESSION.md` for full guide — all independent, no external server.

## Tests

```bash
npm test
```

49 tests, all independent, no external server dependency.

## License

MIT — Independent project, no June X family.
