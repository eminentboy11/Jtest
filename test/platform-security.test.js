'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ratelimit = require('../platform/ratelimit');

test('developer login failures are blocked and can be cleared', () => {
  const key = `login-test-${Date.now()}`;
  assert.equal(ratelimit.loginStatus(key).ok, true);
  const attempts = ratelimit.stats().loginProtection.attempts;
  let result;
  for (let i = 0; i < attempts; i += 1) result = ratelimit.recordLoginFailure(key);
  assert.equal(result.ok, false);
  assert.ok(result.retryAfterMs > 0);
  ratelimit.clearLoginFailures(key);
  assert.equal(ratelimit.loginStatus(key).ok, true);
});

test('untrusted direct requests ignore spoofed X-Forwarded-For', () => {
  const previous = process.env.PLATFORM_TRUST_PROXY_HOPS;
  delete process.env.PLATFORM_TRUST_PROXY_HOPS;
  const clientIp = require('../platform/clientIp');
  const fakeApp = { set(_key, value) { this.value = value; } };
  clientIp.configureTrustProxy(fakeApp);
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.5' } };
  assert.equal(clientIp.resolveUpgradeIp(req), '10.0.0.5');
  assert.equal(fakeApp.value, false);
  if (previous !== undefined) process.env.PLATFORM_TRUST_PROXY_HOPS = previous;
});

test('one trusted proxy selects the nearest untrusted client, not spoofed leftmost input', () => {
  const previous = process.env.PLATFORM_TRUST_PROXY_HOPS;
  process.env.PLATFORM_TRUST_PROXY_HOPS = '1';
  const clientIp = require('../platform/clientIp');
  const fakeApp = { set(_key, value) { this.value = value; } };
  clientIp.configureTrustProxy(fakeApp);
  const req = {
    headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
    socket: { remoteAddress: '10.0.0.5' },
  };
  assert.equal(clientIp.resolveUpgradeIp(req), '203.0.113.9');
  assert.equal(fakeApp.value, 1);
  if (previous === undefined) delete process.env.PLATFORM_TRUST_PROXY_HOPS;
  else process.env.PLATFORM_TRUST_PROXY_HOPS = previous;
});

test('pairing and developer responses are explicitly non-cacheable', () => {
  for (const file of ['publicRoutes.js', 'devRoutes.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'platform', file), 'utf8');
    assert.match(source, /Cache-Control/);
    assert.match(source, /no-store/);
  }
});

test('WebSocket control plane has limits, unauthenticated timeout and token revalidation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'platform', 'index.js'), 'utf8');
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /X-Content-Type-Options/);
  assert.match(source, /PLATFORM_MAX_WS_CONNECTIONS/);
  assert.match(source, /PLATFORM_MAX_WS_PER_IP/);
  assert.match(source, /WS_AUTH_TIMEOUT_MS/);
  assert.match(source, /Developer token expired/);
  assert.match(source, /tokenExpiry\(msg\.token\)/);
});

test('file platform registry flushes atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'june-platform-registry-'));
  const modulePath = path.join(__dirname, '..', 'platform', 'registry.js');
  const script = `
    delete process.env.MONGODB_URI;
    delete process.env.PLATFORM_MONGODB_URI;
    const registry = require(${JSON.stringify(modulePath)});
    (async () => {
      await registry.init();
      await registry.trackSession('web-test', { mode: 'qr', ipHash: 'hash' });
      if (!registry.flush()) process.exit(2);
      await registry.close();
    })().catch(() => process.exit(3));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(dir, 'data', 'platform-registry.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.sessions['web-test'].botId, 'web-test');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp-')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('developer delete-all requires explicit confirmation and is exposed in the admin UI', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'platform', 'devRoutes.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'platform', 'public', 'dev.html'), 'utf8');
  assert.match(routes, /router\.delete\('\/dev\/api\/sessions'/);
  assert.match(routes, /confirmation[^\n]+DELETE ALL/);
  assert.match(routes, /sessionService\.removeAll/);
  assert.match(page, /id="deleteAllBotsBtn"/);
  assert.match(page, /Type DELETE ALL/);
});

test('developer session actions do not interpolate ids into inline JavaScript', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'platform', 'public', 'dev.html'), 'utf8');
  assert.doesNotMatch(source, /onclick="dev(?:Act|Del|SlotKill)/);
  assert.match(source, /data-session-action/);
  assert.match(source, /data-slot-id/);
});

test('known embedded Telegram and weather credentials are absent from source', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const telegram = fs.readFileSync(path.join(__dirname, '..', 'commands', 'general', 'telegramsticker.js'), 'utf8');
  const weather = fs.readFileSync(path.join(__dirname, '..', 'commands', 'utility', 'weather.js'), 'utf8');
  assert.doesNotMatch(config + telegram, /\d{8,12}:AA[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(weather, /apiKey\s*=\s*['"][a-f0-9]{32}['"]/i);
  assert.match(config + telegram, /TELEGRAM_BOT_TOKEN/);
  assert.match(weather, /OPENWEATHER_API_KEY/);
});
