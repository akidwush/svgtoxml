import { readFileSync, writeFileSync } from 'node:fs';
import { serializePathForAlight, MAX_ALIGHT_PATH_CHARS } from '../lib/path-geometry.js';
import { validateAlightImportXml } from '../lib/alight-compatibility.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('inputPath dan outputPath wajib diisi.');

const source = readFileSync(inputPath, 'utf8');
let changed = 0;
const repaired = source.replace(/<path d="([^"]*)"\s*\/>/g, (tag, d) => {
  if (d.length <= MAX_ALIGHT_PATH_CHARS) return tag;
  const safe = serializePathForAlight(d, 8);
  changed += 1;
  return `<path d="${safe}" />`;
});

const validation = validateAlightImportXml(repaired);
writeFileSync(outputPath, repaired, 'utf8');
process.stdout.write(JSON.stringify({ changed, bytes: Buffer.byteLength(repaired), validation }));
