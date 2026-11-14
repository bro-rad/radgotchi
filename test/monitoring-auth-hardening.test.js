'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {randomBytes}=require('node:crypto');
const {createMonitoringServer,createFailedLoginLimiter}=require('../src/main/monitoring-server');
async function fixture(t) {
  const token=randomBytes(32).toString('hex');
  const server=http.createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const app=createMonitoringServer({origin,token});
  server.on('request',(req,res)=>app.emit('request',req,res));
  t.after(()=>{server.closeAllConnections();server.close();app.close();});
  function request(route, {method='GET',body='',headers={}}={}) {
    return new Promise((resolve,reject)=>{
      const req=http.request(origin+route,{method,headers},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
      });req.on('error',reject);req.end(body);
    });
  }
  const login=(value=token,headers={})=>request('/login',{method:'POST',body:new URLSearchParams({token:value}).toString(),headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...headers}});
  return {token,origin,request,login};
}
// Additional boundary coverage for the implementation and preserved request contract.
test('failure buckets isolate peers, cap memory under churn, preserve active lockouts and expire',()=>{
  let now=0;const limiter=createFailedLoginLimiter(()=>now);
  for(let i=0;i<30;i++) assert.equal(limiter.fail('peer-a'),0);
  assert.equal(limiter.fail('peer-a'),60);
  assert.equal(limiter.fail('peer-b'),0);
  for(let i=0;i<10000;i++) limiter.fail(`peer-${i}`);
  assert.equal(limiter.size,1024);
  assert.equal(limiter.fail('new-overflow-peer'),60);
  assert.equal(limiter.fail('peer-a'),60);
  now=59999;assert.equal(limiter.fail('peer-a'),1);
  now=60000;assert.equal(limiter.fail('peer-a'),0);
  assert.equal(limiter.size,1);
  assert.equal(limiter.fail('new-overflow-peer'),0);
});
test('login keeps strict Origin, bounded bodies, duplicate-token refusal and query-secret refusal',async t=>{
  const {request,origin,token,login}=await fixture(t);
  const headers={Origin:origin,'Content-Type':'application/x-www-form-urlencoded'};
  for(const Origin of ['null','https://evil.test','']) assert.equal((await login(token,{Origin})).status,403);
  assert.equal((await login(token,{Host:'evil.test'})).status,403);
  assert.equal((await login(token,{'Content-Type':'application/json'})).status,415);
  assert.equal((await request('/login',{method:'POST',headers,body:'token='+ 'x'.repeat(1024)})).status,413);
  assert.equal((await request('/login',{method:'POST',headers,body:new URLSearchParams([['token',token],['token',token]]).toString()})).status,401);
  assert.equal((await request('/login?token=synthetic')).status,400);
  const response=await login();assert.equal(response.status,303);assert.equal(response.headers.location,'/');
  const cookie=response.headers['set-cookie'][0];
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
  assert.equal((await request('/api/monitoring/package-status',{headers:{Cookie:cookie.split(';')[0]}})).status,200);
});
test('login parser rejects oversized headers and expires a stalled request body',async t=>{
  const {origin,request}=await fixture(t);
  assert.equal((await request('/login',{headers:{'X-Forwarded-For':'x'.repeat(20000)}})).status,431);
  const status=await new Promise((resolve,reject)=>{
    const req=http.request(origin+'/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded','Content-Length':'20'}},res=>{
      res.resume();res.on('end',()=>{resolve(res.statusCode);req.destroy();});
    });
    req.on('error',reject);req.flushHeaders();req.write('token=');
    t.after(()=>req.destroy());
  });
  assert.equal(status,400);
});
test('login reuses original terminal CSS and artwork without executable legacy features',async t=>{
  const {request}=await fixture(t);
  const page=await request('/login');
  assert.equal(page.status,200);
  assert.equal(page.headers['referrer-policy'],'same-origin');
  assert.match(page.body,/form method="post" action="\/login"/);
  assert.match(page.body,/\/src\/styles\/chat-window.css/);
  assert.match(page.body,/\/src\/styles\/monitoring-login.css/);
  assert.match(page.body,/message-avatar sprite-avatar/);
  assert.doesNotMatch(page.body,/<script|unsafe-inline|ENCRYPTED|XP:/);
  for(const asset of ['/src/styles/chat-window.css','/src/styles/monitoring-login.css','/assets/gotchi/AWAKE.png']) assert.equal((await request(asset)).status,200);
  for(const asset of ['/login.html','/chat.html','/src/main/monitoring-server.js']) assert.equal((await request(asset)).status,404);
});
test('failed-attempt throttle ignores spoofed proxy identities but never locks out a valid token',async t=>{
  const {login}=await fixture(t);
  for(let i=0;i<30;i++) assert.equal((await login('wrong',{'X-Forwarded-For':`192.0.2.${i}`,'CF-Connecting-IP':`192.0.2.${i}`})).status,401);
  const limited=await login('wrong',{'X-Forwarded-For':'198.51.100.1'});
  assert.equal(limited.status,429);assert.ok(Number(limited.headers['retry-after'])>0);
  assert.equal((await login()).status,303);
});
