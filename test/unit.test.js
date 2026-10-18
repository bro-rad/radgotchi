'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveStaticPath } = require('../src/main/web-server');
const bootstrap = require('../src/main/bootstrap');
const skillLoader = require('../src/main/skill-loader');
const xpSystem = require('../src/main/xp-system');
const persistence = require('../src/main/persistence');

const ROOT = path.join(__dirname, '..');

// ── Static file allowlist ────────────────────────────────────────────────

test('resolveStaticPath serves files under src/ and assets/', () => {
    assert.equal(resolveStaticPath('/src/chat/main.js'), path.join(ROOT, 'src/chat/main.js'));
    assert.equal(resolveStaticPath('/assets/gotchi/AWAKE.png'), path.join(ROOT, 'assets/gotchi/AWAKE.png'));
});

test('resolveStaticPath refuses everything else', () => {
    const blocked = [
        '/.env',
        '/.git/config',
        '/package.json',
        '/skills/run-command.md',
        '/node_modules/electron/package.json',
        '/src',
        '/src/../.env',
        '/src/%2e%2e/.env',
        '/assets/..%2f..%2f.env',
        '/src/%00.js',
        '/src/.hidden',
        '/%E0%A4%A',
    ];
    for (const p of blocked) {
        assert.equal(resolveStaticPath(p), null, p);
    }
});

// ── CLI args ─────────────────────────────────────────────────────────────

test('parseWebArgs defaults to localhost:7777', () => {
    assert.deepEqual(bootstrap.parseWebArgs([]), { port: 7777, host: '127.0.0.1' });
});

test('parseWebArgs reads --port and --host', () => {
    assert.deepEqual(
        bootstrap.parseWebArgs(['node', 'x', '--port=3000', '--host=0.0.0.0']),
        { port: 3000, host: '0.0.0.0' },
    );
});

test('parseWebArgs rejects invalid ports', () => {
    for (const bad of ['--port=abc', '--port=0', '--port=70000', '--port=12.5']) {
        assert.throws(() => bootstrap.parseWebArgs([bad]), /Invalid port/, bad);
    }
});

// ── Skills ───────────────────────────────────────────────────────────────

test('dangerous skills are hidden and refused when disabled', async () => {
    skillLoader.init({ isPackaged: false });
    skillLoader.loadSkills();
    const names = () => skillLoader.getToolDefinitions().map(t => t.function.name);

    try {
        skillLoader.setDangerousToolsEnabled(true);
        assert.ok(names().includes('run_command'));
        assert.ok(names().includes('create_file'));

        skillLoader.setDangerousToolsEnabled(false);
        assert.ok(!names().includes('run_command'));
        assert.ok(!names().includes('create_file'));
        assert.ok(names().includes('web_search'));

        const result = await skillLoader.executeToolCall('run_command', { command: 'echo hi' });
        assert.match(result.error, /disabled/);
    } finally {
        skillLoader.setDangerousToolsEnabled(true);
    }
});

// ── XP math ──────────────────────────────────────────────────────────────

test('calculateLevel is monotonic and keeps growing past the threshold table', () => {
    assert.equal(xpSystem.calculateLevel(0), 1);
    let prev = 1;
    for (let xp = 0; xp <= 500000; xp += 250) {
        const level = xpSystem.calculateLevel(xp);
        assert.ok(level >= prev, `level dropped at ${xp} xp`);
        prev = level;
    }
    assert.ok(prev > 21);
});

test('getRank returns the highest rank whose minLevel is reached', () => {
    for (const rank of xpSystem.RANKS) {
        assert.equal(xpSystem.getRank(rank.minLevel).minLevel, rank.minLevel);
    }
    assert.equal(xpSystem.getRank(0), xpSystem.RANKS[0]);
});

// ── Persistence ──────────────────────────────────────────────────────────

test('getWindowState returns non-window state without a screen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radgotchi-persist-'));
    fs.writeFileSync(path.join(dir, 'window-states.json'), JSON.stringify({
        networkDiscovery: { enabled: true },
        main: { x: 10, y: 20, width: 100, height: 100, zoom: 120 },
    }));
    persistence.init({ isPackaged: false, getPath: () => dir }, null);
    persistence.loadWindowStates();

    assert.deepEqual(persistence.getWindowState('networkDiscovery', {}), { enabled: true });
    assert.equal(persistence.getWindowState('main', {}).zoom, 120);
    assert.deepEqual(persistence.getWindowState('missing', { a: 1 }), { a: 1 });
});
