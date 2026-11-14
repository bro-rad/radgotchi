'use strict';
// Acceptance tests of an existing immutable image; no production implementation changes.
// Secrets exist only in process memory/child environment, never Docker config or argv.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
function validateOptions(env) {
  const image = env.RADGOTCHI_TEST_IMAGE;
  const tag = env.RADGOTCHI_TEST_TAG;
  const output = env.RADGOTCHI_TEST_OUTPUT;
  const manifest = require('./dappnode_package.json');
  if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw new Error('Explicit immutable RADGOTCHI_TEST_IMAGE required');
  if (tag !== `radgotchi.${manifest.name}:${manifest.version}`) throw new Error('RADGOTCHI_TEST_TAG must match current service-qualified manifest');
  if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('RADGOTCHI_TEST_OUTPUT must be a new absolute path');
  return {image, tag, output};
}
function ownsContainer(c, name, nonce, image) {
  return Boolean(c && /^[a-f0-9]{64}$/.test(c.Id) && c.Name === '/'+name && c.Image === image && c.Config?.Labels?.['org.radgotchi.qualification'] === nonce);
}
module.exports = {validateOptions, ownsContainer};
function main() {
const {image, tag, output} = validateOptions(process.env);
const nonce = crypto.randomUUID();
const names = [];
const evidence = {schema:1, image, tag, scope:'Exact image, network-none in-container HTTP client with synthetic HTTPS Host/Origin; NOT TLS, browser, DAppNode deployment or real inventory verification', checks:[], containers:[]};
function docker(args, input) {
  return spawnSync('docker', args, {input, encoding:'utf8', timeout:120000, maxBuffer:1048576});
}
function check(name, pass, detail) {
  evidence.checks.push({name, pass:Boolean(pass), ...detail});
  if (!pass) throw new Error(name);
}
async function inside(expected) {
  const fs = require('node:fs'), crypto = require('node:crypto'), http = require('node:http');
  const {spawn} = require('node:child_process');
  const result = {checks:[]};
  let child, upstream;
  function check(name, pass, detail={}) {result.checks.push({name,pass:Boolean(pass),...detail}); if (!pass) throw new Error(name);}
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const origin = 'https://radgotchi-qualification.invalid';
  const token = crypto.randomBytes(32).toString('hex');
  const request = (route, options={}) => new Promise((resolve,reject) => {
    const req = http.request({host:'127.0.0.1',port:3000,path:route,method:options.method || 'GET',headers:{Host:'radgotchi-qualification.invalid',Origin:origin,...options.headers}},res=>{
      let bytes=0; const chunks=[];
      res.on('data', b=>{bytes+=b.length; if(bytes>2097152) req.destroy(new Error('response_limit')); else chunks.push(b);});
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.setTimeout(4000,()=>req.destroy(new Error('request_timeout'))); req.on('error',reject); req.end(options.body);
  });
  async function start(inventoryUrl) {
    child = spawn(process.execPath,['/app/packaging/entrypoint.cjs'],{env:{...process.env,RADGOTCHI_MONITORING_ORIGIN:origin,RADGOTCHI_MONITORING_TOKEN:token,...(inventoryUrl?{RADGOTCHI_MONITORING_INVENTORY_URL:inventoryUrl}:{})},stdio:'ignore'});
    for(let i=0;i<100;i++) {try {if((await request('/healthz')).status===200)return;}catch{} await new Promise(r=>setTimeout(r,100));}
    throw new Error('server_start');
  }
  async function stop() {
    const current=child; if(!current || current.exitCode!==null)return;
    const exit=new Promise(resolve=>current.once('exit',(code,signal)=>resolve({code,signal})));
    const timer=setTimeout(()=>current.kill('SIGKILL'),5000);
    current.kill('SIGTERM'); const state=await exit; clearTimeout(timer); child=null;
    check('graceful_SIGTERM',state.code===0 && state.signal===null,{exitCode:state.code});
  }
  async function login() {
    const r=await request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}).toString()});
    check('login_redirect',r.status===303 && r.headers.location==='/',{status:r.status});
    const c=(r.headers['set-cookie']||[])[0]||'';
    check('secure_session_cookie',c.startsWith('__Host-radgotchi_monitor=') && ['Path=/','HttpOnly','SameSite=Strict','Secure','Max-Age=3600'].every(x=>c.includes(x)) && !c.includes(token));
    return c.split(';')[0];
  }
  try {
    check('actual_nonroot',process.getuid()===1000 && process.getgid()===1000,{uid:process.getuid(),gid:process.getgid()});
    for(const [file,digest] of Object.entries(expected)) check('copied_hash:'+file,hash(fs.readFileSync('/app/'+file))===digest,{sha256:digest});
    await start();
    let r=await request('/api/monitoring/package-status'); check('unauthorized',r.status===401,{status:r.status});
    r=await request('/login'); check('login_form',r.status===200 && r.body.toString().includes('form method="post"'),{status:r.status});
    r=await request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'token=invalid'}); check('invalid_token',r.status===401,{status:r.status});
    for(const headers of [{Host:'wrong.invalid'},{Origin:'https://wrong.invalid'},{'sec-fetch-site':'cross-site'}]) {r=await request('/healthz',{headers});check('request_boundary',r.status===403,{status:r.status});}
    r=await request('/login',{method:'POST',headers:{Origin:'','Content-Type':'application/x-www-form-urlencoded'},body:'token=invalid'});check('missing_login_origin',r.status===403,{status:r.status});
    let cookie=await login();
    r=await request('/api/monitoring/package-status',{headers:{Cookie:cookie}}); let data=JSON.parse(r.body);
    check('authenticated_unconfigured',r.status===200 && data.sourceStatus==='unconfigured' && data.reportedRows===0,{status:r.status});
    for(const route of ['/api/config','/api/chat','/api/skills','/api/command','/settings.html','/headless.js','/package.json','/../headless.js','/%2e%2e/headless.js']) {r=await request(route,{headers:{Cookie:cookie}});check('forbidden_route:'+route,r.status===404,{status:r.status});}
    r=await request('/healthz?x=1');check('query_refused',r.status===400,{status:r.status});
    for(const file of Object.keys(expected).filter(x=>['monitoring.html','login.html'].includes(x) || x.startsWith('src/web/') || x.startsWith('src/styles/') || x.endsWith('.png'))) {
      r=await request(file==='monitoring.html'?'/' : file==='login.html'?'/login':'/'+file);
      check('served_hash:'+file,r.status===200 && hash(r.body)===expected[file],{status:r.status,bytes:r.body.length});
    }
    await stop(); await start();
    r=await request('/api/monitoring/package-status',{headers:{Cookie:cookie}});check('restart_discards_session',r.status===401,{status:r.status});
    await login(); await stop();
    let requests=0, leaked=false;
    const rows=[{name:'SYNTHETIC-alpha.dnp.dappnode.eth',version:'1.0.0',state:'running',ip:'192.0.2.1',privateExtra:'SYNTHETIC-omit'},{name:'SYNTHETIC-alpha.dnp.dappnode.eth',version:'1.1.0',state:'exited',ip:'192.0.2.2'}];
    upstream=http.createServer((req,res)=>{requests++; leaked ||= Boolean(req.headers.cookie || req.headers.authorization || req.url!=='/inventory');res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(rows));});
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
    await start('http://127.0.0.1:'+upstream.address().port+'/inventory'); cookie=await login();
    r=await request('/api/monitoring/package-status',{headers:{Cookie:cookie}});data=JSON.parse(r.body);
    check('sanitized_inventory',r.status===200 && data.sourceStatus==='connected' && data.reportedRows===2 && data.packages.length===1 && data.packages[0].reportedRows===2 && data.packages[0].states.running===1 && data.packages[0].states.exited===1 && data.coverage==='package-status-only' && data.containerIdentityAvailable===false && !r.body.toString().includes('192.0.2.') && !r.body.toString().includes('SYNTHETIC-omit'),{status:r.status,reportedRows:data.reportedRows,packages:data.packages.length});
    check('upstream_no_credentials',requests===1 && !leaked,{requests});
    await new Promise(r=>{upstream.close(r);upstream.closeAllConnections();}); upstream=null;
    await new Promise(r=>setTimeout(r,10100));
    r=await request('/api/monitoring/package-status',{headers:{Cookie:cookie}});data=JSON.parse(r.body);
    check('upstream_failure_stale',r.status===200 && data.sourceStatus==='stale' && data.reportedRows===2,{status:r.status});
    await stop();
  } catch {result.failed=true;} finally {
    if(child) {try {await stop();}catch{result.failed=true;}}
    if(upstream) {upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
    console.log(JSON.stringify(result)); process.exitCode=result.failed?1:0;
  }
}
try {
  const meta=docker(['image','inspect',tag,'--format','{{json .}}']);
  if(meta.status!==0)throw new Error('image_inspection');
  const m=JSON.parse(meta.stdout);
  check('pinned_image',m.Id===image && m.Architecture==='amd64' && m.Config.User==='1000:1000',{architecture:m.Architecture,user:m.Config.User});
  const files=['login.html','src/styles/monitoring-login.css','src/web/companion-interactions.js','src/web/companion-activities.js','src/web/companion-bootstrap.js','src/styles/companion-interactions.css','src/styles/companion-activities.css','headless.js','monitoring.html','LICENSE','README.md','src/main/monitoring-server.js','src/main/dappnode-public-packages.js','src/web/monitoring-panel.js','src/styles/monitoring.css','src/styles/chat-window.css','packaging/entrypoint.cjs','assets/radbro.png',...['AWAKE','BROKEN','MOTIVATED','BORED','COOL','UPLOAD','LONELY','ANGRY'].map(n=>'assets/gotchi/'+n+'.png')];
  const expected=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
  const live=docker(['ps','-q','--filter','ancestor='+image]);
  check('not_running_image',live.status===0 && !live.stdout.trim());
  const suffix=nonce;
  const refusal='radgotchi-qualification-unset-'+suffix; names.push(refusal);
  const refused=docker(['run','--pull=never','--platform','linux/amd64','--network','none','--name',refusal,'--label','org.radgotchi.qualification='+nonce,image]);
  check('unset_config_refusal',refused.status===2 && refused.stderr.includes('Invalid configuration; server not started'),{exitCode:refused.status});
  const runtime='radgotchi-qualification-runtime-'+suffix; names.push(runtime);
  const run=docker(['run','--pull=never','--platform','linux/amd64','--network','none','--name',runtime,'--label','org.radgotchi.qualification='+nonce,'-i','--entrypoint','node',image,'-'],`(${inside.toString()})(${JSON.stringify(expected)});`);
  let results;try{results=JSON.parse(run.stdout.trim());}catch{throw new Error('runtime_result_unavailable');}
  evidence.checks.push(...results.checks);
  check('runtime_exit',run.status===0,{exitCode:run.status});
} catch(error) {evidence.failure=String(error.message).slice(0,120);} finally {
  for(const name of names) {
    const r=docker(['inspect',name,'--format','{{json .}}']);
    if(r.status!==0){evidence.containers.push({name,inspectionFailed:true});continue;}
    const c=JSON.parse(r.stdout);
    if (!ownsContainer(c,name,nonce,image)) {evidence.failure='container_ownership_mismatch';continue;}
    evidence.containers.push({name,image:c.Image,status:c.State.Status,exitCode:c.State.ExitCode,network:c.HostConfig.NetworkMode,mounts:c.Mounts.length});
    if(c.State.Running || c.Mounts.length || c.HostConfig.NetworkMode!=='none')evidence.failure='container_isolation_or_stopped_state';
    const removed=docker(['rm','-f',c.Id]);
    const remaining=docker(['container','ls','-aq','--no-trunc','--filter','id='+c.Id]);
    if(removed.status!==0 || remaining.status!==0 || remaining.stdout.trim())evidence.failure='container_cleanup_failed';
  }
  evidence.passed=!evidence.failure && evidence.checks.every(c=>c.pass);
  fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks.length,failedChecks:evidence.checks.filter(c=>!c.pass).map(c=>c.name),failure:evidence.failure,containers:evidence.containers}));
  process.exitCode=evidence.passed?0:1;
}
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode=1; }
}
