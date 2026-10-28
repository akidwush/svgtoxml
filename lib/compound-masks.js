import svgpath from 'svgpath';

// Experimental contour decomposition for the native Alight exclude-mask mode.
// This never connects contours with fabricated lines. Restrict to topology
// that can be represented exactly as one outer ring plus independent holes.
// On unknown/intersecting/island topology return null (safe fallback).
const LIMIT_CONTOURS = 256;
const LIMIT_SEGMENTS = 12000;
const SAMPLES_PER_CUBIC = 12;
const EPS = 1e-7;

function decodePath(d) {
  const parsed = svgpath(String(d || '')).abs().unshort().unarc();
  if (parsed.err) return null;
  const contours = [];
  let current = null;
  let total = 0;
  for (const seg of parsed.segments) {
    const cmd = seg[0].toUpperCase();
    if (!['M', 'L', 'C', 'Z'].includes(cmd)) return null;
    if (cmd === 'M') {
      if (current) contours.push(current);
      current = { start: seg.slice(1), commands: [seg] };
    } else {
      if (!current) return null;
      current.commands.push(seg);
      if (cmd === 'Z') {
        contours.push(current);
        current = null;
      }
    }
    total++;
    if (total > LIMIT_SEGMENTS || contours.length > LIMIT_CONTOURS) return null;
  }
  if (current) contours.push(current); // SVG implicitly closes at next M / EOF
  if (contours.length < 2 || contours.length > LIMIT_CONTOURS) return null;
  return contours;
}

function polygonPoints(contour) {
  const points = [contour.start];
  let point = contour.start;
  for (const seg of contour.commands.slice(1)) {
    if (seg[0] === 'Z') continue;
    if (seg[0] === 'L') {
      point = seg.slice(1);
      points.push(point);
    } else if (seg[0] === 'C') {
      const [x0, y0] = point;
      const [, x1, y1, x2, y2, x3, y3] = seg;
      for (let step = 1; step <= SAMPLES_PER_CUBIC; step++) {
        const t = step / SAMPLES_PER_CUBIC;
        const u = 1 - t;
        points.push([
          u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3,
          u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3
        ]);
      }
      point = [x3, y3];
    } else return null;
  }
  if (points.length < 3) return null;
  return points;
}

function signedArea(polygon) {
  let a = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x,y] = polygon[i], [xx,yy] = polygon[(i+1)%polygon.length];
    a += x*yy - xx*y;
  }
  return a/2;
}

function bounds(points) {
  return {
    minX: Math.min(...points.map(p=>p[0])),
    maxX: Math.max(...points.map(p=>p[0])),
    minY: Math.min(...points.map(p=>p[1])),
    maxY: Math.max(...points.map(p=>p[1]))
  };
}

function inside(points, p) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a=points[i], b=points[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < (b[0]-a[0]) * (p[1]-a[1]) / (b[1]-a[1]) + a[0]) {
      result = !result;
    }
  }
  return result;
}

function edgeIntersects(a,b,c,d) {
  const cross = (p,q,r) => (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  const u=cross(a,b,c), v=cross(a,b,d), w=cross(c,d,a), x=cross(c,d,b);
  return u*v < -EPS && w*x < -EPS;
}

function crosses(a,b) {
  for(let i=0;i<a.length;i++) {
    const p=a[i], q=a[(i+1)%a.length];
    for(let j=0;j<b.length;j++) {
      if(edgeIntersects(p,q,b[j],b[(j+1)%b.length]))return true;
    }
  }
  return false;
}

function pathString(contour) {
  const segments = contour.commands.map(s => s[0] === 'Z'
    ? 'Z' : s[0] + ' ' + s.slice(1).join(' '));
  if (contour.commands[contour.commands.length-1][0] !== 'Z') segments.push('Z');
  return segments.join(' ');
}

export function planCompoundMasks(d, { fillRule = 'nonzero' } = {}) {
  const contours = decodePath(d);
  if (!contours || !['nonzero','evenodd'].includes(fillRule)) return null;
  const polygons = contours.map(polygonPoints);
  if (polygons.some(p=>!p)) return null;
  const areas = polygons.map(signedArea);
  if (areas.some(a=>!Number.isFinite(a) || Math.abs(a) < EPS))return null;

  const outer = polygons[0];
  const outerArea = areas[0];
  const ob=bounds(outer);
  const holes = polygons.slice(1);

  for (let i=0;i<holes.length;i++) {
    const hole=holes[i];
    const hb=bounds(hole);
    if (hb.minX <= ob.minX + EPS || hb.maxX >= ob.maxX-EPS ||
        hb.minY <= ob.minY + EPS || hb.maxY >= ob.maxY-EPS) return null;
    // Under nonzero winding, only opposite-oriented contained rings
    // actually cut holes. Same-orientation rings must not be excluded.
    if (fillRule === 'nonzero' && Math.sign(areas[i+1]) === Math.sign(outerArea)) return null;
    if (Math.abs(areas[i+1]) >= Math.abs(outerArea) ||
        !hole.every(p=>inside(outer,p)) || crosses(outer,hole)) return null;
    for(let j=0;j<i;j++) {
      const other=holes[j], a=bounds(other);
      if (hb.maxX <= a.minX || hb.minX >= a.maxX ||
          hb.maxY <= a.minY || hb.minY >= a.maxY) continue;
      if (inside(hole,other[0]) || inside(other,hole[0]) || crosses(hole,other)) return null;
    }
  }
  return {
    outer: pathString(contours[0]),
    holes: contours.slice(1).map(pathString),
    count: contours.length,
    strategy: 'isolated-exclude-masks'
  };
}
