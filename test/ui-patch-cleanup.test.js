import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { load } from 'cheerio';
import publicConvertHandler from '../api/convert.js';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Lightweight DOM/event adapter, not browser visual QA. Requests execute the
// real website handler and converter; no mocked conversion results are used.
function createUi() {
  const $ = load(html);
  const elements = new Map();
  for (const node of $('[id]').toArray()) {
    const element = $(node);
    const classes = new Set((element.attr('class') || '').split(/\s+/));
    const options = element.find('option').toArray().map((option) => ({
      value: $(option).attr('value'), text: $(option).text()
    }));
    elements.set(element.attr('id'), {
      value: element.attr('value') || options[0]?.value || '',
      options, selectedIndex: 0, dataset: {}, files: [], disabled: false,
      textContent: '', innerHTML: '', events: {},
      addEventListener(name, listener) { this.events[name] = listener; },
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); }
      }
    });
  }
  const requests = [];
  const downloads = [];
  const blobs = [];
  vm.runInNewContext(app, {
    document: {
      getElementById: (id) => {
        assert.ok(elements.has(id), `Missing UI element: ${id}`);
        return elements.get(id);
      },
      body: { appendChild() {} },
      createElement: () => ({ click() { downloads.push(this.download); }, remove() {} })
    },
    FileReader: class {
      readAsText(file) { this.result = file.content; this.onload(); }
    },
    fetch: async (path, init) => {
      requests.push(JSON.parse(init.body));
      return publicConvertHandler.fetch(new Request(`https://example.test${path}`, init));
    },
    Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout: (fn) => fn()
  });
  return { elements, requests, downloads, blobs };
}

test('UI keeps all three engine choices and toggles Patch Cleanup controls correctly', () => {
  const { elements } = createUi();
  const quality = elements.get('quality');
  assert.deepEqual(quality.options.map((option) => option.value), ['lossless', 'color-group', 'patch-clean']);
  assert.equal(elements.get('patchAreaPercent').disabled, true);
  assert.equal(elements.get('protectThinPercent').disabled, true);
  for (const mode of ['patch-clean', 'color-group', 'lossless', 'patch-clean']) {
    quality.value = mode;
    quality.events.change();
    assert.equal(elements.get('patchAreaPercent').disabled, mode !== 'patch-clean');
    assert.equal(elements.get('protectThinPercent').disabled, mode !== 'patch-clean');
    assert.equal(Number(elements.get('patchAreaPercent').value), 0.01);
    assert.equal(Number(elements.get('protectThinPercent').value), 2);
    for (const [note, noteMode] of [['patchNote', 'patch-clean'], ['losslessNote', 'lossless'], ['colorGroupNote', 'color-group']]) {
      assert.equal(elements.get(note).classList.contains('hidden'), mode !== noteMode);
    }
  }
});

for (const mode of ['patch-clean', 'color-group', 'lossless']) {
  test(`UI ${mode}: file selection → real conversion → stats → XML download`, async () => {
    const { elements, requests, downloads, blobs } = createUi();
    const quality = elements.get('quality');
    quality.value = mode;
    quality.selectedIndex = quality.options.findIndex((option) => option.value === mode);
    quality.events.change();
    elements.get('patchAreaPercent').value = '0.05';
    elements.get('protectThinPercent').value = '3.5';
    const file = elements.get('svgFile');
    file.files = [{
      name: 'cleanup.svg', size: 200, lastModified: 1,
      content: '<svg width="100" height="100"><rect id="main" width="80" height="80" fill="red"/><rect id="dust" x="90" y="90" width=".5" height=".5" fill="blue"/></svg>'
    }];
    file.events.change();
    await elements.get('convertBtn').events.click();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.quality, mode);
    assert.equal(requests[0].options.patchAreaPercent, 0.05);
    assert.equal(requests[0].options.protectThinPercent, 3.5);
    assert.equal(elements.get('resultCard').classList.contains('hidden'), false);
    assert.equal(elements.get('convertBtn').disabled, false);
    assert.match(elements.get('status').textContent, /^Selesai/);
    const xml = elements.get('xmlOutput').value;
    assert.match(xml, /<scene title="cleanup"/);
    if (mode === 'patch-clean') {
      assert.doesNotMatch(xml, /label="dust"/);
      assert.match(elements.get('resultTitle').textContent, /Small Patch Cleanup/);
      assert.match(elements.get('stats').innerHTML, /Patch\/subpath dibuang/);
      assert.match(elements.get('status').textContent, /1 shape mikro dibuang/);
    } else {
      assert.match(xml, /label="dust"/);
      assert.doesNotMatch(elements.get('stats').innerHTML, /Patch\/subpath dibuang/);
      if (mode === 'color-group') assert.match(elements.get('stats').innerHTML, /Overlap aktual/);
    }
    elements.get('downloadBtn').events.click();
    assert.deepEqual(downloads, ['cleanup-alight.xml']);
    assert.equal(await blobs[0].text(), xml);
    assert.equal(blobs[0].type, 'application/xml;charset=utf-8');
  });
}
