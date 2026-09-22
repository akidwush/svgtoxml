#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const FORCE_DEPLOY = /\[(?:deploy|force)[ -]?vercel\]|\[deploy\]/i;
const SKIP_DEPLOY = /\[(?:skip|no)[ -]?vercel\]|\[(?:skip|no)[ -]?deploy\]/i;

const NON_RUNTIME_PATTERNS = [
  /\.md$/i,
  /^docs\//i,
  /^test\//i,
  /^tests\//i,
  /^scripts\/test[-/]/i,
  /^\.github\//i,
  /^\.gitignore$/i,
  /^\.editorconfig$/i,
  /^LICENSE(?:\..*)?$/i,
  /^CHANGELOG(?:\..*)?$/i,
  /^scripts\/vercel-ignore-build\.mjs$/i
];

export function classifyVercelBuild({ message = '', changedFiles = [] } = {}) {
  const files = changedFiles.map((file) => String(file).trim()).filter(Boolean);

  if (FORCE_DEPLOY.test(message)) {
    return { skip: false, reason: 'force-deploy-marker' };
  }

  if (SKIP_DEPLOY.test(message)) {
    return { skip: true, reason: 'skip-deploy-marker' };
  }

  if (files.length > 0 && files.every((file) => NON_RUNTIME_PATTERNS.some((pattern) => pattern.test(file)))) {
    return { skip: true, reason: 'non-runtime-only' };
  }

  return { skip: false, reason: files.length ? 'runtime-change' : 'no-diff-evidence' };
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function readCommitMessage() {
  if (process.env.VERCEL_GIT_COMMIT_MESSAGE) {
    return process.env.VERCEL_GIT_COMMIT_MESSAGE;
  }

  try {
    return git(['log', '-1', '--pretty=%B']);
  } catch {
    return '';
  }
}

function readChangedFiles() {
  try {
    git(['rev-parse', 'HEAD^']);
    return git(['diff', '--name-only', 'HEAD^', 'HEAD'])
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const message = readCommitMessage();
  const changedFiles = readChangedFiles();
  const decision = classifyVercelBuild({ message, changedFiles });
  const branch = process.env.VERCEL_GIT_COMMIT_REF || 'unknown';

  console.log('[vercel-gate] branch:', branch);
  console.log('[vercel-gate] decision:', decision.skip ? 'SKIP BUILD' : 'BUILD');
  console.log('[vercel-gate] reason:', decision.reason);
  console.log('[vercel-gate] changed files:', changedFiles.length ? changedFiles.join(', ') : '(unknown/none)');

  // Vercel Ignored Build Step contract:
  // exit 0 = skip/cancel build
  // exit 1 = continue build
  process.exit(decision.skip ? 0 : 1);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
