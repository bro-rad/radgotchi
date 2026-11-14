'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
test('portable runner discovers root and packaging files without shell expansion', () => {
  const {discoverTests, testArgs} = require('../../scripts/run-tests.cjs');
  const files = discoverTests(root);
  assert.ok(files.includes(path.join(root,'packaging/test/package.test.cjs')));
  assert.ok(files.includes(path.join(root,'test/monitoring-integration.test.js')));
  assert.ok(files.every(f => /\.test\.(?:js|cjs)$/.test(f)));
  assert.ok(testArgs(files, ['--serial']).includes('--test-concurrency=1'));
  assert.throws(() => testArgs(files, ['--unknown']));
});
test('runtime qualification requires explicit immutable image, current tag and new absolute output', () => {
  assert.match(fs.readFileSync(path.join(__dirname,'../runtime-test.cjs'),'utf8'), /module\.exports = \{validateOptions, ownsContainer\}/);
  const {validateOptions, ownsContainer} = require('../runtime-test.cjs');
  const env = {RADGOTCHI_TEST_IMAGE:'sha256:'+'a'.repeat(64), RADGOTCHI_TEST_TAG:'radgotchi.radgotchi.public.dappnode.eth:0.1.5', RADGOTCHI_TEST_OUTPUT:path.join(root,'unused-evidence.json')};
  assert.equal(validateOptions(env).image,env.RADGOTCHI_TEST_IMAGE);
  for (const key of Object.keys(env)) assert.throws(() => validateOptions({...env,[key]:''}));
  for (const tag of ['radgotchi.public.dappnode.eth:0.1.0','radgotchi.radgotchi.public.dappnode.eth:latest','radgotchi.radgotchi.public.dappnode.eth:0.1.3']) assert.throws(() => validateOptions({...env,RADGOTCHI_TEST_TAG:tag}));
  assert.throws(() => validateOptions({...env,RADGOTCHI_TEST_OUTPUT:__filename}));
  assert.throws(() => validateOptions({...env,RADGOTCHI_TEST_OUTPUT:'relative.json'}));
  const c={Id:'b'.repeat(64),Image:env.RADGOTCHI_TEST_IMAGE,Name:'/owned',Config:{Labels:{'org.radgotchi.qualification':'nonce'}}};
  assert.equal(ownsContainer(c,'owned','nonce',env.RADGOTCHI_TEST_IMAGE),true);
  assert.equal(ownsContainer(c,'other','nonce',env.RADGOTCHI_TEST_IMAGE),false);
  assert.equal(ownsContainer(c,'owned','wrong',env.RADGOTCHI_TEST_IMAGE),false);
});
const entry = path.resolve(__dirname, '../entrypoint.cjs');
test('unconfigured package refuses startup without leaking configuration', () => {
  const result = spawnSync(process.execPath, [entry], {env:{PATH:process.env.PATH},encoding:'utf8',timeout:3000});
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), '[Packaging] Invalid configuration; server not started');
});
const {validateEnvironment} = require('../entrypoint.cjs');
const {randomBytes} = require('node:crypto');
const base = {RADGOTCHI_MONITORING_MODE:'1', RADGOTCHI_MONITORING_ORIGIN:'https://monitor.invalid', RADGOTCHI_MONITORING_TOKEN:randomBytes(32).toString('hex')};
test('only explicit monitoring mode and exact HTTPS origins are accepted', () => {
  assert.doesNotThrow(() => validateEnvironment(base));
  assert.doesNotThrow(() => validateEnvironment({...base,RADGOTCHI_COMPANION_DIR:'/data/companion'}));
  for(const dir of ['/tmp','/data','relative','']) assert.throws(()=>validateEnvironment({...base,RADGOTCHI_COMPANION_DIR:dir}));
  for (const mode of [undefined,'','0','true']) assert.throws(() => validateEnvironment({...base,RADGOTCHI_MONITORING_MODE:mode}));
  for (const origin of [undefined,'','http://127.0.0.1:3000','http://monitor.invalid','https://monitor.invalid/','https://monitor.invalid/path','https://user:pass@monitor.invalid','https://monitor.invalid?x=1']) assert.throws(() => validateEnvironment({...base,RADGOTCHI_MONITORING_ORIGIN:origin}));
});
test('actual launcher retains backend token refusal', () => {
  for (const token of ['', 'not-a-token', 'a'.repeat(64)]) {
    const result=spawnSync(process.execPath,[entry],{env:{PATH:process.env.PATH,...base,RADGOTCHI_MONITORING_TOKEN:token},encoding:'utf8',timeout:3000});
    assert.equal(result.status,2);
    assert.equal(result.stdout,'');
    assert.equal(result.stderr.trim(),'[Monitoring] Invalid configuration; server not started');
  }
});
test('image has narrow dependency-free inputs and retained attribution', () => {
  const fs=require('node:fs');
  const root=path.resolve(__dirname,'../..');
  const dockerfile=fs.readFileSync(path.join(root,'packaging/Dockerfile'),'utf8');
  assert.match(dockerfile,/^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}\n/);
  assert.match(dockerfile,/USER 1000:1000/);
  assert.doesNotMatch(dockerfile,/npm |node_modules|COPY \. /m);
  assert.match(dockerfile,/RUN mkdir -p \/data\/companion && chown -R 1000:1000 \/data && chmod 0700 \/data\/companion/);
  assert.match(dockerfile,/ENV RADGOTCHI_COMPANION_DIR=\/data\/companion/);
  assert.match(dockerfile,/COPY headless.js monitoring.html LICENSE README.md/);
  for (const line of dockerfile.split('\n').filter(line=>line.startsWith('COPY '))) {
    for (const source of line.split(' ').slice(1,-1)) assert.ok(fs.statSync(path.join(root,source)).isFile(),source);
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'packaging/dappnode_package.json')));
  assert.equal(manifest.name,'radgotchi.public.dappnode.eth');
  assert.equal(manifest.version,'0.1.5');
  assert.equal(manifest.links.ui,'https://radgotchi.quantumtekh.com');
  assert.equal(manifest.exposable,undefined);
  const compose=fs.readFileSync(path.join(root,'packaging/docker-compose.yml'),'utf8');
  assert.match(compose,/image: radgotchi\.radgotchi\.public\.dappnode\.eth:0\.1\.5/);
  assert.doesNotMatch(compose,/\b(?:ports|privileged|network_mode|platform):|docker\.sock|exposable/);
  assert.match(compose,/volumes:\n      - companion:\/data\/companion/);
  assert.match(compose,/\nvolumes:\n  companion:/);
  assert.equal((compose.match(/RADGOTCHI_MONITORING_[A-Z_]+:/g)||[]).length,6);
});
