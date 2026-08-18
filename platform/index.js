/**
 * June X Platform — bootstrap. attachPlatform(app, server) mounts:
 *   - public pairing gateway routes (/)
 *   - developer control room (/dev, always token-authed)
 *   - one WebSocket server with two client roles:
 *       public: { type:'watch_slot', slotId }  -> that slot's events only
 *       dev:    { type:'auth', token }         -> logs + slot/session events
 */

'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const bridge = require('./bridge');
const logStore = require('./logStore');
const slots = require('./slots');
const registry = require('./registry');
const sessions = require('./sessions');
const { router: publicRouter } = require('./publicRoutes');
const { router: devRouter, checkToken, tokenExpiry } = require('./devRoutes');
const { configureTrustProxy, resolveUpgradeIp } = require('./clientIp');
const { positiveInt } = require('./limits');

let activeWss = null;
const MAX_WS_CONNECTIONS = positiveInt(process.env.PLATFORM_MAX_WS_CONNECTIONS, 150);
const MAX_WS_PER_IP = positiveInt(process.env.PLATFORM_MAX_WS_PER_IP, 10);
const WS_AUTH_TIMEOUT_MS = positiveInt(process.env.PLATFORM_WS_AUTH_TIMEOUT_SEC, 15) * 1000;
const wsCountsByIp = new Map();

async function attachPlatform(app, server) {
    if (!bridge.platformEnabled) {
        console.log('[ PLATFORM ] Disabled via JUNE_PLATFORM=false — plain multi-session mode.');
        return null;
    }

    const trustedHops = configureTrustProxy(app);
    console.log(`[ PLATFORM ] Trusted proxy hops: ${trustedHops}`);
    await registry.init();
    sessions.wireBridge();
    sessions.startGC();

    app.disable('x-powered-by');
    app.use((_req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'DENY');
        res.set('Referrer-Policy', 'no-referrer');
        res.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.set('Content-Security-Policy', [
            "default-src 'self'",
            "base-uri 'self'",
            "frame-ancestors 'none'",
            "object-src 'none'",
            "form-action 'self'",
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self' 'unsafe-inline'",
            "connect-src 'self' ws: wss:",
        ].join('; '));
        next();
    });
    app.use(express.json({ limit: '1mb' }));
    app.use(publicRouter);
    app.use(devRouter);

    // ── WebSocket ─────────────────────────────────────────────────────────────
    const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
    activeWss = wss;

    // Slot events -> the slot's watchers (public) + all dev clients
    slots.subscribe((event) => {
        const msg = JSON.stringify(event);
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            if (client._isDev && !checkToken(client._devToken)) {
                client.close(4003, 'Developer token expired');
                continue;
            }
            if (client._isDev || client._slotId === event.slotId) client.send(msg);
        }
    });

    // Log events -> dev clients only
    logStore.subscribe((event) => {
        const msg = JSON.stringify(event);
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN || !client._isDev) continue;
            if (!checkToken(client._devToken)) {
                client.close(4003, 'Developer token expired');
                continue;
            }
            client.send(msg);
        }
    });

    wss.on('connection', (ws, req) => {
        const ip = resolveUpgradeIp(req);
        const ipCount = wsCountsByIp.get(ip) || 0;
        if (wss.clients.size > MAX_WS_CONNECTIONS || ipCount >= MAX_WS_PER_IP) {
            ws.close(1013, 'Connection limit reached');
            return;
        }
        wsCountsByIp.set(ip, ipCount + 1);
        ws._isDev = false;
        ws._devToken = null;
        ws._slotId = null;
        ws._cleaned = false;

        const authTimeout = setTimeout(() => {
            if (!ws._isDev && !ws._slotId && ws.readyState === WebSocket.OPEN) {
                ws.close(4001, 'Authentication or slot selection required');
            }
        }, WS_AUTH_TIMEOUT_MS);
        authTimeout.unref?.();

        const heartbeat = setInterval(() => {
            if (ws._isDev && !checkToken(ws._devToken)) {
                ws.close(4003, 'Developer token expired');
                return;
            }
            if (ws._slotId && !slots.get(ws._slotId)) {
                ws.close(4004, 'Pairing slot expired');
                return;
            }
            if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30_000);
        heartbeat.unref?.();

        const cleanup = () => {
            if (ws._cleaned) return;
            ws._cleaned = true;
            clearTimeout(authTimeout);
            clearInterval(heartbeat);
            const count = wsCountsByIp.get(ip) || 0;
            if (count <= 1) wsCountsByIp.delete(ip);
            else wsCountsByIp.set(ip, count - 1);
        };

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);

                if (msg?.type === 'watch_slot' && typeof msg.slotId === 'string') {
                    const slot = slots.get(msg.slotId);
                    if (slot) {
                        ws._slotId = msg.slotId;
                        clearTimeout(authTimeout);
                        ws.send(JSON.stringify({ type: 'slot', slotId: slot.slotId, slot: slots.publicView(slot) }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', error: 'Unknown or expired slot.' }));
                    }
                    return;
                }

                if (msg?.type === 'auth') {
                    const expiry = tokenExpiry(msg.token);
                    if (!expiry) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized or expired token.' }));
                        ws.close(4003, 'Unauthorized');
                        return;
                    }
                    ws._isDev = true;
                    ws._devToken = msg.token;
                    clearTimeout(authTimeout);
                    ws.send(JSON.stringify({ type: 'auth_ok', expiresAt: expiry }));
                    ws.send(JSON.stringify({ type: 'log_snapshot', logs: logStore.getLogs(200) }));
                }
            } catch (_) {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'Malformed message.' }));
            }
        });

        ws.on('close', cleanup);
        ws.on('error', cleanup);
    });

    console.log('[ PLATFORM ] Mounted — public pairing gateway at /  ·  dev control room at /dev');
    if (!process.env.ADMIN_PASSWORD) {
        console.log('[ PLATFORM ] ⚠️ ADMIN_PASSWORD is not set — the /dev panel stays locked until you set it in .env');
    }
    return wss;
}

async function shutdownPlatform() {
    sessions.stopGC();
    if (activeWss) {
        for (const client of activeWss.clients) {
            try { client.terminate(); } catch (_) {}
        }
        try { activeWss.close(); } catch (_) {}
        activeWss = null;
    }
    wsCountsByIp.clear();
    await registry.close();
}

module.exports = { attachPlatform, shutdownPlatform, bridge };
