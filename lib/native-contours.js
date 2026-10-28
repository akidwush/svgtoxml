import svgpath from 'svgpath';

/**
 * Alight Motion Android 5.0.273 native format:
 * <path><contour d="M ... Z"/><contour exclude="true" d="M ... Z"/></path>
 *
 * Unlike stitched "bridges", separate contours never add spurious line work.
 * Preserve original curve segments (no anchor/node simplification).
 * Determine exclusions by the source SVG's nonzero/evenodd fill rule and its
 * contour nesting; do not infer holes from a specific logo's path ordering.
 */

const MAX_CONTOURS = 512;
const MAX_POINTS = 30000;
const EPS = 1e-7;
const BEZIER_STEPS = 12;

function coords(values) {
  return values.slice(-2);
}

function segmentsToString(segments) {
  return segments.map((seg) => seg[0] === 'Z' ? 'Z' :
    seg[0] + ' ' + seg.slice(1).join(' ')).join(' ');
}

function parseSubpaths(d) {
  const parser = svgpath(String(d || '')).abs().unshort().unarc();
  if (parser.err) return null;
  const paths = [];
  let current = null;
  for (const segment of parser.segments) {
    const cmd = segment[0].toUpperCase();
    if (!['M', 'L', 'C', 'Z'].includes(cmd)) return null;
    if (cmd === 'M') {
      if (current) paths.push(current);
      current = { segments: [segment], start: coords(segment) };
    } else {
      if (!current) return null;
      current.segments.push(segment);
      if (cmd === 'Z') {
        paths.push(current);
        current = null;
      }
    }
    if (paths.length > MAX_CONTOURS) return null;
  }
  if (current) paths.push(current);
  if (!paths.length || paths.length > MAX_CONTOURS ||
      paths.some(p => p.segments.length < 2)) return null;
  return paths;
}

function outline(path) {
  const points = [path.start];
  let current = path.start;
  for (const seg of path.segments.slice(1)) {
    if (seg[0] === 'Z') continue;
    if (seg[0] === 'L') {
      current = coords(seg);
      points.push(current);
    } else if (seg[0] === 'C') {
      const [x0,y0] = current;
      const [, x1,y1,x2,y2,x3,y3] = seg;
      for (let i=1;i<=BEZIER_STEPS;i++) {
        const t=i/BEZIER_STEPS, u=1-t;
        points.push([
          u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3,
          u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3
        ]);
      }
      current=[x3,y3];
    }
    if (points.length>MAX_POINTS) return null;
  }
  return points.length>=3 ? points : null;
}

function bounds(points) {
  const b={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
  for (const [x,y] of points) {
    if (x<b.x0) b.x0=x;
    if (x>b.x1) b.x1=x;
    if (y<b.y0) b.y0=y;
    if (y>b.y1) b.y1=y;
  }
  return b;
}
function area(points) {
  let s=0;
  for (let i=0;i<points.length;i++) {
    const [x,y]=points[i], [xx,yy]=points[(i+1)%points.length];
    s+=x*yy-xx*y;
  }
  return s*0.5;
}
function pointIn(poly,p) {
  let inside=false;
  for (let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const a=poly[i],b=poly[j];
    if ((a[1]>p[1]) !== (b[1]>p[1]) &&
      p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
function strictlyContainsBox(a,b) {
  return b.x0>a.x0+EPS && b.x1<a.x1-EPS &&
    b.y0>a.y0+EPS && b.y1<a.y1-EPS;
}
function disjointBoxes(a,b) {
  return a.x1<b.x0-EPS || b.x1<a.x0-EPS ||
    a.y1<b.y0-EPS || b.y1<a.y0-EPS;
}
function crosses(a,b) {
  // Sampling is for conservative topology discovery ONLY; output curves remain exact.
  // Limit comparisons to avoid a quadratic denial-of-service from huge tracings.
  if (a.length*b.length>500000) return null;
  const orient=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  for(let i=0;i<a.length;i++) {
    const p=a[i],q=a[(i+1)%a.length];
    for(let j=0;j<b.length;j++) {
      const r=b[j],s=b[(j+1)%b.length];
      const u=orient(p,q,r),v=orient(p,q,s);
      const w=orient(r,s,p),x=orient(r,s,q);
      if(u*v<-EPS && w*x<-EPS) return true;
      // Endpoint/edge contact must not be mistaken for a disjoint outline.
      const onEdge=(pt,aa,bb)=>pt[0]>=Math.min(aa[0],bb[0])-EPS &&
        pt[0]<=Math.max(aa[0],bb[0])+EPS &&
        pt[1]>=Math.min(aa[1],bb[1])-EPS &&
        pt[1]<=Math.max(aa[1],bb[1])+EPS;
      if ((Math.abs(u)<EPS && onEdge(r,p,q)) ||
          (Math.abs(v)<EPS && onEdge(s,p,q)) ||
          (Math.abs(w)<EPS && onEdge(p,r,s)) ||
          (Math.abs(x)<EPS && onEdge(q,r,s))) return true;
    }
  }
  return false;
}

/**
 * Return a native AM contour plan, or a controlled unsupported-topology error.
 * When a path has a single subpath, use existing <path d="..."> instead.
 * "fill" false is stroke-only: contour exclusions must never trim a stroke.
 */
export function nativeContourPlan(d, { fillRule='nonzero', fill=true }={}) {
  const parts = parseSubpaths(d);
  if (!parts) return {ok:false,code:'NATIVE_CONTOUR_PARSE_UNSUPPORTED'};
  if(parts.length===1) return {
    ok:true,compound:false,contours:[{d:segmentsToString(parts[0].segments),exclude:false}]
  };
  if(!['evenodd','nonzero'].includes(fillRule))return {
    ok:false,code:'NATIVE_CONTOUR_FILL_RULE_UNSUPPORTED'
  };
  if (!fill) return {ok:true,compound:true,contours:parts.map(p=>({
    d:segmentsToString(p.segments),exclude:false
  }))};

  const polys=parts.map(outline);
  if(polys.some(p=>!p))return {ok:false,code:'NATIVE_CONTOUR_GEOMETRY_UNSUPPORTED'};
  const boxes=polys.map(bounds), signed=polys.map(area);
  if(signed.some(n=>!Number.isFinite(n)||Math.abs(n)<EPS))return {
    ok:false,code:'NATIVE_CONTOUR_DEGENERATE'
  };
  const parent=Array(parts.length).fill(-1);
  for(let i=0;i<parts.length;i++) {
    let enclosingArea=Infinity;
    for(let j=0;j<parts.length;j++) {
      if(i===j || disjointBoxes(boxes[i],boxes[j]))continue;
      const crossing=crosses(polys[i],polys[j]);
      if(crossing===true || crossing===null)return {
        ok:false,code:'NATIVE_CONTOUR_OVERLAP_UNSUPPORTED'
      };
      const iInJ=strictlyContainsBox(boxes[j],boxes[i]) &&
        polys[i].every(p=>pointIn(polys[j],p));
      const jInI=strictlyContainsBox(boxes[i],boxes[j]) &&
        polys[j].every(p=>pointIn(polys[i],p));
      if(!iInJ && !jInI) {
        // Two disconnected islands may have overlapping axis-aligned
        // bounding boxes; box overlap alone must never invent containment.
        const partialI=polys[i].some(p=>pointIn(polys[j],p));
        const partialJ=polys[j].some(p=>pointIn(polys[i],p));
        if(!partialI && !partialJ) continue;
        return {ok:false,code:'NATIVE_CONTOUR_TOUCH_UNSUPPORTED'};
      }
      if(iInJ && Math.abs(signed[j])<enclosingArea) {
        enclosingArea=Math.abs(signed[j]);
        parent[i]=j;
      }
    }
  }

  const cache=new Map(), active=new Set();
  function winding(i) {
    if(cache.has(i))return cache.get(i);
    if(active.has(i))throw Error('Circular path contour containment');
    active.add(i);
    const before=parent[i]===-1?0:winding(parent[i]);
    const after=before+Math.sign(signed[i]);
    active.delete(i);
    cache.set(i,after);
    return after;
  }

  let contours;
  try {
    contours=parts.map((p,i)=>{
      const before=parent[i]===-1?0:winding(parent[i]);
      const after=winding(i);
      const depth=(()=>{let k=i,n=0;while(parent[k]!==-1){n++;k=parent[k];if(n>parts.length)throw Error('Cycle');}return n;})();
      const exclude=fillRule==='evenodd' ? depth%2===1 : before!==0 && after===0;
      return {d:segmentsToString(p.segments),exclude,parent:parent[i],depth};
    });
  }catch{return {ok:false,code:'NATIVE_CONTOUR_NESTING_UNSUPPORTED'};}
  return {ok:true,compound:true,contours};
}
