'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Web Auth — shared-secret token for web mode
// The token is generated once and stored in userData. Visiting
// /?token=<token> sets an HttpOnly cookie; every other request must carry
// that cookie (or an `Authorization: Bearer <token>` header).
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE_NAME = 'rg_token';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

let _token = null;

function loadOrCreateToken(dataDir) {
    if (process.env.RADGOTCHI_WEB_TOKEN) {
        _token = process.env.RADGOTCHI_WEB_TOKEN;
        return _token;
    }

    const tokenPath = path.join(dataDir, 'web-token');
    try {
        const saved = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (saved.length >= 32) {
            _token = saved;
            return _token;
        }
    } catch (_) {}

    _token = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenPath, _token + '\n', { mode: 0o600 });
    return _token;
}

function getToken() {
    return _token;
}

function tokenMatches(candidate) {
    if (!_token || typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(_token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
    const cookies = {};
    if (!header) return cookies;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return cookies;
}

function isAuthenticated(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ') && tokenMatches(auth.slice(7))) return true;
    return tokenMatches(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

function sessionCookie() {
    return `${COOKIE_NAME}=${encodeURIComponent(_token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax`;
}

// Browsers always send Origin on WebSocket upgrades and cross-origin POSTs.
// When present it must match the Host the request was sent to.
function isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        return new URL(origin).host === req.headers.host;
    } catch (_) {
        return false;
    }
}

module.exports = {
    loadOrCreateToken,
    getToken,
    tokenMatches,
    isAuthenticated,
    sessionCookie,
    isSameOrigin,
};
