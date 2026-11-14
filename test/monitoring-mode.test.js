'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {randomBytes} = require('node:crypto');
const path = require('node:path');
const token = randomBytes(32).toString('hex');
async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, options = {}) {
  const {createMonitoringServer} = require('../src/main/monitoring-server');
  const server = createMonitoringServer({token, origin:'http://127.0.0.1:9876', root:path.resolve(__dirname,'..'), ...options});
  const base = await listen(server);
  t.after(() => {server.closeAllConnections(); server.close();});
  const request = (url, init={}) => new Promise((resolve,reject) => {
    const req=http.request(base+url,{method:init.method || 'GET',headers:{Host:'127.0.0.1:9876',...init.headers}},res => {
      const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>Array.isArray(res.headers[name])?res.headers[name].join(';'):res.headers[name]},json:async()=>JSON.parse(Buffer.concat(chunks).toString()),text:async()=>Buffer.concat(chunks).toString()}));
    }); req.on('error',reject); req.end(init.body ? String(init.body) : undefined);
  });
  return {server, request};
}
async function login(request, origin='http://127.0.0.1:9876') {
  const response = await request('/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
  assert.equal(response.status,303);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
  assert.ok(!cookie.includes(token));
  return cookie.split(';')[0];
}
test('login enforces origin and bounded body; sessions grant only allowlisted reads', async t => {
  const {request} = await fixture(t);
  assert.equal((await request('/login')).status,200);
  assert.equal((await request('/login',{method:'POST',body:token})).status,403);
  assert.equal((await request('/login',{method:'POST',headers:{Origin:'http://evil.test'},body:token})).status,403);
  assert.equal((await request('/login',{method:'POST',headers:{Origin:'http://127.0.0.1:9876','Content-Type':'application/x-www-form-urlencoded'},body:'token='+ 'x'.repeat(5000)})).status,413);
  const cookie = await login(request);
  const status = await request('/api/monitoring/package-status',{headers:{Cookie:cookie}});
  assert.deepEqual(await status.json(),{sourceStatus:'unconfigured',observedAt:null,lastSuccessAt:null,coverage:'package-status-only',containerIdentityAvailable:false,reportedRows:0,packages:[]});
  for (const route of ['/api/invoke','/api/send','/api/chat','/ws','/src/main/monitoring-server.js','/.env','/api/skills']) {
    assert.equal((await request(route,{method:'POST',headers:{Cookie:cookie,Origin:'http://127.0.0.1:9876'}})).status,404);
    assert.equal((await request(route,{headers:{Cookie:cookie}})).status,404);
  }
  assert.equal((await request('/api/monitoring/package-status',{headers:{Cookie:'radgotchi_monitor=%E0%A4%A'}})).status,401);
  assert.equal((await request('/api/monitoring/package-status?token='+token)).status,400);
  assert.equal((await request('/healthz',{headers:{Host:'evil.test'}})).status,403);
});
test('inventory uses bounded credential-free fetch and retains sanitized last good snapshot', async t => {
  let mode='good', hits=0;
  const upstream=http.createServer((req,res)=>{
    hits++; assert.equal(req.headers.cookie,undefined); assert.equal(req.headers.authorization,undefined);
    if(mode==='hang') return;
    if(mode==='redirect'){res.writeHead(302,{Location:'/secret'}); return res.end();}
    if(mode==='large') return res.end('x'.repeat(2048));
    if(mode==='bad') return res.end('{');
    res.end(JSON.stringify([{name:'demo.dnp.dappnode.eth',version:'1.0.0',state:'running',ip:'PRIVATE_IP',secret:token}]));
  });
  const upstreamURL=await listen(upstream); t.after(()=>{upstream.closeAllConnections(); upstream.close();});
  const {request}=await fixture(t,{inventoryUrl:upstreamURL+'/inventory',fetchTimeoutMs:80,maxBytes:1024,cacheMs:0});
  const cookie=await login(request);
  const get=async()=> (await request('/api/monitoring/package-status',{headers:{Cookie:cookie}})).json();
  const good=await get(); assert.equal(good.sourceStatus,'connected'); assert.equal(good.reportedRows,1);
  assert.ok(!JSON.stringify(good).includes('PRIVATE_IP')); assert.ok(!JSON.stringify(good).includes(token));
  for(mode of ['bad','large','redirect','hang']) {const stale=await get(); assert.equal(stale.sourceStatus,'stale'); assert.deepEqual(stale.packages,good.packages); assert.equal(stale.lastSuccessAt,good.lastSuccessAt); assert.equal(stale.error,'inventory_unavailable');}
  assert.equal(hits,5);
  const firstFailure=await fixture(t,{inventoryUrl:upstreamURL,fetchTimeoutMs:30});
  const failedCookie=await login(firstFailure.request);
  assert.equal((await (await firstFailure.request('/api/monitoring/package-status',{headers:{Cookie:failedCookie}})).json()).sourceStatus,'error');
});
test('static files are exact allowlisted paths with symlink protection', async t => {
  const fs=require('node:fs'); const os=require('node:os');
  const root=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'monitor-static-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src/web'),{recursive:true}); fs.mkdirSync(path.join(root,'src/styles'),{recursive:true});
  fs.writeFileSync(path.join(root,'monitoring.html'),'monitor shell'); fs.writeFileSync(path.join(root,'src/web/monitoring-panel.js'),'// safe');
  fs.symlinkSync(__filename,path.join(root,'src/styles/monitoring.css'));
  const {request}=await fixture(t,{root});
  assert.equal(await (await request('/')).text(),'monitor shell');
  assert.equal((await request('/monitoring.html')).status,200);
  assert.equal((await request('/src/web/monitoring-panel.js')).status,200);
  assert.equal((await request('/src/styles/monitoring.css')).status,404);
  assert.equal((await request('/assets/../headless.js')).status,404);
});
test('headless opt-in never requires legacy bootstrap or restores state', async t => {
  const {spawn}=require('node:child_process'); const fs=require('node:fs');
  const probe=http.createServer(); await listen(probe); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const root=path.resolve(__dirname,'..');
  const dataDir=fs.mkdtempSync(path.join(fs.realpathSync(require('node:os').tmpdir()),'monitor-mode-companion-'));
  const child=spawn(process.execPath,['-e',`const Module=require('module');const load=Module._load;Module._load=function(id,...args){if(id.includes('bootstrap'))throw Error('LEGACY_BOOTSTRAP_LOADED');return load.call(this,id,...args)};require('./headless.js')`],{cwd:root,env:{...process.env,RADGOTCHI_COMPANION_DIR:dataDir,RADGOTCHI_MONITORING_MODE:'1',RADGOTCHI_MONITORING_TOKEN:token,RADGOTCHI_MONITORING_ORIGIN:`http://127.0.0.1:${port}`,RADGOTCHI_MONITORING_PORT:String(port)}});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}fs.rmSync(dataDir,{recursive:true,force:true});});
  let ok=false;
  for(let i=0;i<40;i++){try {ok=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;if(ok)break;}catch{} await new Promise(r=>setTimeout(r,25));}
  assert.ok(ok,output); assert.ok(!output.includes(token)); assert.ok(!output.includes('LEGACY_BOOTSTRAP_LOADED'));
});
test('secure origin sets secure host cookie, rejects unsafe config and websocket upgrades', async t => {
  const {createMonitoringServer,startMonitoringFromEnv}=require('../src/main/monitoring-server');
  for(const options of [{token:'weak',origin:'http://127.0.0.1:9876'},{token,origin:'http://example.test'},{token,origin:'https://example.test',inventoryUrl:'http://user:pass@localhost/inventory'},{token,origin:'https://example.test',inventoryUrl:'http://localhost/?token=secret'}]) assert.throws(()=>createMonitoringServer(options));
  assert.throws(()=>startMonitoringFromEnv({RADGOTCHI_MONITORING_ORIGIN:'http://127.0.0.1:9876',RADGOTCHI_MONITORING_HOST:'0.0.0.0',RADGOTCHI_MONITORING_TOKEN:token}));
  const {request,server}=await fixture(t,{origin:'https://127.0.0.1:9876'});
  const cookie=await login(request,'https://127.0.0.1:9876'); assert.match(cookie,/^__Host-radgotchi_monitor=/);
  const response=await request('/login',{method:'POST',headers:{Origin:'https://127.0.0.1:9876','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
  assert.match(response.headers.get('set-cookie'),/; Secure/);
  const net=require('node:net');
  const upgrade=await new Promise((resolve,reject)=>{const socket=net.connect(server.address().port,'127.0.0.1',()=>socket.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:9876\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));let body='';socket.on('data',c=>body+=c);socket.on('end',()=>resolve(body));socket.on('error',reject);});
  assert.match(upgrade,/404 Not Found/);
});
test('mistyped opt-in fails closed without loading legacy bootstrap', t => {
  const {spawnSync}=require('node:child_process');
  const fs=require('node:fs');
  const dataDir=fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(),'monitor-mode-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const result=spawnSync(process.execPath,['headless.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,RADGOTCHI_DATA_DIR:dataDir,RADGOTCHI_MONITORING_MODE:'true'},encoding:'utf8',timeout:1000});
  assert.equal(result.status,2); assert.ok(!result.stdout.includes('[Skills]'));
});
test('isolated monitoring denies unauthenticated inventory and exposes minimal health', async t => {
  const {request} = await fixture(t);
  assert.equal((await request('/api/monitoring/package-status')).status,401);
  assert.deepEqual(await (await request('/healthz')).json(),{ok:true});
});
