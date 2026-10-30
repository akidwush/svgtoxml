// Read-only local tracing; never fetches SVG resources or logs full path data.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { inspectNativeContours } from '../lib/native-contours.js';
import { normalizePathForAlight } from '../lib/path-geometry-core.js';
import { convertSvgToAlightXml } from '../lib/converter.js';

if(!process.argv[2])throw Error('Usage: node scripts/inspect-native-contours.mjs /path/to/source.svg');
const input=fs.readFileSync(process.argv[2],'utf8');
if(Buffer.byteLength(input)>2*1024*1024)throw Error('Inspection limited to the API SVG size limit (2 MiB).');
const $=load(input,{xmlMode:true});
const paths=$('path').toArray().map((node,pathIndex)=>{
  const d=$(node).attr('d')||'',raw=inspectNativeContours(d);
  return {pathIndex,normalizedForInspection:!raw,contours:raw||inspectNativeContours(normalizePathForAlight(d,[],[1,0,0,1,0,0],12))};
});
let conversion;
try {
  const result=convertSvgToAlightXml(input,{quality:'maximum-fidelity',requireExact:true});
  conversion={status:'PASS',width:result.width,height:result.height,outputShapes:result.stats.outputShapes,
    nativeContours:result.stats.nativeContours,compatibility:result.validation.compatibility.ok,
    xmlSha256:createHash('sha256').update(result.xml).digest('hex')};
}catch(error){conversion={status:'FAIL',code:error.code||'CONVERSION_FAILED'};}
console.log(JSON.stringify({sourceSha256:createHash('sha256').update(input).digest('hex'),
  note:'Path indices zero-based; contour indices one-based. controlBounds conservatively enclose curves, not tight extrema. Coordinates before SVG element transforms; unsupported raw commands are normalized at 12 decimals explicitly.',
  paths,conversion},null,2));
if(conversion.status!=='PASS')process.exitCode=1;
