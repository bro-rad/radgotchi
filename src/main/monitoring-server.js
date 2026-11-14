'use strict';
const http = require('node:http');
const {randomBytes, createHash, timingSafeEqual} = require('node:crypto');
const empty = () => ({sourceStatus:'unconfigured', observedAt:null, lastSuccessAt:null, coverage:'package-status-only', containerIdentityAvailable:false, reportedRows:0, packages:[]});
const digest = value => createHash('sha256').update(value).digest();
const loopback = host => ['127.0.0.1','[::1]','::1','::ffff:127.0.0.1'].includes(host);
const {summarizePublicPackages} = require('./dappnode-public-packages');
const fs = require('node:fs');
const path = require('node:path');
const staticPaths = new Map([
  ['/login','login.html'],
  ['/src/styles/monitoring-login.css','src/styles/monitoring-login.css'],
  ['/','monitoring.html'], ['/monitoring.html','monitoring.html'],
  ['/src/web/monitoring-panel.js','src/web/monitoring-panel.js'],
  ...['companion-interactions','companion-activities','companion-bootstrap','companion-transport','companion-arcade','companion-audio','companion-audio-bootstrap'].map(name=>[`/src/web/${name}.js`,`src/web/${name}.js`]),
  ...['companion-interactions','companion-activities','companion-arcade'].map(name=>[`/src/styles/${name}.css`,`src/styles/${name}.css`]),
  ['/src/styles/monitoring.css','src/styles/monitoring.css'],
  ['/src/styles/chat-window.css','src/styles/chat-window.css'],
  ...['AWAKE','BROKEN','MOTIVATED','BORED','COOL','UPLOAD','LONELY','ANGRY'].map(name=>[`/assets/gotchi/${name}.png`,`assets/gotchi/${name}.png`]),
  ['/assets/radbro.png','assets/radbro.png']
]);
function createMonitoringServer({token, origin, root=path.resolve(__dirname,'../..'), inventoryUrl, fetchTimeoutMs=3000, maxBytes=1048576, cacheMs=10000, companionDirectory, companionClock, companionRng}) {
  if (!Number.isInteger(fetchTimeoutMs) || fetchTimeoutMs < 1 || fetchTimeoutMs > 10000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576 || !Number.isInteger(cacheMs) || cacheMs < 0 || cacheMs > 60000) throw new Error('Invalid monitoring bounds');
  if (inventoryUrl) {
    let url; try {url=new URL(inventoryUrl);} catch {throw new Error('Invalid inventory URL');}
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Invalid inventory URL');
  }
  let snapshot=empty(), checked=0, pending=null;
  async function inventory() {
    if (!inventoryUrl) return snapshot;
    if (pending) return pending;
    if (checked && Date.now()-checked < cacheMs) return snapshot;
    pending=(async()=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),fetchTimeoutMs);
      const observedAt=new Date().toISOString();
      try {
        const response=await fetch(inventoryUrl,{signal:controller.signal,redirect:'error',credentials:'omit',headers:{Accept:'application/json'}});
        if (!response.ok || Number(response.headers.get('content-length'))>maxBytes) throw new Error('inventory_unavailable');
        let bytes=0; const chunks=[];
        for await (const chunk of response.body) {bytes+=chunk.length; if(bytes>maxBytes) throw new Error('inventory_unavailable'); chunks.push(Buffer.from(chunk));}
        const summary=summarizePublicPackages(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        snapshot={...summary,sourceStatus:'connected',observedAt,lastSuccessAt:observedAt};
      } catch {
        snapshot={...snapshot,sourceStatus:snapshot.lastSuccessAt?'stale':'error',observedAt,error:'inventory_unavailable'};
      } finally {controller.abort(); clearTimeout(timer); checked=Date.now(); pending=null;}
      return snapshot;
    })();
    return pending;
  }
  const browser = new URL(origin);
  if (browser.origin !== origin || !['https:','http:'].includes(browser.protocol) || browser.username || browser.password || (browser.protocol === 'http:' && !loopback(browser.hostname))) throw new Error('Invalid monitoring origin');
  if (typeof token !== 'string' || !/^[a-fA-F0-9]{64,128}$/.test(token) || new Set(token).size < 8) throw new Error('Monitoring token must be random 32+ byte hex');
  const tokenHash = digest(token);
  const secure = browser.protocol === 'https:';
  const sessions = new Map();
  const cookieName = secure ? '__Host-radgotchi_monitor' : 'radgotchi_monitor';
  const failedLogins = createFailedLoginLimiter();
  const companion = companionDirectory ? require('./companion-store').createCompanionStore({directory:companionDirectory,clock:companionClock,rng:companionRng}) : null;
  let actionWindow=0, actionCount=0;
  function authenticated(req) {
    const matches=(req.headers.cookie || '').split(';').map(s=>s.trim()).filter(s=>s.startsWith(cookieName+'='));
    const session=matches.length===1 ? matches[0].slice(cookieName.length+1) : '';
    return /^[a-f0-9]{64}$/.test(session) && sessions.get(session)>Date.now();
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type='application/json') => {res.writeHead(status,{'Content-Type':type}); res.end(type === 'application/json' ? JSON.stringify(body) : body);};
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    // Native same-origin form POSTs need a non-opaque Origin; never send cross-origin referrers.
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // External links may open public documents, never APIs, subresources, or mutations.
    const publicNavigation = req.method === 'GET' && ['/login','/','/monitoring.html'].includes(req.url) && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (req.headers.host !== browser.host || (!secure && !loopback(req.socket.remoteAddress)) || (req.headers.origin && req.headers.origin !== origin) || (!publicNavigation && ['cross-site','same-site'].includes(req.headers['sec-fetch-site']))) return send(403,{error:'forbidden'});
    if (req.url.includes('?') || req.url.includes('#')) return send(400,{error:'invalid_request'});
    if (req.method === 'GET' && req.url === '/healthz') return send(200,{ok:true});
    if (req.method === 'POST' && req.url === '/login') {
      if (req.headers.origin !== origin) return send(403,{error:'forbidden'});
      if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) return send(415,{error:'unsupported_media_type'});
      try {
        const body = await readBody(req, 1024, 3000);
        const form = new URLSearchParams(body.toString('utf8'));
        // Always perform bounded, constant-time digest comparison before throttling failures.
        // Valid credentials must work even when a shared connector address is under attack.
        const valid = timingSafeEqual(digest(form.get('token') || ''),tokenHash);
        if (form.getAll('token').length !== 1 || !valid) {
          const retryAfter = failedLogins.fail(req.socket.remoteAddress || 'unknown');
          if (retryAfter) {res.setHeader('Retry-After',String(retryAfter)); return send(429,{error:'rate_limited'});}
          return send(401,{error:'unauthorized'});
        }
        const now=Date.now();
        for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
        if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
        const session=randomBytes(32).toString('hex'); sessions.set(session, now+3600000);
        res.setHeader('Set-Cookie',`${cookieName}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${secure ? '; Secure' : ''}`);
        res.setHeader('Location','/'); return send(303,{ok:true});
      } catch (error) {return send(error.code === 'BODY_LIMIT' ? 413 : 400,{error:'invalid_request'});}
    }
    if (['/api/companion/state','/api/companion/action'].includes(req.url)) {
      if (!authenticated(req)) return send(401,{error:'unauthorized'});
      if (!companion) return send(503,{error:'companion_unavailable'});
      if (req.method === 'GET' && req.url === '/api/companion/state') {
        try {return send(200,{view:companion.view()});} catch {return send(503,{error:'companion_unavailable'});}
      }
      if (req.method !== 'POST' || req.url !== '/api/companion/action') return send(405,{error:'method_not_allowed'});
      if (req.headers.origin !== origin) return send(403,{error:'forbidden'});
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(415,{error:'unsupported_media_type'});
      const now=Date.now(); if (now-actionWindow>=60000) {actionWindow=now;actionCount=0;}
      if (++actionCount>120) return send(429,{error:'rate_limited'});
      try {
        const command=JSON.parse((await readBody(req,2048,3000)).toString('utf8'));
        if (!authenticated(req)) return send(401,{error:'unauthorized'});
        return send(200,companion.action(command));
      } catch(error) {
        const code=error.message;
        const status=error.code==='BODY_LIMIT'?413:code==='store-unavailable'?503:['stale-revision','idempotency-conflict'].includes(code)?409:code==='cooldown'?429:400;
        return send(status,{error:status===503?'companion_unavailable':status===409?code:status===429?'cooldown':'invalid_action'});
      }
    }
    if (req.method === 'GET' && req.url === '/api/monitoring/package-status') {
      const matches = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName+'='));
      const session = matches.length === 1 ? matches[0].slice(cookieName.length+1) : '';
      if (!/^[a-f0-9]{64}$/.test(session) || !(sessions.get(session) > Date.now())) return send(401,{error:'unauthorized'});
      return send(200,await inventory());
    }
    if (req.method === 'GET' && staticPaths.has(req.url)) {
      try {
        const relative=staticPaths.get(req.url);
        const base=fs.realpathSync(root); let file=base;
        for (const segment of relative.split('/')) {file=path.join(file,segment); if(fs.lstatSync(file).isSymbolicLink()) throw new Error('symlink');}
        if (!fs.realpathSync(file).startsWith(base+path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > 2097152) throw new Error('invalid_asset');
        const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'}[path.extname(file)];
        return send(200,fs.readFileSync(file),type);
      } catch {return send(404,{error:'not_found'});}
    }
    send(404,{error:'not_found'});
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.once('close',()=>companion?.close());
  server.requestTimeout=5000; server.headersTimeout=5000; server.timeout=10000;
  return server;
}
function readBody(stream, cap, timeout) {
  return new Promise((resolve,reject) => {
    let bytes=0; const chunks=[];
    const timer=setTimeout(() => finish(Object.assign(new Error('timeout'),{code:'TIMEOUT'})),timeout);
    function finish(error) {clearTimeout(timer); stream.removeListener('data',data); stream.removeListener('end',end); stream.removeListener('error',fail); stream.removeListener('aborted',fail); error ? reject(error) : resolve(Buffer.concat(chunks));}
    function data(chunk) {bytes+=chunk.length; if(bytes>cap) {finish(Object.assign(new Error('limit'),{code:'BODY_LIMIT'})); stream.resume();} else chunks.push(chunk);}
    function end(){finish();} function fail(){finish(new Error('read_failed'));}
    stream.on('data',data); stream.on('end',end); stream.on('error',fail); stream.on('aborted',fail);
  });
}
function startMonitoringFromEnv(env) {
  const origin=env.RADGOTCHI_MONITORING_ORIGIN;
  const browser=new URL(origin);
  const host=env.RADGOTCHI_MONITORING_HOST || '127.0.0.1';
  const port=Number(env.RADGOTCHI_MONITORING_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (browser.protocol === 'http:' && !loopback(host))) throw new Error('Invalid monitoring bind');
  const server=createMonitoringServer({origin,token:env.RADGOTCHI_MONITORING_TOKEN,inventoryUrl:env.RADGOTCHI_MONITORING_INVENTORY_URL,companionDirectory:env.RADGOTCHI_COMPANION_DIR || path.join(require('node:os').homedir(),'.radgotchi','companion')});
  server.on('error',()=>{console.error('[Monitoring] Listener failed'); process.exitCode=2;});
  server.listen(port,host,()=>console.log('[Monitoring] Read-only server ready'));
  const stop=()=>{server.closeAllConnections(); server.close(()=>process.exit(0));};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  return server;
}
// Identity is ONLY the TCP peer. Forwarded/CF headers are untrusted and ignored.
// Cloudflared/NAT peers therefore share a failure bucket; this is not end-user
// isolation. A verified edge rate limit is still needed for traffic/CPU protection:
// this limiter throttles failed responses, not token comparisons or network input.
// Never evict active buckets under address churn. At capacity, new peers share a
// bounded overflow bucket until expiry. Successful tokens bypass all buckets.
function createFailedLoginLimiter(now = Date.now) {
  const clients = new Map();
  let overflow = null;
  return {
    get size() {return clients.size;},
    fail(client) {
      const time = now();
      for (const [key, bucket] of clients) if (bucket.expires <= time) clients.delete(key);
      let bucket = clients.get(client);
      if (!bucket) {
        if (clients.size < 1024) {bucket = {count:0, expires:time+60000}; clients.set(client,bucket);}
        else {if (!overflow || overflow.expires <= time) overflow = {count:0, expires:time+60000}; bucket = overflow;}
      }
      bucket.count = Math.min(bucket.count+1,31);
      return bucket.count > 30 ? Math.max(1,Math.ceil((bucket.expires-time)/1000)) : 0;
    }
  };
}
module.exports = {createMonitoringServer,startMonitoringFromEnv,createFailedLoginLimiter};
