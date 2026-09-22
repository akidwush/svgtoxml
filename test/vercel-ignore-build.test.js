import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyVercelBuild } from '../scripts/vercel-ignore-build.mjs';

test('Vercel gate skips explicit small-fix marker', () => {
  const result = classifyVercelBuild({
    message: 'fix: typo kecil [skip-vercel]',
    changedFiles: ['lib/converter.js']
  });
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'skip-deploy-marker');
});

test('Vercel gate lets force deploy override skip marker', () => {
  const result = classifyVercelBuild({
    message: 'release [skip-vercel] [deploy-vercel]',
    changedFiles: ['README.md']
  });
  assert.equal(result.skip, false);
  assert.equal(result.reason, 'force-deploy-marker');
});

test('Vercel gate automatically skips docs and test-only commits', () => {
  const result = classifyVercelBuild({
    message: 'docs: update notes',
    changedFiles: ['README.md', 'docs/deploy.md', 'test/converter.test.js']
  });
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'non-runtime-only');
});

test('Vercel gate builds runtime changes by default', () => {
  const result = classifyVercelBuild({
    message: 'fix: converter runtime',
    changedFiles: ['lib/converter.js']
  });
  assert.equal(result.skip, false);
  assert.equal(result.reason, 'runtime-change');
});

test('Vercel gate treats vercel.json as deploy-relevant', () => {
  const result = classifyVercelBuild({
    message: 'chore: change deployment configuration',
    changedFiles: ['vercel.json']
  });
  assert.equal(result.skip, false);
  assert.equal(result.reason, 'runtime-change');
});
