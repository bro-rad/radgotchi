'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const webAuth = require('../src/main/web-auth');

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'radgotchi-auth-'));
}

function req(headers) {
    return { headers };
}

test('token is generated once, persisted with 0600, and reused', () => {
    const dir = tmpDir();
    const first = webAuth.loadOrCreateToken(dir);
    assert.ok(first.length >= 32);

    const tokenPath = path.join(dir, 'web-token');
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    }
    assert.equal(webAuth.loadOrCreateToken(dir), first);
});

test('RADGOTCHI_WEB_TOKEN overrides the stored token', () => {
    process.env.RADGOTCHI_WEB_TOKEN = 'env-token-value';
    try {
        assert.equal(webAuth.loadOrCreateToken(tmpDir()), 'env-token-value');
    } finally {
        delete process.env.RADGOTCHI_WEB_TOKEN;
    }
});

test('tokenMatches rejects wrong, short, and non-string candidates', () => {
    const token = webAuth.loadOrCreateToken(tmpDir());
    assert.equal(webAuth.tokenMatches(token), true);
    assert.equal(webAuth.tokenMatches(token.slice(1)), false);
    assert.equal(webAuth.tokenMatches(token + 'x'), false);
    assert.equal(webAuth.tokenMatches(''), false);
    assert.equal(webAuth.tokenMatches(undefined), false);
});

test('isAuthenticated accepts the cookie or a bearer header', () => {
    const token = webAuth.loadOrCreateToken(tmpDir());
    assert.equal(webAuth.isAuthenticated(req({})), false);
    assert.equal(webAuth.isAuthenticated(req({ cookie: `other=1; rg_token=${token}` })), true);
    assert.equal(webAuth.isAuthenticated(req({ cookie: 'rg_token=nope' })), false);
    assert.equal(webAuth.isAuthenticated(req({ authorization: `Bearer ${token}` })), true);
    assert.equal(webAuth.isAuthenticated(req({ authorization: 'Bearer nope' })), false);
});

test('sessionCookie is HttpOnly and SameSite', () => {
    webAuth.loadOrCreateToken(tmpDir());
    const cookie = webAuth.sessionCookie();
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
});

test('isSameOrigin compares Origin against Host', () => {
    assert.equal(webAuth.isSameOrigin(req({ host: 'chef:7777' })), true);
    assert.equal(webAuth.isSameOrigin(req({ host: 'chef:7777', origin: 'http://chef:7777' })), true);
    assert.equal(webAuth.isSameOrigin(req({ host: 'chef:7777', origin: 'http://evil.example' })), false);
    assert.equal(webAuth.isSameOrigin(req({ host: 'chef:7777', origin: 'null' })), false);
});
