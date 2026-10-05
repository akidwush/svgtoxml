import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALIGHT_SCHEMA_PROFILE,
  alightSchemaAttributes,
  inspectAlightXmlStructure,
  validateAlightImportXml
} from '../lib/alight-compatibility.js';
import { convertSvgToAlightXml } from '../lib/converter.js';
import { MAX_ALIGHT_PATH_CHARS } from '../lib/path-geometry.js';

const knownHealthyExtract = readFileSync(
  fileURLToPath(new URL('./fixtures/known-healthy-am-6.2.53-extract.xml', import.meta.url)),
  'utf8'
);

function validXml(inner = '') {
  return `<?xml version='1.0' encoding='UTF-8' ?>
<scene title="Compatibility Test" width="100" height="100" exportWidth="100" exportHeight="100" bgcolor="#00000000" totalTime="1000" fps="30" modifiedTime="1" ${alightSchemaAttributes()}>
  <embedScene id="300000001" label="Wrapper" startTime="0" endTime="1000" fillType="intrinsic" outTime="1000" mediaFillMode="fill">
    <transform><location value="50,50,0"/></transform>
    <fillColor value="#ff000000"/>
    <scene title="" width="100" height="100" exportWidth="100" exportHeight="100" bgcolor="#00000000" totalTime="1000" fps="30" modifiedTime="0" ${alightSchemaAttributes({ nested: true })}>
      ${inner || '<shape id="1" label="Path" startTime="0" endTime="1000" fillType="color" mediaFillMode="fill"><transform><location value="50,50,0"/></transform><fillColor value="#ffffffff"/><path d="M-10 -10L10 -10L10 10L-10 10Z"/></shape>'}
    </scene>
  </embedScene>
</scene>`;
}

function expectCompatibilityFailure(xml) {
  assert.throws(
    () => validateAlightImportXml(xml),
    (error) => error?.code === 'ALIGHT_XML_COMPATIBILITY_FAILED' && error?.validation?.ok === false
  );
}

test('known healthy Alight export extract defines structural invariants without regex assumptions', () => {
  const summary = inspectAlightXmlStructure(knownHealthyExtract);
  assert.equal(summary.root, 'scene');
  assert.equal(summary.declaration, true);
  assert.deepEqual(summary.profileTuples, ['859|107|com.alightcreative.motion/6.2.53|ios']);
  assert.equal(summary.nestedMetadataConsistent, true);
  assert.equal(summary.embedSceneMissingOutTime, 1);
  assert.equal(summary.scopedDuplicateIds.length, 0);
  assert.ok(summary.globalDuplicateIds > 0);
  assert.ok(summary.nativePrimitiveCount > 0);
});

test('generated structures preserve fixture-backed scene, nesting, timeline and transform invariants', () => {
  const svg = `<svg width="120" height="80" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(4 5) rotate(3)">
      <rect x="5" y="6" width="40" height="20" fill="#ef4444"/>
      <path d="M5 55 C25 25 55 70 95 35" fill="none" stroke="#0f172a" stroke-width="3"/>
    </g>
  </svg>`;
  const output = convertSvgToAlightXml(svg, { quality: 'maximum-fidelity', duration: 1200, fps: 30 });
  const summary = inspectAlightXmlStructure(output.xml);
  assert.equal(summary.root, 'scene');
  assert.equal(summary.declaration, true);
  assert.deepEqual(summary.profileTuples, [
    [ALIGHT_SCHEMA_PROFILE.amver, ALIGHT_SCHEMA_PROFILE.ffver, ALIGHT_SCHEMA_PROFILE.am, ALIGHT_SCHEMA_PROFILE.amplatform].join('|')
  ]);
  assert.equal(summary.nestedMetadataConsistent, true);
  assert.equal(summary.embedSceneMissingOutTime, 0);
  assert.equal(summary.scopedDuplicateIds.length, 0);
  assert.ok(summary.pathCount > 0);
  assert.ok(summary.pathStrokeCount > 0);
});

test('compatibility validator rejects malformed and incompatible XML fail closed', () => {
  const valid = validXml();
  assert.equal(validateAlightImportXml(valid).ok, true);

  const cases = [
    valid.replace(' outTime="1000"', ''),
    valid.replace('id="1" label="Path"', 'id="1" label="Path"')
      .replace('</shape>', '</shape><shape id="1" label="Duplicate" startTime="0" endTime="1000" fillType="color" s=".rect"><transform><location value="1,1,0"/></transform><fillColor value="#ffffffff"/></shape>'),
    valid.replace('value="50,50,0"', 'value="NaN,50,0"'),
    valid.replace('value="50,50,0"', 'value="Infinity,50,0"'),
    valid.replace('d="M-10 -10L10 -10L10 10L-10 10Z"', 'd="M0 0 L"'),
    valid.replace('ffver="106"', 'ffver="999"'),
    valid.replace('<scene title=""', '<broken><scene title=""'),
    valid.replace('</scene>\n  </embedScene>', '</embedScene>'),
    valid.replace('Compatibility Test', 'Compatibility\u0001Test'),
    valid.replace('width="100"', 'width="-1"')
  ];
  cases.forEach(expectCompatibilityFailure);
});

test('compatibility validator rejects a path above the Android importer budget', () => {
  const oversized = `M 0 0${'L 1.123456 1.123456'.repeat(500)}`;
  assert.ok(oversized.length > MAX_ALIGHT_PATH_CHARS);
  expectCompatibilityFailure(validXml().replace('M-10 -10L10 -10L10 10L-10 10Z', oversized));
});

test('layer IDs are unique per scene scope, not globally', () => {
  const xml = validXml('<shape id="300000001" label="Scoped reuse" startTime="0" endTime="1000" fillType="color" s=".rect"><transform><location value="50,50,0"/></transform><fillColor value="#ffffffff"/><property name="size" type="vec2" value="10,10"/></shape>');
  const result = validateAlightImportXml(xml);
  assert.equal(result.ok, true);
});

test('validator handles 10,000 legal layers without ID collision', () => {
  const layers = Array.from({ length: 10000 }, (_, index) =>
    `<shape id="${100000001 + index}" label="Layer ${index + 1}" startTime="0" endTime="1000" fillType="color" s=".rect"><transform><location value="1,1,0"/></transform><fillColor value="#ffffffff"/><property name="size" type="vec2" value="1,1"/></shape>`
  ).join('');
  const xml = `<?xml version='1.0' encoding='UTF-8' ?>\n<scene title="10k" width="100" height="100" exportWidth="100" exportHeight="100" bgcolor="#00000000" totalTime="1000" fps="30" modifiedTime="1" ${alightSchemaAttributes()}>${layers}</scene>`;
  const result = validateAlightImportXml(xml);
  assert.equal(result.ok, true);
  assert.equal(result.layerCount, 10000);
});
