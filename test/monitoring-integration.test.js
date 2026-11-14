'use strict';
// Acceptance of EXISTING behavior, not a feature RED/GREEN cycle.
// SYNTHETIC loopback-only public inventory; never reads real node data or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const vm = require('node:vm');
const { createMonitoringServer } = require('../src/main/monitoring-server');

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
// DOM boundary only: production JS, production HTTP handlers and fetch stay real.
// This intentionally does not claim layout, CSS rendering or browser validation.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.value = ''; this.hidden = false; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unexpected HTML sink'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.value = ''; this.children = children; }
}

test('real monitoring HTTP + served production panel: connected, stale, unauthorized and static assets (synthetic DOM harness)', { timeout: 15000 }, async t => {
  const token = randomBytes(32).toString('hex'); // Ephemeral; never print it.
  const rows = [
    { name: 'SYNTHETIC-alpha.dnp.dappnode.eth', version: '1.0.0', state: 'running', ip: '192.0.2.10' },
    { name: 'SYNTHETIC-alpha.dnp.dappnode.eth', version: '1.1.0', state: 'exited', ip: '192.0.2.11' },
    { name: 'SYNTHETIC-beta.dnp.dappnode.eth', version: '2.0.0', state: 'running', ip: '2001:db8::10' }
  ];
  const upstreamRequests = [];
  const upstream = http.createServer((req, res) => {
    upstreamRequests.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  t.after(() => close(upstream));
  const inventoryOrigin = await listen(upstream);
  // Reserve an ephemeral port so production Host/Origin enforcement uses the real URL.
  // Fail rather than silently changing origin if another process wins the close/listen race.
  const reservation = http.createServer();
  t.after(() => close(reservation));
  const origin = await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const server = createMonitoringServer({ token, origin, inventoryUrl: inventoryOrigin + '/SYNTHETIC-public-inventory', cacheMs: 0, fetchTimeoutMs: 500 });
  t.after(() => close(server));
  await listen(server, port);
  const request = (route, init) => fetch(new URL(route, origin), init);

  const loginPage = await request('/login');
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /form method="post" action="\/login"/);
  const login = await request('/login', {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const setCookie = login.headers.get('set-cookie');
  // Boolean assertions avoid ever printing session/token material on failure.
  assert.ok(Boolean(setCookie && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict')));
  assert.ok(!setCookie.includes(token));
  let cookie = setCookie.split(';')[0];
  await login.arrayBuffer();

  const htmlResponse = await request('/');
  assert.equal(htmlResponse.status, 200);
  assert.match(htmlResponse.headers.get('content-type'), /^text\/html/);
  const html = await htmlResponse.text();
  assert.match(html, /href="\/login"/);
  const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1]).filter(url => url !== '/login');
  assert.ok(assets.includes('/src/web/monitoring-panel.js'));
  assert.ok(assets.includes('/src/styles/monitoring.css'));
  assert.ok(assets.includes('/assets/gotchi/AWAKE.png'));
  let source;
  for (const asset of new Set(assets)) {
    assert.ok(asset.startsWith('/'), 'shell must use local assets');
    const response = await request(asset);
    assert.equal(response.status, 200, asset);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 0, asset);
    if (asset.endsWith('.js')) {
      assert.match(response.headers.get('content-type'), /^text\/javascript/);
      if (asset === '/src/web/monitoring-panel.js') source = bytes.toString();
    } else if (asset.endsWith('.css')) {
      assert.match(response.headers.get('content-type'), /^text\/css/);
      if (asset === '/src/styles/monitoring.css') assert.match(bytes.toString(), /:focus-visible/);
    } else if (asset.endsWith('.png')) {
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    } else assert.fail('Unexpected static asset type');
  }
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element('div')]));
  elements['login-link'].hidden = true;
  const timers = new Map();
  let nextTimer = 0;
  const responses = [];
  const context = {
    document: { getElementById: id => elements[id], createElement: tag => new Element(tag) },
    AbortController, Date,
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(route, init) {
      assert.equal(route, '/api/monitoring/package-status');
      assert.equal(init.method, 'GET');
      assert.equal(init.credentials, 'same-origin');
      const response = await request(route, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) } });
      responses.push({ status: response.status, body: await response.clone().json() });
      return response;
    }
  };
  vm.runInNewContext(source, context, { filename: 'HTTP-served-monitoring-panel.js' });
  const panel = context.RadgotchiMonitoring;
  t.after(() => panel.stop());
  async function nextPoll() {
    const polls = [...timers.entries()].filter(([, scheduled]) => scheduled.delay === 30000);
    assert.equal(polls.length, 1);
    const [id, scheduled] = polls[0];
    assert.equal(scheduled.delay, 30000);
    timers.delete(id);
    await scheduled.fn();
  }
  await panel.start();
  const good = responses.at(-1);
  assert.equal(good.status, 200);
  assert.equal(good.body.sourceStatus, 'connected');
  assert.equal(good.body.reportedRows, 3);
  assert.equal(good.body.coverage, 'package-status-only');
  assert.equal(good.body.containerIdentityAvailable, false);
  assert.deepEqual(good.body.packages, [
    { name: rows[0].name, versions: ['1.0.0', '1.1.0'], reportedRows: 2, states: { running: 1, exited: 1 } },
    { name: rows[2].name, versions: ['2.0.0'], reportedRows: 1, states: { running: 1 } }
  ]);
  assert.ok(Number.isFinite(Date.parse(good.body.lastSuccessAt)));
  assert.equal(elements['package-list'].children.length, 2);
  assert.match(elements['source-status'].textContent, /connected/);
  assert.match(elements['reported-rows'].textContent, /3/);
  const rendered = elements['package-list'].textContent;
  for (const text of ['SYNTHETIC-alpha', 'SYNTHETIC-beta', '1.0.0, 1.1.0', 'running: 1', 'exited: 1']) assert.ok(rendered.includes(text));
  for (const row of rows) {
    assert.ok(!JSON.stringify(good.body).includes(row.ip));
    assert.ok(!rendered.includes(row.ip));
  }
  assert.deepEqual(upstreamRequests, [{ path: '/SYNTHETIC-public-inventory', cookie: undefined, authorization: undefined }]);

  // Real connection refusal, not a mocked fetch or synthetic stale API response.
  await close(upstream);
  await nextPoll();
  const stale = responses.at(-1);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.sourceStatus, 'stale');
  assert.deepEqual(stale.body.packages, good.body.packages);
  assert.equal(stale.body.lastSuccessAt, good.body.lastSuccessAt);
  assert.equal(elements['package-list'].textContent, rendered);
  assert.match(elements['source-status'].textContent, /stale/);
  assert.match(elements['request-status'].textContent, /Stale.*Last successful/i);

  cookie = ''; // Simulated lost session; backend must actually return HTTP 401.
  await nextPoll();
  assert.equal(responses.at(-1).status, 401);
  assert.equal(elements['package-list'].textContent, '');
  assert.equal(elements['login-link'].hidden, false);
  assert.match(elements['request-status'].textContent, /Login required/);
  assert.equal(elements['reported-rows'].textContent, '—');
  assert.equal(timers.size, 0);
  await close(server);
  assert.equal(server.listening, false);
  assert.equal(upstream.listening, false);
});
