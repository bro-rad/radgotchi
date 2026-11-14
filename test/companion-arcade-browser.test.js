'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {randomBytes}=require('node:crypto');
const {chromium,until}=require('./companion-browser-helper.cjs');
const {createMonitoringServer}=require('../src/main/monitoring-server');
test('real Brave: original arcade, earned click XP, games, shop, reload and independent sprite', {timeout:60000},async t=>{
 const browser=await chromium(t);if(!browser)return;
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rg-arcade-browser-'));
 let now=10000;const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`,token=randomBytes(32).toString('hex');
 const app=createMonitoringServer({origin,token,companionDirectory:directory,companionClock:()=>now,companionRng:()=>0.1});
 server.on('request',(req,res)=>app.emit('request',req,res));
 t.after(()=>{server.closeAllConnections();server.close();app.emit('close');fs.rmSync(directory,{recursive:true,force:true});});
 await browser.command('Page.navigate',{url:origin+'/login'});
 await until(()=>browser.evaluate('!!document.querySelector("input[name=token]")'));
 await browser.evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(token)};document.querySelector('form').requestSubmit();undefined`);
 await until(()=>browser.evaluate('!!document.querySelector(".rg-arcade") && document.querySelector(".arcade-stats-mini").textContent.includes("TOTAL: 0")'));
 const sprite=await browser.evaluate('document.querySelector("#web-sprite").getAttribute("src")');
 async function click(label){await browser.evaluate(`[...document.querySelectorAll('.rg-arcade button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);await until(()=>browser.evaluate('document.querySelector(".rg-arcade").getAttribute("aria-busy")==="false"'));}
 for(let i=0;i<50;i++){now+=3000;await click('PET');}
 assert.match(await browser.evaluate('document.querySelector(".arcade-stats-mini").textContent'),/TOTAL: 100/);
 await browser.evaluate('document.querySelectorAll(".game-bet-input")[0].value="5"');await click('HEADS');
 assert.match(await browser.evaluate('document.querySelector(".rg-arcade").textContent'),/HEADS — YOU WIN/);
 await browser.evaluate('document.querySelectorAll(".game-bet-input")[1].value="10"');await click('DEAL');
 assert.equal(await browser.evaluate('document.querySelectorAll(".bj-card.face-down").length'),1);
 await click('STAND');assert.match(await browser.evaluate('document.querySelector(".bj-result").textContent'),/WIN|LOSE|BUST|PUSH/);
 await click('DEAL');await click('2X');assert.match(await browser.evaluate('document.querySelector(".bj-result").textContent'),/WIN|LOSE|BUST|PUSH/);
 await click('DEAL');await click('HIT');
 if(await browser.evaluate('[...document.querySelectorAll(".rg-arcade button")].some(b=>b.textContent==="STAND"&&!b.disabled)'))await click('STAND');
 await click('RATION PACK · 50 XP');assert.match(await browser.evaluate('document.querySelector(".rg-inventory").textContent'),/ration-pack ×1/);
 await click('USE RATION PACK');assert.doesNotMatch(await browser.evaluate('document.querySelector(".rg-inventory").textContent'),/ration-pack ×1/);
 assert.equal(await browser.evaluate('document.querySelector("#web-sprite").getAttribute("src")'),sprite);
 const xp=await browser.evaluate('(async()=> (await (await fetch("/api/companion/state")).json()).view.pet.totalXp)()');
 await browser.command('Page.reload');await until(()=>browser.evaluate(`document.querySelector('.arcade-stats-mini')?.textContent.includes('TOTAL: ${xp}')`));
 for(const width of [1280,390,320]){await browser.command('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);assert.equal(await browser.evaluate('document.querySelector("#companion-arcade").getBoundingClientRect().width>innerWidth-50'),true);
 assert.equal(await browser.evaluate('[...document.querySelectorAll(".rg-arcade .arcade-stats-mini")].every(el=>getComputedStyle(el).display!=="none" && el.getBoundingClientRect().height>0)'),true);
 if(process.env.RADGOTCHI_ARCADE_EVIDENCE){fs.mkdirSync(process.env.RADGOTCHI_ARCADE_EVIDENCE,{recursive:true,mode:0o700});await browser.evaluate('document.querySelector("#companion-arcade").scrollIntoView()');const {data}=await browser.command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.RADGOTCHI_ARCADE_EVIDENCE,`arcade-${width}.png`),Buffer.from(data,'base64'),{mode:0o600});}
 }
 await browser.evaluate('dispatchEvent(new PageTransitionEvent("pagehide"));dispatchEvent(new PageTransitionEvent("pageshow"))');
 assert.equal(await browser.evaluate('document.querySelectorAll(".rg-arcade").length'),1);
});
