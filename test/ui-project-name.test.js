import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('standalone UI exposes a separate Alight Motion project name', () => {
  assert.match(html, /id="projectName"[^>]*maxlength="80"/);
  assert.match(html, /Nama project Alight Motion/);
  assert.match(app, /title: normalizedProjectName\(projectName\.value, lastBaseName\)/);
  assert.match(app, /replace\(\/\[\\u0000-\\u001F\\u007F\]\/g, ' '\)/);
  assert.match(app, /slice\(0, 80\)/);
  assert.match(app, /a\.download = \x60\$\{lastBaseName\}-alight\.xml\x60/);
});
