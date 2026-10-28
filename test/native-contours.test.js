import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { nativeContourPlan } from '../lib/native-contours.js';
import { convertSvgToAlightXml } from '../lib/converter.js';
import { validateAlightImportXml } from '../lib/alight-compatibility.js';

const outer='M 0 0 L 200 0 L 200 200 L 0 200 Z';
const hole=(x,y)=>'M '+x+' '+y+' L '+x+' '+(y+5)+' L '+(x+5)+' '+(y+5)+' L '+(x+5)+' '+y+' Z';

test('device-proven AM shape format uses contour exclude inside one path',()=>{
  const plan=nativeContourPlan(outer+' '+hole(15,15)+' '+hole(80,15)+' '+hole(80,80));
  assert.equal(plan.ok,true);
  assert.equal(plan.compound,true);
  assert.equal(plan.contours.length,4);
  assert.deepEqual(plan.contours.map(p=>p.exclude),[false,true,true,true]);
  assert.ok(plan.contours.every(c=>c.d.startsWith('M ') && c.d.endsWith('Z')));
});

test('25 source contours are a single editable AM shape, not 25 separate layers',()=>{
  const holes=Array.from({length:24},(_,i)=>hole(9+Math.floor(i%6)*30,9+Math.floor(i/6)*30));
  const d=[outer,...holes].join(' ');
  const svg='<svg width="200" height="200"><path id="25-contours" fill="#f4ae01" d="'+d+'"/></svg>';
  for(const quality of ['maximum-fidelity','patch-clean','color-groups']){
    const out=convertSvgToAlightXml(svg,{quality,patchAreaPercent:0});
    const $=load(out.xml,{xmlMode:true});
    assert.equal($('shape[label="25-contours"]').length,1,quality);
    const contours=$('shape[label="25-contours"] > path > contour');
    assert.equal(contours.length,25,quality);
    assert.equal(contours.filter('[exclude="true"]').length,24,quality);
    assert.equal($('shape[label*="Hole"]').length,0,quality);
    assert.equal(out.stats.outputShapes,quality==='color-groups' ? 1 : 1);
    assert.equal(out.validation.compatibility.ok,true);
    // No long stitched lines: exactly one native subpath per contour.
    assert.equal(contours.toArray().every(c=>($(c).attr('d').match(/M /g)||[]).length===1),true);
  }
});

test('supports source-independent disjoint islands and nesting with mixed winding',()=>{
  const island='M 240 0 L 340 0 L 340 100 L 240 100 Z';
  const largeHole='M 20 20 L 20 80 L 80 80 L 80 20 Z';
  const innerIsland='M 35 35 L 45 35 L 45 45 L 35 45 Z';
  const d=[outer,largeHole,innerIsland,island].join(' ');
  const plan=nativeContourPlan(d,{fillRule:'evenodd'});
  assert.equal(plan.ok,true);
  assert.deepEqual(plan.contours.map(x=>x.exclude),[false,true,false,false]);
  const nestedNonzero=nativeContourPlan(d,{fillRule:'nonzero'});
  assert.equal(nestedNonzero.ok,true);
  assert.deepEqual(nestedNonzero.contours.map(x=>x.exclude),[false,true,false,false]);
});

test('same-winding nested contour does not become a false hole under nonzero',()=>{
  const same='M 20 20 L 40 20 L 40 40 L 20 40 Z';
  const nonzero=nativeContourPlan(outer+' '+same,{fillRule:'nonzero'});
  const evenodd=nativeContourPlan(outer+' '+same,{fillRule:'evenodd'});
  assert.equal(nonzero.ok,true);
  assert.deepEqual(nonzero.contours.map(x=>x.exclude),[false,false]);
  assert.deepEqual(evenodd.contours.map(x=>x.exclude),[false,true]);
});

test('implicit close and cubic curves remain intact without bridge segments',()=>{
  const source='M 0 0 L 100 0 L 100 100 L 0 100 ' +
    'M 20 20 C 20 40 40 40 40 20 L 20 20 Z';
  const result=nativeContourPlan(source);
  assert.equal(result.ok,true);
  assert.equal(result.contours.length,2);
  assert.equal(result.contours[1].exclude,true);
  assert.match(result.contours[1].d,/C 20 40 40 40 40 20/);
  assert.doesNotMatch(result.contours[0].d,/20 20/);
});

test('stroke-only multi contours have no false exclusions',()=>{
  const svg='<svg width="200" height="200"><path id="stroke" fill="none" stroke="black" stroke-width="2" d="'+
   outer+' '+hole(20,20)+'"/></svg>';
  const out=convertSvgToAlightXml(svg,{quality:'maximum-fidelity'});
  const $=load(out.xml,{xmlMode:true});
  const cs=$('shape[label="stroke"] > path > contour');
  assert.equal(cs.length,2);
  assert.equal(cs.filter('[exclude="true"]').length,0);
  assert.equal($('path-stroke').length,1);
});

test('unsupported partially intersecting contour topology fails closed',()=>{
  const touching='M 50 -10 L 130 -10 L 130 60 L 50 60 Z';
  const plan=nativeContourPlan(outer+' '+touching);
  assert.equal(plan.ok,false);
  assert.match(plan.code,/NATIVE_CONTOUR_/);
  const svg='<svg width="200" height="200"><path fill="red" d="'+outer+' '+touching+'"/></svg>';
  assert.throws(()=>convertSvgToAlightXml(svg,{quality:'maximum-fidelity'}),
    e=>e?.code?.startsWith('NATIVE_CONTOUR_'));
});

test('validator rejects malformed native multi-contour attributes and mixed old/new paths',()=>{
  const src='<svg width="200" height="200"><path fill="#aa0000" d="'+outer+' '+hole(20,20)+'"/></svg>';
  const out=convertSvgToAlightXml(src,{quality:'maximum-fidelity'});
  const xml=out.xml;
  assert.equal(validateAlightImportXml(xml).ok,true);
  assert.throws(()=>validateAlightImportXml(xml.replace('exclude="true"','exclude="maybe"')),
    e=>e?.code==='ALIGHT_XML_COMPATIBILITY_FAILED');
  assert.throws(()=>validateAlightImportXml(xml.replace('<path>','<path d="M 0 0L 1 0">')),
    e=>e?.code==='ALIGHT_XML_COMPATIBILITY_FAILED');
  assert.throws(()=>validateAlightImportXml(xml.replace('<contour exclude="true"','<bad-contour exclude="true"')),
    e=>e?.code==='ALIGHT_XML_COMPATIBILITY_FAILED');
});
