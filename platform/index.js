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
const { router: devRouter, checkToken } = require('./devRoutes');

async function attachPlatform(app, server) {
    if (!bridge.platformEnabled) {
        console.log('[ PLATFORM ] Disabled via JUNE_PLATFORM=false — plain multi-session mode.');
        return null;
    }

    await registry.init();
    sessions.wireBridge();
    sessions.startGC();

    app.use(express.json({ limit: '1mb' }));
    app.use(publicRouter);
    app.use(devRouter);

    // ── WebSocket ─────────────────────────────────────────────────────────────
    const wss = new WebSocketServer({ server, maxPayload: 512 * 1024 });

    // Slot events -> the slot's watchers (public) + all dev clients
    slots.subscribe((event) => {
        const msg = JSON.stringify(event);
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            if (client._isDev || client._slotId === event.slotId) client.send(msg);
        }
    });

    // Log events -> dev clients only
    logStore.subscribe((event) => {
        const msg = JSON.stringify(event);
        for (const client of wss.clients) {
            if (client.readyState !== WebSocket.OPEN || !client._isDev) continue;
            client.send(msg);
        }
    });

    wss.on('connection', (ws) => {
        ws._isDev = false;
        ws._slotId = null;

        const heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30_000);
        heartbeat.unref?.();

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw);

                if (msg?.type === 'watch_slot' && typeof msg.slotId === 'string') {
                    const slot = slots.get(msg.slotId);
                    if (slot) {
                        ws._slotId = msg.slotId;
                        ws.send(JSON.stringify({ type: 'slot', slotId: slot.slotId, slot: slots.publicView(slot) }));
                    } else {
                        ws.send(JSON.stringify({ type: 'error', error: 'Unknown or expired slot.' }));
                    }
                }

                if (msg?.type === 'auth' && checkToken(msg.token)) {
                    ws._isDev = true;
                    ws.send(JSON.stringify({ type: 'auth_ok' }));
                    ws.send(JSON.stringify({ type: 'log_snapshot', logs: logStore.getLogs(200) }));
                }
            } catch (_) { /* ignore malformed frames */ }
        });

        ws.on('close', () => clearInterval(heartbeat));
        ws.on('error', () => clearInterval(heartbeat));
    });

    console.log('[ PLATFORM ] Mounted — public pairing gateway at /  ·  dev control room at /dev');
    if (!process.env.ADMIN_PASSWORD) {
        console.log('[ PLATFORM ] ⚠️ ADMIN_PASSWORD is not set — the /dev panel stays locked until you set it in .env');
    }
    return wss;
}

module.exports = { attachPlatform, bridge };
