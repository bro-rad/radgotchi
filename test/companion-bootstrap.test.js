'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
test('production shell wires local companion modules and packages every new asset exactly', () => {
  const html = fs.readFileSync(path.join(root, 'monitoring.html'), 'utf8');
  const assets = ['src/web/companion-interactions.js','src/web/companion-activities.js','src/web/companion-bootstrap.js','src/styles/companion-interactions.css','src/styles/companion-activities.css','src/web/companion-arcade.js','src/web/companion-transport.js','src/styles/companion-arcade.css','src/web/companion-audio.js','src/web/companion-audio-bootstrap.js'];
  assert.match(html, /id="companion-activities"/);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map(m=>m[1]), ['/src/web/monitoring-panel.js','/src/web/companion-interactions.js','/src/web/companion-activities.js','/src/web/companion-transport.js','/src/web/companion-arcade.js','/src/web/companion-bootstrap.js','/src/web/companion-audio.js','/src/web/companion-audio-bootstrap.js']);
  assert.doesNotMatch(html, /<script(?! src=)|\son[a-z]+=/i);
  for (const asset of assets) assert.ok(html.includes('"/'+asset+'"'), asset);
  assert.ok(html.indexOf('monitoring.css') < html.indexOf('companion-interactions.css'));
  const docker = fs.readFileSync(path.join(root, 'packaging/Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, 'packaging/Dockerfile.dockerignore'), 'utf8');
  for (const asset of [...assets,'login.html','src/styles/monitoring-login.css']) {
    assert.ok(docker.includes(asset), asset);
    assert.ok(ignore.split('\n').includes('!'+asset), asset);
  }
});
test('bootstrap tolerates denied storage and cleans up and restores on page lifecycle', () => {
  const events = {}, calls = []; const document = {};
  const context = {document, addEventListener(name, fn) { events[name] = fn; },
    RadgotchiMonitoring: {stop() {calls.push('stop');}, start() {calls.push('start');}}};
  for (const name of ['Interactions','Activities']) context['Radgotchi'+name] = {init(doc, storage) {
    assert.equal(doc,document); assert.equal(storage,undefined); calls.push(name);
    return {destroy() {calls.push('destroy '+name);}};
  }};
  Object.defineProperty(context, 'localStorage', {get() {throw new Error('Denied');}});
  vm.runInNewContext(fs.readFileSync(path.join(root,'src/web/companion-bootstrap.js'),'utf8'), context);
  assert.deepEqual(calls,['Interactions','Activities']);
  events.pageshow(); assert.equal(calls.length,2);
  events.pagehide(); events.pagehide();
  assert.equal(calls.filter(x=>x==='destroy Activities').length,1);
  events.pageshow();
  assert.deepEqual(calls.slice(-3),['Interactions','Activities','start']);
});
