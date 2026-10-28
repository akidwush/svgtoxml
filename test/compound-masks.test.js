import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { planCompoundMasks } from '../lib/compound-masks.js';
import { convertSvgToAlightXml } from '../lib/converter.js';

const outer = 'M 0 0 L 200 0 L 200 200 L 0 200 Z';
function hole(x,y) {
  // opposite winding compared with the parent outer ring
  return 'M ' + x + ' ' + y + ' L ' + x + ' ' + (y+4) +
    ' L ' + (x+4) + ' ' + (y+4) + ' L ' + (x+4) + ' ' + y + ' Z';
}
const holes24 = Array.from({length:24},(_,i)=>hole(8+(i%6)*30,8+Math.floor(i/6)*30));
const complexPath = [outer,...holes24].join(' ');

test('split implicit and explicit closed SVG contours without creating connectors',()=>{
  const source = 'M 0 0 L 100 0 L 100 100 L 0 100 M 20 20 L 20 30 L 30 30 L 30 20 Z';
  const plan=planCompoundMasks(source);
  assert.ok(plan);
  assert.equal(plan.holes.length,1);
  assert.equal(plan.count,2);
  assert.equal(plan.outer.includes('L 20 20'),false);
  assert.match(plan.holes[0], /^M 20 20/);
  assert.match(plan.outer, /Z$/);
});

test('plan 25-contour, 24-hole path without fabricated spokes',()=>{
  const plan=planCompoundMasks(complexPath);
  assert.ok(plan);
  assert.equal(plan.count,25);
  assert.equal(plan.holes.length,24);
  assert.equal((plan.outer.match(/M /g)||[]).length,1);
  assert.ok(plan.holes.every(p=>p.startsWith('M ') && p.endsWith('Z')));
});

test('reject disjoint contours and same-winding nonzero rings without falsely masking them',()=>{
  assert.equal(planCompoundMasks(outer + ' M 210 10 L 230 10 L 230 30 L 210 30 Z'),null);
  const sameWinding = 'M 0 0 L 100 0 L 100 100 L 0 100 Z M 20 20 L 30 20 L 30 30 L 20 30 Z';
  assert.equal(planCompoundMasks(sameWinding),null);
  assert.equal(planCompoundMasks(sameWinding,{fillRule:'evenodd'}).holes.length,1);
  assert.equal(planCompoundMasks('M 0 0 L 10 0'),null);
});

test('Maximum Fidelity opt-in emits one group with separate editable masks, not bridges',()=>{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
    '<path id="25holes" fill="#f4ae01" d="' + complexPath + '"/></svg>';
  const out=convertSvgToAlightXml(svg,{quality:'maximum-fidelity',compoundPathMode:'masks'});
  const $=load(out.xml,{xmlMode:true});
  const masks=$('shape[blending="exclude"]');
  assert.equal(masks.length,24);
  assert.equal($('embedScene[label*="Isolated Contours"]').length,1);
  assert.equal($('shape[label*="Outer"]').length,1);
  assert.ok($('shape[label*="Outer"] > path').attr('d').startsWith('M '));
  assert.equal(out.validation.compatibility.ok,true);
  assert.equal(out.stats.outputShapes,1,'source shape stays one source shape');
  assert.equal(out.profile.quality,'lossless');
  assert.equal(out.stats.contourMaskGroups,1);
  assert.equal(out.stats.contourMaskHoles,24);
  assert.equal(out.profile.contourMaskHoles,24);
  assert.equal(out.fidelity.exact,false,'Android native mask compositing remains unverified');
  assert.ok(out.fidelity.losses.some(loss=>loss.code==='contour-mask-unverified'));
});

test('Mask mode does not change single-path, stroked compound, or legacy default output',()=>{
  const d=outer+' '+hole(20,20);
  const base = '<svg width="200" height="200"><path id="ring" fill="red" d="'+d+'"/></svg>';
  const normal=convertSvgToAlightXml(base,{quality:'maximum-fidelity'});
  const masked=convertSvgToAlightXml(base,{quality:'maximum-fidelity',compoundPathMode:'masks'});
  assert.doesNotMatch(normal.xml,/blending="exclude"/);
  assert.match(masked.xml,/blending="exclude"/);
  const strokeSvg = '<svg width="200" height="200"><path id="stroke" fill="red" stroke="black" stroke-width="2" d="'+d+'"/></svg>';
  const stroked=convertSvgToAlightXml(strokeSvg,{quality:'maximum-fidelity',compoundPathMode:'masks'});
  assert.doesNotMatch(stroked.xml,/blending="exclude"/);
});

test('reject unsupported native mask options instead of silently reverting',()=>{
  assert.throws(()=>convertSvgToAlightXml('<svg width="10" height="10"><rect width="10" height="10"/></svg>',{
    quality:'maximum-fidelity',compoundPathMode:'random'
  }),(error)=>error?.code==='COMPOUND_PATH_MODE_NOT_SUPPORTED');
});

test('opt-in fails closed instead of hiding unrepresentable compound geometry',()=>{
  const sameWinding='M 0 0 L 100 0 L 100 100 L 0 100 Z M 20 20 L 30 20 L 30 30 L 20 30 Z';
  const svg='<svg width="100" height="100"><path id="ambiguous" fill="red" d="'+sameWinding+'"/></svg>';
  assert.throws(()=>convertSvgToAlightXml(svg,{
    quality:'maximum-fidelity',compoundPathMode:'masks'
  }),e=>e?.code==='COMPOUND_MASK_TOPOLOGY_UNSUPPORTED');
  assert.throws(()=>convertSvgToAlightXml(svg,{
    quality:'color-groups',compoundPathMode:'masks'
  }),e=>e?.code==='COMPOUND_PATH_MODE_UNAVAILABLE');
});

test('requireExact refuses to call an unverified Android mask implementation exact',()=>{
  const svg='<svg width="100" height="100"><path fill="red" d="'+
   'M 0 0 L 100 0 L 100 100 L 0 100 Z '+ hole(20,20)+'"/></svg>';
  assert.throws(()=>convertSvgToAlightXml(svg,{
    quality:'maximum-fidelity',compoundPathMode:'masks',requireExact:true
  }),e=>e?.code==='FIDELITY_REQUIREMENT_FAILED');
});
