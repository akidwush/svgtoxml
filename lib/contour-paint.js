// Exact predicates on the finite IEEE-754 coordinates supplied by svgpath.
// Signed area alone is NOT a proof of empty SVG paint (e.g. a bow-tie).
// No pixel tolerance, raster sampling, or EPS-based deletion is used here.
const view = new DataView(new ArrayBuffer(8));
function dyadic(value) {
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  return { n: (bits >> 63n ? -1n : 1n) * (exponent ? fraction + (1n << 52n) : fraction), e: exponent ? exponent - 1075 : -1074 };
}
const cross = (a,b) => a[0]*b[1]-a[1]*b[0];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
const equal = (a,b) => a[0]===b[0] && a[1]===b[1];

function scaledArea(n, exponent) {
  if (n===0n) return 0;
  const sign=n<0n?-1:1, positive=n<0n?-n:n;
  const shift=Math.max(0,positive.toString(2).length-53);
  const top=Number(positive >> BigInt(shift))/60;
  const power=Math.floor(Math.log2(top));
  return sign*(top/(2**power))*(2**(2*exponent+shift+power));
}

export function contourPaintFacts(part) {
  const values=part.segments.flatMap(s=>s.slice(1));
  if(values.some(n=>!Number.isFinite(n))) return null;
  const decoded=values.map(dyadic);
  let exponent=Infinity;for(const v of decoded)if(v.n!==0n)exponent=Math.min(exponent,v.e);
  if(exponent===Infinity)exponent=0;
  let index=0;
  const segments=part.segments.map(s=>[s[0],...s.slice(1).map(()=>{
    const v=decoded[index++];return v.n===0n?0n:v.n << BigInt(v.e-exponent);
  })]);
  const start=segments[0].slice(-2), points=[], edges=[];
  let current=start, integral=0n, endpointClosed=false;
  for(const s of segments.slice(1)) {
    if(s[0]==='Z')endpointClosed=equal(current,start);
    const end=s[0]==='Z'?start:s.slice(-2);
    if(s[0]==='C') {
      const c1=s.slice(1,3),c2=s.slice(3,5);
      points.push(current,c1,c2,end);
      // Cubic power coefficients, translated to the subpath origin. Green's
      // theorem integrates x dy-y dx exactly; area = integral / 60 * 2^(2e).
      const p0=sub(current,start), a=sub(c1,current), b=sub(c2,c1), c=sub(end,c2);
      const p1=a.map(v=>3n*v),p2=a.map((v,i)=>3n*(b[i]-v)),p3=a.map((v,i)=>v-2n*b[i]+c[i]);
      integral+=30n*(cross(p0,p1)+cross(p0,p2)+cross(p0,p3))+10n*cross(p1,p2)+15n*cross(p1,p3)+6n*cross(p2,p3);
      if(![c1,c2,end].every(p=>equal(p,current))) edges.push([current,c1,c2,end]);
    } else {
      points.push(current,end);
      integral+=30n*cross(sub(current,start),sub(end,start));
      if(!equal(current,end))edges.push([current,end]);
    }
    current=end;
  }
  if(!equal(current,start)) {
    // SVG fill always includes the implicit closing edge; stroke does not.
    integral+=30n*cross(sub(current,start),[0n,0n]);
    edges.push([current,start]);
  }
  const direction=points.find(p=>!equal(p,start));
  const collinear=integral===0n && (!direction || points.every(p=>cross(sub(direction,start),sub(p,start))===0n));
  // An exactly retraced chain has zero winding everywhere off its boundary,
  // under BOTH nonzero and evenodd. Keep directed cubic controls, not samples.
  const balances=new Map();
  if(integral===0n && !collinear)for(const edge of edges) {
    const key=edge.map(p=>p.join(',')).join(';'), reverse=[...edge].reverse().map(p=>p.join(',')).join(';');
    if((balances.get(reverse)||0)>0) {const n=balances.get(reverse)-1;if(n)balances.set(reverse,n);else balances.delete(reverse);}
    else balances.set(key,(balances.get(key)||0)+1);
  }
  const paintless=collinear || (integral===0n && balances.size===0);
  return { paintless, proof:collinear?'collinear-control-hull':paintless?'exact-retraced-edges':null,
    signedArea:scaledArea(integral,exponent), areaSign:integral<0n?-1:integral>0n?1:0,
    segments:part.segments.length-1, explicitClosure:part.segments.at(-1)[0]==='Z', geometricClosure:equal(current,start),
    endpointClosed:part.segments.at(-1)[0]==='Z'?endpointClosed:equal(current,start) };
}
