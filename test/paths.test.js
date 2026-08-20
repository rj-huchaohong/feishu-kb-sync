'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSegment, cacheDir, isPathInside } = require('../lib/paths.js');

test('sanitizeSegment prevents titles from changing cache hierarchy', () => {
  assert.equal(sanitizeSegment('  a/b  '), 'a_b');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('...'), '未命名');
});

test('cacheDir stays inside the configured root', () => {
  const root = 'C:\\cache-root';
  const dir = cacheDir(root, '知识库');
  assert.equal(isPathInside(root, dir), true);
  assert.equal(isPathInside(root, 'C:\\other'), false);
});
