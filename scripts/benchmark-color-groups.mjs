import { performance } from 'node:perf_hooks';
import { convertSvgToAlightXml } from '../lib/converter.js';

const sizes = [100, 500, 1000, 3000];
const colors = ['#152839', '#7bc9f1', '#3d5363', '#ffffff', '#d33a4a', '#7556d8', '#241c35', '#e8bd68', '#2f865f', '#7b8794'];

function fixture(count) {
  const columns = Math.ceil(Math.sqrt(count));
  const shapes = Array.from({ length: count }, (_, index) => {
    const x = (index % columns) * 6;
    const y = Math.floor(index / columns) * 6;
    return `<rect x="${x}" y="${y}" width="4" height="4" fill="${colors[index % colors.length]}"/>`;
  }).join('');
  const side = columns * 6;
  return `<svg width="${side}" height="${side}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`;
}

const report = [];
for (const inputShapes of sizes) {
  const svg = fixture(inputShapes);
  const started = performance.now();
  const output = convertSvgToAlightXml(svg, { quality: 'color-groups', includeTimings: true });
  const elapsed = performance.now() - started;
  report.push({
    inputShapes,
    parseMs: output.grouping.timingsMs.parse,
    analysisMs: output.grouping.timingsMs.analysis,
    planningMs: output.grouping.timingsMs.planning,
    serializationAndValidationMs: output.grouping.timingsMs.serializationAndValidation,
    totalMs: Number(elapsed.toFixed(3)),
    boundsCandidates: output.grouping.overlapCandidates,
    geometryChecks: output.grouping.geometryChecks,
    outputLayers: output.grouping.outputLayers,
    outputBytes: output.stats.outputBytes
  });
}

console.table(report);
