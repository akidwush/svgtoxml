// Offline rendering comparison, not an Alight Motion device import test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { chromium } from 'playwright';
import svgpath from 'svgpath';
import { convertSvgToAlightXml } from '../lib/converter.js';

const artifacts = path.resolve(process.env.SVG_PAINT_ARTIFACTS || 'artifacts/svg-paint');
const fixtures = [
  ...['zero-paint-compound','reported-layout-synthetic'].map(name=>({name,svg:fs.readFileSync(new URL('../test/fixtures/'+name+'.svg',import.meta.url),'utf8')})),
  {name:'nested-evenodd',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="#201f1e" fill-rule="evenodd" d="M10 10L190 10L190 190L10 190Z M30 30L170 30L170 170L30 170Z M60 60L140 60L140 140L60 140Z M80 80L120 80L120 120L80 120Z M15 15C16 15 18 15 15 15Z"/></svg>'},
  {name:'nested-nonzero',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="#201f1e" d="M10 10L190 10L190 190L10 190Z M30 30L170 30L170 170L30 170Z M15 15C16 15 18 15 15 15Z"/></svg>'},
  {name:'mixed-zero-stroke',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="#201f1e" stroke="#ef2161" stroke-width="2" d="M10 10L190 10L190 190L10 190Z M20 20C30 20 40 20 20 20Z M70 70C70 90 90 90 90 70C90 90 70 90 70 70Z"/></svg>'},
  {name:'stroke-only-zero',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="none" stroke="#ef2161" stroke-width="2" d="M20 20C30 20 40 20 20 20 M70 70C70 90 90 90 90 70C90 90 70 90 70 70"/></svg>'},
  {name:'implicit-holes',svg:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path fill="#201f1e" d="M10 10C10 8 190 8 190 10L190 190L10 190 M30 30L30 60L60 60L60 30 M20 20C30 20 40 20 20 20"/></svg>'},
  {name: 'legacy', svg: `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
  <svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><style><![CDATA[.green {fill:rgb(0,170,90)}]]></style>
  <rect class="green" x="10" y="10" width="50" height="50"/><rect x="70" y="10" width="50" height="50" fill="rebeccapurple"/>
  <g fill="blue"><path d="M130 10H180V60H130Z"/><path d="M155 35H205V85H155Z"/></g></svg>`},
  {name: 'group-opacity', qualities: ['maximum-fidelity','small-patch-cleanup'], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><g fill="blue" opacity=".5"><path d="M130 10H180V60H130Z"/><path d="M155 35H205V85H155Z"/></g></svg>`},
  {name: 'modern', svg: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" style="--Brand:color(srgb 0 .6666666667 .3529411765);color:var(--Brand)">
  <style>:where(.a,.b){fill:red} rect:is(.a,.b){fill:var(--Missing,var(--Brand,rgb(255,0,0)))} #last{fill:oklch(.7 .1 150)!important}</style>
  <rect class="a" x="10" y="10" width="40" height="40"/><rect x="60" y="10" width="40" height="40" fill="hwb(150 0% 20%)"/>
  <rect x="110" y="10" width="40" height="40" fill="hsl(.5turn 100% 50%)"/><rect x="160" y="10" width="40" height="40" fill="lab(50% 0 0)"/>
  <rect x="210" y="10" width="40" height="40" fill="oklab(.5 0 0)"/><rect id="last" x="260" y="10" width="40" height="40"/>
  <rect x="10" y="70" width="40" height="40" fill="lch(50% 0 0)"/><rect x="60" y="70" width="40" height="40" fill="rgb(0 170 90 / .5)"/>
  <g color="currentColor"><rect x="110" y="70" width="40" height="40" fill="currentColor"/></g>
  <rect x="160" y="70" width="40" height="40" fill="color(display-p3 .2 .3 .4)"/>
  <g visibility="hidden"><rect x="210" y="130" width="40" height="20" visibility="visible" fill="var(--Brand)"/></g>
  <path d="M220 75H300V115H220Z" fill="none" stroke="var(--Brand)" stroke-width="4"/></svg>`},
  {name: 'gradient-geometry', svg: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
  <defs><linearGradient id="g" color="rgb(0 179 77)"><stop offset=".2" stop-color="currentColor"/><stop offset=".8" stop-color="hsl(.5turn 100% 50%)"/></linearGradient></defs>
  <path d="M10 10H110V60H10Z" fill="url(#g)"/><g transform="translate(12 5) rotate(8 160 40)">
  <path d="M130 10 C180 10 180 70 130 70 C110 60 110 20 130 10Z" fill="hwb(330 10% 10%)"/></g>
  <path d="M20 100 C40 60 100 150 120 90 L160 130L20 130Z" fill="color(srgb .2 .4 .8)"/></svg>`}
];
const sourceIndex=process.argv.indexOf('--source');
if(sourceIndex>=0)fixtures.push({name:'user-source',svg:fs.readFileSync(process.argv[sourceIndex+1],'utf8')});
const children = node => Array.from(node.childNodes || []).filter(n => n.nodeType === 1);
const child = (node, tag) => children(node).find(n => n.tagName === tag);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
function color(argb) { const s = argb.replace('#', ''); return `rgb(${parseInt(s.slice(2,4),16)} ${parseInt(s.slice(4,6),16)} ${parseInt(s.slice(6,8),16)} / ${parseInt(s.slice(0,2),16)/255})`; }
function location(node) { return (child(child(node, 'transform') || {}, 'location')?.getAttribute('value') || '0,0,0').split(',').map(Number); }
function opacity(node) { return Number(child(child(node, 'transform') || {}, 'opacity')?.getAttribute('value') || 1); }
// Reconstruct from OUTPUT XML only. Interpret native exclusions as opposite
// winding, preserving cubic segments. Orientation sampling is test-only and
// independent of the exact production predicates; no generated masks/bridges.
function nativeContourData(node) {
  const d=node.getAttribute('d'), excluded=node.getAttribute('exclude')==='true';
  const segments=svgpath(d).abs().segments,edges=[],points=[];
  let start,current;
  for(const segment of segments) {
    if(segment[0]==='M'){start=current=segment.slice(-2);points.push(current);continue;}
    const end=segment[0]==='Z'?start:segment.slice(-2);
    if(segment[0]==='C')for(let i=1;i<=64;i++) {
      const t=i/64,u=1-t;
      points.push([0,1].map(c=>u*u*u*current[c]+3*u*u*t*segment[c+1]+3*u*t*t*segment[c+3]+t*t*t*end[c]));
    }else points.push(end);
    edges.push({start:current,end,segment});current=end;
  }
  const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0);
  if(area===0 || Math.sign(area)===(excluded?-1:1))return d;
  return 'M '+current.join(' ')+' '+edges.reverse().map(edge=>edge.segment[0]==='C'
    ? 'C '+[...edge.segment.slice(3,5),...edge.segment.slice(1,3),...edge.start].join(' ')
    : 'L '+edge.start.join(' ')).join(' ')+' Z';
}
function reconstruct(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml'), root = doc.documentElement;
  let nextGradient = 0;
  function scene(node) {
    return children(node).map(layer => {
      if (layer.tagName === 'embedScene') {
        const inner = child(layer, 'scene'), [x,y] = location(layer);
        assert.ok(inner);return `<g opacity="${opacity(layer)}" transform="translate(${x-Number(inner.getAttribute('width'))/2} ${y-Number(inner.getAttribute('height'))/2})">${scene(inner)}</g>`;
      }
      if (layer.tagName !== 'shape') return '';
      const geometry = child(layer, 'path'); assert.ok(geometry, 'comparison fixtures use actual vector paths');
      const [x,y] = location(layer), fill = child(layer, 'fillColor')?.getAttribute('value') || '#00000000';
      let paint = layer.getAttribute('fillType') === 'none' ? 'none' : color(fill), definition = '';
      const gradient = child(layer, 'gradient');
      if (gradient) {
        assert.equal(gradient.getAttribute('type'),'linear','this verifier covers linear endpoint gradients');
        const id = 'converted-'+nextGradient++, a = gradient.getAttribute('start').split(',').map(Number), b = gradient.getAttribute('end').split(',').map(Number);
        // The converter's native gradient contract stores endpoints normalized
        // to the shape bounds, rather than path-local pixel coordinates.
        definition = `<defs><linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"><stop stop-color="${color(gradient.getAttribute('startColor'))}"/><stop offset="1" stop-color="${color(gradient.getAttribute('endColor'))}"/></linearGradient></defs>`;
        paint = `url(#${id})`;
      }
      const stroke = child(layer, 'path-stroke');
      const outline = stroke ? `stroke="${color(child(stroke,'color').getAttribute('value'))}" stroke-width="${child(stroke,'size').getAttribute('value')}" stroke-linejoin="${stroke.getAttribute('join')}"` : '';
      const d=geometry.hasAttribute('d')?geometry.getAttribute('d'):children(geometry).map(nativeContourData).join(' ');
      return `<g opacity="${opacity(layer)}" transform="translate(${x} ${y})">${definition}<path d="${escape(d)}" fill-rule="nonzero" fill="${paint}" ${outline}/></g>`;
    }).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${root.getAttribute('width')}" height="${root.getAttribute('height')}">${scene(root)}</svg>`;
}
async function raster(page, svg, file) {
  const pixels = await page.evaluate(async svg => {
    const blob = new Blob([svg], {type:'image/svg+xml'}), url = URL.createObjectURL(blob), img = new Image();
    try {
      await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('SVG fixture failed to render'));img.src=url;});
      const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,canvas.width,canvas.height);
      const png=canvas.toDataURL('image/png').split(',')[1];canvas.width=canvas.height=1;
      return {width:data.width,height:data.height,bytes:Array.from(data.data),png};
    } finally {img.src='';URL.revokeObjectURL(url);}
  }, svg);
  fs.writeFileSync(file, Buffer.from(pixels.png,'base64'));return pixels;
}
fs.mkdirSync(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true}), report={status:'PASS',liveProvider:false,nativeAlightImport:false,originalReproducer:sourceIndex>=0?'supplied via --source':'BLOCKED: konzz.svg not attached; synthetic fixture is not the original',cases:[]};
try {
  const page=await browser.newPage();await page.setContent('<!doctype html><title>SVG paint comparison</title>');
  for(const fixture of fixtures) {
    const original=await raster(page,fixture.svg,path.join(artifacts,fixture.name+'-source.png'));
    for(const quality of fixture.qualities || ['maximum-fidelity','color-groups','small-patch-cleanup']) {
      const result=convertSvgToAlightXml(fixture.svg,{quality,requireExact:true,patchAreaPercent:0});
      assert.equal(result.fidelity.exact,true);assert.equal(result.validation.compatibility.ok,true);
      const output=await raster(page,reconstruct(result.xml),path.join(artifacts,fixture.name+'-'+quality+'.png'));
      assert.equal(output.width,original.width);assert.equal(output.height,original.height);
      let maxDelta=0;
      for(let i=0;i<original.bytes.length;i+=4) {
        const a=original.bytes[i+3]/255,b=output.bytes[i+3]/255;
        maxDelta=Math.max(maxDelta,Math.abs(original.bytes[i+3]-output.bytes[i+3]));
        for(let c=0;c<3;c++) for(const bg of [0,255]) maxDelta=Math.max(maxDelta,Math.abs(original.bytes[i+c]*a+bg*(1-a)-output.bytes[i+c]*b-bg*(1-b)));
      }
      assert.ok(maxDelta<=2,`${fixture.name}/${quality}: visible channel difference ${maxDelta} exceeds 8-bit rounding tolerance`);
      if(fixture.name==='reported-layout-synthetic') {
        const at=(34*original.width+25)*4+3;
        assert.equal(original.bytes[at],0,'source has a real transparent hole');assert.equal(output.bytes[at],0,'native exclusion preserves hole alpha');
      }
      report.cases.push({fixture:fixture.name,quality,shapes:result.stats.candidateShapes,nativeContours:result.stats.nativeContours,maxVisibleChannelDelta:maxDelta});
    }
  }
  fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
