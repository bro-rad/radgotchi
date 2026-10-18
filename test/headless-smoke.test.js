'use strict';

// Boots headless.js against a throwaway data dir and exercises the HTTP
// surface: login, auth enforcement, the static allowlist, the API, and the
// WebSocket handshake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

async function waitForServer(base, child) {
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error(`headless.js exited with ${child.exitCode}`);
        try {
            await fetch(base);
            return;
        } catch (_) {
            await new Promise(r => setTimeout(r, 100));
        }
    }
    throw new Error('headless.js did not start listening');
}

function wsHandshake(port, headers) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            const lines = [
                'GET /ws HTTP/1.1',
                `Host: 127.0.0.1:${port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Version: 13',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
                '', '',
            ];
            socket.write(lines.join('\r\n'));
        });
        let data = '';
        socket.on('data', chunk => {
            data += chunk;
            if (data.includes('\r\n')) {
                socket.destroy();
                resolve(data.split('\r\n')[0]);
            }
        });
        socket.on('close', () => resolve(data.split('\r\n')[0] || 'closed'));
        socket.on('error', reject);
    });
}

test('headless web server', async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radgotchi-smoke-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, ['headless.js', `--port=${port}`], {
        cwd: ROOT,
        env: { ...process.env, RADGOTCHI_DATA_DIR: dataDir, RADGOTCHI_WEB_TOKEN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    t.after(() => child.kill('SIGKILL'));

    await waitForServer(base, child);
    const token = fs.readFileSync(path.join(dataDir, 'web-token'), 'utf-8').trim();
    const cookie = `rg_token=${token}`;

    await t.test('prints a login URL and binds to localhost only', () => {
        assert.match(output, new RegExp(`http://localhost:${port}/\\?token=`));
        assert.doesNotMatch(output, /Network:/);
    });

    await t.test('rejects unauthenticated requests', async () => {
        for (const p of ['/', '/settings', '/src/chat/main.js']) {
            assert.equal((await fetch(base + p)).status, 401, p);
        }
        const res = await fetch(`${base}/api/invoke`, {
            method: 'POST',
            body: JSON.stringify({ channel: 'get-llm-config' }),
        });
        assert.equal(res.status, 401);
    });

    await t.test('serves the manifest and favicon without auth', async () => {
        assert.equal((await fetch(`${base}/manifest.json`)).status, 200);
        assert.equal((await fetch(`${base}/favicon.ico`)).status, 200);
    });

    await t.test('exchanges ?token= for a cookie', async () => {
        const bad = await fetch(`${base}/?token=wrong`, { redirect: 'manual' });
        assert.equal(bad.status, 401);

        const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
        assert.equal(res.status, 302);
        assert.equal(res.headers.get('location'), '/');
        assert.match(res.headers.get('set-cookie'), /rg_token=.*HttpOnly/);
    });

    await t.test('serves the UI when authenticated', async () => {
        const res = await fetch(base, { headers: { cookie } });
        assert.equal(res.status, 200);
        assert.match(await res.text(), /web-bridge\.js/);
        assert.equal((await fetch(`${base}/src/chat/main.js`, { headers: { cookie } })).status, 200);
    });

    await t.test('serves the settings page and its assets', async () => {
        const res = await fetch(`${base}/settings`, { headers: { cookie } });
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.match(html, /data-web-mode="true"/);
        assert.match(html, /web-bridge\.js/);
        for (const asset of ['/src/styles/settings.css', '/src/settings/settings.js']) {
            assert.match(html, new RegExp(asset.slice(1).replace(/\./g, '\\.')));
            assert.equal((await fetch(base + asset, { headers: { cookie } })).status, 200, asset);
        }
    });

    await t.test('reload-skills keeps dangerous skills hidden', async () => {
        const res = await fetch(`${base}/api/invoke`, {
            method: 'POST', headers: { cookie }, body: JSON.stringify({ channel: 'reload-skills' }),
        });
        const result = await res.json();
        assert.equal(result.success, true);
        assert.ok(result.names.includes('web_search'));
        assert.ok(!result.names.includes('run_command'));
    });

    await t.test('never serves files outside src/ and assets/', async () => {
        for (const p of ['/.env', '/.git/config', '/package.json', '/skills/run-command.md']) {
            assert.equal((await fetch(base + p, { headers: { cookie } })).status, 404, p);
        }
    });

    await t.test('API works with cookie or bearer, and blocks cross-origin POSTs', async () => {
        const body = JSON.stringify({ channel: 'get-needs' });
        const ok = await fetch(`${base}/api/invoke`, { method: 'POST', headers: { cookie }, body });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('access-control-allow-origin'), null);

        const bearer = await fetch(`${base}/api/invoke`, {
            method: 'POST', headers: { authorization: `Bearer ${token}` }, body,
        });
        assert.equal(bearer.status, 200);

        const cross = await fetch(`${base}/api/invoke`, {
            method: 'POST', headers: { cookie, origin: 'http://evil.example' }, body,
        });
        assert.equal(cross.status, 403);
    });

    await t.test('rejects malformed and oversized bodies without crashing', async () => {
        for (const body of ['null', '42', 'not json']) {
            const res = await fetch(`${base}/api/invoke`, { method: 'POST', headers: { cookie }, body });
            assert.equal(res.status, 400, body);
        }

        const huge = await fetch(`${base}/api/invoke`, {
            method: 'POST', headers: { cookie }, body: 'x'.repeat(17 * 1024 * 1024),
        }).catch(e => e);
        // Either a 413 or a reset connection, depending on when the server cuts it off
        if (!(huge instanceof Error)) assert.equal(huge.status, 413);

        const ok = await fetch(`${base}/api/invoke`, {
            method: 'POST', headers: { cookie }, body: JSON.stringify({ channel: 'get-needs' }),
        });
        assert.equal(ok.status, 200);
    });

    await t.test('WebSocket requires auth and same origin', async () => {
        assert.match(await wsHandshake(port, { Cookie: cookie }), /101/);
        assert.doesNotMatch(await wsHandshake(port, {}), /101/);
        assert.doesNotMatch(
            await wsHandshake(port, { Cookie: cookie, Origin: 'http://evil.example' }),
            /101/,
        );
    });

    // Windows has no catchable SIGTERM; child.kill() terminates immediately
    await t.test('saves state on SIGTERM', { skip: process.platform === 'win32' }, async () => {
        const exited = new Promise(resolve => child.on('exit', resolve));
        child.kill('SIGTERM');
        assert.equal(await exited, 0);
        assert.ok(fs.existsSync(path.join(dataDir, 'xp-data.json')));
        assert.ok(fs.existsSync(path.join(dataDir, 'chat-data.json')));
    });
});
