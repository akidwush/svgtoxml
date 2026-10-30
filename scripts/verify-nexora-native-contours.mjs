// Offline cross-repository integration: actual V1 UI/proxy -> actual provider
// handlers/converter. Only account permission and the HTTPS transport are local
// test bindings. Conversion responses are never fixtures or fabricated XML.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import conversion from '../api/v1/convert.js';
import engines from '../api/v1/engines.js';
import auth from '../api/v1/auth.js';
const require=createRequire(import.meta.url);
const v1=path.resolve(process.env.NEXORA_V1_ROOT || '../all-tools-nexora');
const {handleSvgToXml}=require(path.join(v1,'lib/svgtoxml-proxy.js'));
const output=path.resolve(process.env.NATIVE_INTEGRATION_ARTIFACTS || 'artifacts/native-integration');
const fixture=fs.readFileSync(new URL('../test/fixtures/reported-layout-synthetic.svg',import.meta.url));
const bad=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path d="M0 0L100 0L100 100L0 100Z M20 20L40 40L20 40L40 20Z"/></svg>');
const previousFetch=globalThis.fetch,envNames=['SVG2XML_API_KEY','SVGTOXML_API_KEY','SVGTOXML_ENGINE_KEY','SVGTOXML_API_BASE_URL','SVGTOXML_ENGINE_URL'];
const previousEnv=envNames.map(name=>process.env[name]);
for(const name of envNames)delete process.env[name];
process.env.SVG2XML_API_KEY='offline-native-integration-only';
let conversions=0,lastXml='';
globalThis.fetch=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'https://svgtoxml-zeta.vercel.app');
  const handler={'/api/v1/engines':engines,'/api/v1/auth':auth,'/api/v1/convert':conversion}[u.pathname];assert.ok(handler,'unexpected outbound request');
  const response=await handler.fetch(new Request(url,init));
  if(u.pathname==='/api/v1/convert') {
    conversions++;const data=await response.clone().json();if(data.ok)lastXml=data.xml;
  }
  return response;
};
const allowed=['/assets/js/core/shared-utils.js','/assets/js/features/svg-alight.js','/assets/css/features/svg-alight.css'];
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/css/features/svg-alight.css"><style>body{margin:0;padding:8px;background:#080710;color:white;font-family:Arial,sans-serif}*{box-sizing:border-box}</style><main id="fixture"></main><script>window.NexoraAccount={ensureAccess:async()=>true};</script><script src="/assets/js/core/shared-utils.js"></script><script src="/assets/js/features/svg-alight.js"></script><script>renderSvgAlight(document.querySelector("#fixture"))</script>';
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://local');
    if(url.pathname==='/'){res.setHeader('content-type','text/html');return res.end(html);}
    if(url.pathname==='/api/svg-alight') {
      const chunks=[];for await(const part of req)chunks.push(part);req.body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
      res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
      return await handleSvgToXml(req,res);
    }
    if(allowed.includes(url.pathname)) {res.setHeader('content-type',url.pathname.endsWith('.css')?'text/css':'text/javascript');return res.end(fs.readFileSync(path.join(v1,url.pathname)));}
    res.statusCode=404;res.end();
  }catch(error){res.statusCode=500;res.end('Local integration handler failed');console.error(error);}
});
let browser;
const report={status:'PASS',productionProvider:false,productionAuth:false,nativeAlightDeviceImport:false,cases:[]};
try {
  fs.mkdirSync(output,{recursive:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],acceptDownloads:true});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const errors=[];context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const page=await context.newPage();
  for(const width of [360,390,412,1440]) {
    await page.setViewportSize({width,height:900});await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.querySelector('#nsaApiStatus').textContent==='API AUTH OK');
    await page.setInputFiles('#nsaFile',{name:'reported-layout-synthetic.svg',mimeType:'image/svg+xml',buffer:fixture});
    await page.locator('#nsaRun').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#nsaRun').disabled);
    const before=conversions;await page.locator('#nsaRun').dblclick();
    await page.waitForFunction(()=>document.querySelector('#nsaReady').textContent==='XML READY');
    assert.equal(conversions-before,1,'double click must not send duplicate conversion');
    assert.ok(lastXml.includes('<contour'));assert.ok(!lastXml.includes('offline-native-integration-only'));
    assert.equal(await page.locator('#nsaCode').isVisible(),true,'XML preview is available immediately');
    const expand=page.locator('#nsaToggleXmlPreview');if(await expand.isVisible())await expand.click();
    assert.equal(await page.locator('#nsaCode').textContent(),lastXml,'full preview uses actual provider XML');
    await page.locator('#nsaCopy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),lastXml);
    const downloading=page.waitForEvent('download');await page.locator('#nsaDownload').click();const download=await downloading;
    assert.equal(fs.readFileSync(await download.path(),'utf8'),lastXml,'preview/copy/download use the same actual provider XML');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
    await page.screenshot({path:path.join(output,'nexora-native-'+width+'.png'),fullPage:false});
    report.cases.push({width,result:'XML READY',singleRequest:true,copyDownloadIdentical:true});
  }
  await page.setInputFiles('#nsaFile',{name:'unresolved.svg',mimeType:'image/svg+xml',buffer:bad});
  await page.waitForFunction(()=>!document.querySelector('#nsaRun').disabled);await page.locator('#nsaRun').click();
  await page.waitForFunction(()=>document.querySelector('#nsaReady').textContent==='FAILED');
  assert.match(await page.locator('body').innerText(),/NATIVE_CONTOUR_ZERO_AREA_PAINT_UNRESOLVED/);
  assert.equal(await page.locator('#nsaDownload').isVisible(),false,'failure must not expose old output');
  assert.deepEqual(errors,[]);report.cases.push({case:'ambiguous painted zero-area',result:'FAILED',specificCode:true,noStaleDownload:true});
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {
  if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  globalThis.fetch=previousFetch;
  envNames.forEach((name,i)=>{if(previousEnv[i]===undefined)delete process.env[name];else process.env[name]=previousEnv[i];});
}
