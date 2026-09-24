/**
 * Web Lite — bootstrap, always web, no dev dashboard, no mode switch.
 * Mounts public pairing gateway at / and WS for slot watching only.
 */
'use strict';

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const bridge = require('./bridge');
const slots = require('./slots');
const registry = require('./registry');
const sessions = require('./sessions');
const { router: publicRouter } = require('./publicRoutes');
const { configureTrustProxy, resolveUpgradeIp } = require('./clientIp');
const { positiveInt } = require('./limits');

let activeWss = null;
const MAX_WS_CONNECTIONS = positiveInt(process.env.PLATFORM_MAX_WS_CONNECTIONS, 200);
const MAX_WS_PER_IP = positiveInt(process.env.PLATFORM_MAX_WS_PER_IP, 20);
const WS_AUTH_TIMEOUT_MS = positiveInt(process.env.PLATFORM_WS_AUTH_TIMEOUT_SEC, 15) * 1000;
const wsCountsByIp = new Map();

async function attachPlatform(app, server) {
    const trustedHops = configureTrustProxy(app);
    console.log(`[ PLATFORM ] Trusted proxy hops: ${trustedHops}`);
    await registry.init();
    sessions.wireBridge();
    sessions.startGC();

    app.disable('x-powered-by');
    app.use((_, res, next) => {
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

    const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });
    activeWss = wss;

    slots.subscribe((event) => {
        const msg = JSON.stringify(event);
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            if (client._slotId === event.slotId) client.send(msg);
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
        ws._slotId = null;
        ws._cleaned = false;

        const authTimeout = setTimeout(() => {
            if (!ws._slotId && ws.readyState === WebSocket.OPEN) {
                ws.close(4001, 'Slot selection required');
            }
        }, WS_AUTH_TIMEOUT_MS);
        authTimeout.unref?.();

        const heartbeat = setInterval(() => {
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
            const c = wsCountsByIp.get(ip) || 0;
            if (c <= 1) wsCountsByIp.delete(ip);
            else wsCountsByIp.set(ip, c - 1);
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
                }
            } catch (_) {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: 'Malformed message.' }));
            }
        });

        ws.on('close', cleanup);
        ws.on('error', cleanup);
    });

    console.log('[ PLATFORM ] Mounted — public pairing gateway at / (lite, no /dev)');
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
