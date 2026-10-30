import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load } from 'cheerio';
import { nativeContourPlan, inspectNativeContours, withNativeContourDiagnostics } from '../lib/native-contours.js';
import { convertSvgToAlightXml } from '../lib/converter.js';
import convertHandler from '../api/convert.js';

const outer='M 0 0 L 200 0 L 200 200 L 0 200 Z';
const line='M 20 20 C 30 20 40 20 20 20 Z';
const retraced='M 25 25 C 25 30 40 30 40 25 C 40 30 25 30 25 25 Z';
const hole='M 60 60 L 60 100 L 100 100 L 100 60 Z';
const bowtie='M 25 25 L 50 50 L 25 50 L 50 25 Z';
const svg=d=>`<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250"><path fill="#201f1e" d="${d}"/></svg>`;

test('only proven zero-paint fill contours are removed, for both SVG winding rules',()=>{
  for(const fillRule of ['nonzero','evenodd']) {
    const result=nativeContourPlan([outer,line,hole,retraced].join(' '),{fillRule});
    assert.equal(result.ok,true,result.code);
    assert.equal(result.contours.length,2);
    assert.deepEqual(result.contours.map(c=>c.exclude),[false,true]);
    assert.deepEqual(result.diagnostics,{inputContours:4,removedFillContours:2,retainedStrokeContours:0});
    assert.equal(inspectNativeContours(line)[0].proof,'collinear-control-hull');
    assert.equal(inspectNativeContours(retraced)[0].proof,'exact-retraced-edges');
  }
});

test('single survivor serializes the filtered path, never the original rejected compound',()=>{
  const result=convertSvgToAlightXml(svg(outer+' '+line),{quality:'maximum-fidelity',requireExact:true});
  const $=load(result.xml,{xmlMode:true});
  assert.equal($('shape').length,1);
  assert.equal(($('shape > path').attr('d').match(/M /g)||[]).length,1);
  assert.equal(result.stats.nativeContours.removedFillContours,1);
  assert.equal(result.fidelity.exact,true);
  assert.equal(result.validation.compatibility.ok,true);
});

test('stroke-only and mixed paint retain zero-area strokes in the same editable shape',()=>{
  for(const fill of [false,true]) {
    const plan=nativeContourPlan(outer+' '+retraced+' '+line,{fill,stroke:true});
    assert.equal(plan.ok,true,plan.code);
    assert.equal(plan.contours.length,3);
    assert.equal(plan.contours[1].d,retraced);
    assert.equal(plan.contours[2].d,line);
    assert.equal(plan.diagnostics.removedFillContours,0);
    const source=svg(outer+' '+retraced+' '+line).replace('fill="#201f1e"',`fill="${fill?'#201f1e':'none'}" stroke="#ef2161" stroke-width="2"`);
    const output=convertSvgToAlightXml(source,{quality:'maximum-fidelity'});
    const $=load(output.xml,{xmlMode:true});
    assert.equal($('shape').length,1);assert.equal($('path-stroke').length,1);
    assert.equal($('shape > path > contour').length,3);
  }
});

test('tiny valid contours retain exact nonzero area, including large-origin cancellation',()=>{
  for(const base of [250,1e9]) {
    const tiny=`M ${base} ${base} L ${base+.0001} ${base} L ${base+.0001} ${base+.0001} L ${base} ${base+.0001} Z`;
    const facts=inspectNativeContours(tiny)[0];
    assert.equal(facts.paintless,false);assert.equal(facts.areaSign,1);assert.ok(facts.signedArea>0 && facts.signedArea<1e-7);
    const result=nativeContourPlan(outer+' '+tiny);
    assert.equal(result.ok,true,result.code);assert.equal(result.contours.length,2);
  }
});

test('near-collinear cubic controls with real area must not be dropped as invisible',()=>{
  const curve='M 20 20 C 30 20.000000001 40 20 20 20 Z';
  assert.equal(inspectNativeContours(curve)[0].paintless,false);
  const result=nativeContourPlan(outer+' '+curve);
  assert.equal(result.ok,true,result.code);assert.equal(result.contours.length,2);
  assert.match(result.contours[1].d,/20\.000000001/);
});

test('zero signed area with potentially painted lobes fails closed, not false exact success',()=>{
  for(const fillRule of ['evenodd','nonzero']) {
    const plan=nativeContourPlan(outer+' '+bowtie,{fillRule});
    assert.equal(plan.ok,false);assert.equal(plan.code,'NATIVE_CONTOUR_ZERO_AREA_PAINT_UNRESOLVED');
    assert.throws(()=>convertSvgToAlightXml(svg(outer+' '+bowtie),{quality:'maximum-fidelity'}),e=>e.code===plan.code);
  }
});

test('same-direction curved loop repetition is visible under nonzero, never canceled',()=>{
  const d='M 25 25 C 25 35 40 35 40 25 C 40 15 25 15 25 25 C 25 35 40 35 40 25 C 40 15 25 15 25 25 Z';
  assert.equal(inspectNativeContours(d)[0].paintless,false);
});

test('cubic Green integral is analytic and translation-stable, not a sampled polygon area',()=>{
  for(const base of [0,1e9]) {
    const d=`M ${base} ${base} C ${base} ${base+1} ${base+1} ${base+1} ${base+1} ${base} Z`;
    assert.equal(inspectNativeContours(d)[0].signedArea,-.6);
  }
  assert.equal(nativeContourPlan(line+' '+bowtie).code,'NATIVE_CONTOUR_ZERO_AREA_PAINT_UNRESOLVED','filtering must not bypass rejection via a single survivor');
});

test('all-empty paths keep original native geometry without making a fake contour',()=>{
  const result=nativeContourPlan(line+' '+retraced);
  assert.equal(result.ok,true);assert.equal(result.contours.length,2);
  assert.equal(result.diagnostics.removedFillContours,0);
  assert.equal(result.contours[0].d,line);
});

test('implicit fill closure can be proven empty, but mixed open strokes remain fail-closed',()=>{
  const open='M 20 20 C 30 20 40 20 20 20';
  assert.equal(nativeContourPlan(outer+' '+open).diagnostics.removedFillContours,1);
  assert.equal(nativeContourPlan(outer+' '+open,{stroke:true}).code,'NATIVE_CONTOUR_MIXED_STROKE_CLOSURE_UNSUPPORTED');
  assert.equal(nativeContourPlan(outer+' '+open,{fill:false,stroke:true}).contours[1].d.endsWith('Z'),false);
});

test('NaN/Infinity and overflowing numeric coordinates fail even in single and stroke-only paths',()=>{
  for(const d of ['M 0 0 L NaN 1 Z','M 0 0 C 0 Infinity 2 2 3 3 Z','M 0 0 L 1e999 2 Z']) {
    for(const fill of [false,true])assert.equal(nativeContourPlan(d,{fill,stroke:true}).ok,false);
  }
});

test('removing invisible geometry does not enable overlaps or boundary touches',()=>{
  const overlap='M 100 -20 L 220 -20 L 220 50 L 100 50 Z';
  assert.equal(nativeContourPlan(outer+' '+line+' '+overlap).code,'NATIVE_CONTOUR_OVERLAP_UNSUPPORTED');
});

test('diagnostic scopes restore state after nested conversion and thrown failures',()=>{
  withNativeContourDiagnostics(stats=>{
    nativeContourPlan(outer+' '+line);
    assert.equal(stats.removedFillContours,1);
    assert.throws(()=>withNativeContourDiagnostics(()=>{nativeContourPlan(outer+' '+line);throw Error('fixture');}),/fixture/);
    nativeContourPlan(outer+' '+line);assert.equal(stats.removedFillContours,2);
  });
  const output=convertSvgToAlightXml(svg(outer),{quality:'maximum-fidelity'});
  assert.equal(output.stats.nativeContours.removedFillContours,0);
});

test('synthetic reported layout: 639x641,113 paths,13 compounds,72 subcontours,empty33/51',()=>{
  const input=fs.readFileSync(new URL('./fixtures/reported-layout-synthetic.svg',import.meta.url),'utf8');
  const $=load(input,{xmlMode:true}),paths=$('path').toArray();assert.equal(paths.length,113);
  assert.equal(paths.filter(p=>($(p).attr('d').match(/M /g)||[]).length>1).length,13);
  const facts=inspectNativeContours($(paths[1]).attr('d'));assert.equal(facts.length,72);
  assert.deepEqual(facts.filter(f=>f.paintless).map(f=>f.index),[33,51]);
  for(const quality of ['maximum-fidelity','color-groups','small-patch-cleanup']) {
    const result=convertSvgToAlightXml(input,{quality,patchAreaPercent:0,requireExact:true});
    const xml=load(result.xml,{xmlMode:true});
    assert.equal(result.width,639);assert.equal(result.height,641);
    assert.equal(xml('shape').length,113);assert.equal(xml('shape[label="source-1-72-contours"] > path > contour').length,70);
    assert.equal(result.stats.nativeContours.removedFillContours,2);
    assert.equal(result.validation.compatibility.ok,true);assert.equal(result.fidelity.exact,true);
  }
});

test('real local HTTP handler returns valid XML or specific controlled rejection (not a mock)',async()=>{
  for(const [d,status,code] of [[outer+' '+line,200,null],[outer+' '+bowtie,422,'NATIVE_CONTOUR_ZERO_AREA_PAINT_UNRESOLVED']]) {
    const response=await convertHandler.fetch(new Request('https://local.test/api/convert',{method:'POST',headers:{origin:'https://local.test','content-type':'application/json'},body:JSON.stringify({svg:svg(d),options:{quality:'maximum-fidelity'}})}));
    assert.equal(response.status,status);const body=await response.json();assert.equal(body.ok,status===200);
    if(code)assert.equal(body.code,code);else {assert.match(body.xml,/<scene /);assert.equal(body.stats.nativeContours.removedFillContours,1);}
  }
});
