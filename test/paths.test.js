'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  sanitizeSegment,
  cacheDir,
  legacyCacheDir,
  isPathInside,
} = require('../lib/paths.js');

const ROOT = path.join('C:', 'cache');

test('sanitizeSegment converts unsafe titles into one safe path segment', () => {
  assert.equal(sanitizeSegment('  交换机:日志?  '), '交换机_日志');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('...'), '未命名');
});

test('cacheDir uses the configured knowledge-base name and legacyCacheDir keeps space_id compatibility', () => {
  assert.equal(cacheDir(ROOT, '技术知识库'), path.join(ROOT, '技术知识库'));
  assert.equal(legacyCacheDir(ROOT, '7263753032704196609'), path.join(ROOT, '7263753032704196609'));
});

test('isPathInside accepts managed descendants and rejects sibling paths', () => {
  const managed = path.join(ROOT, '技术知识库', 'docs', '指导书.docx');
  const sibling = path.join(ROOT, '其他知识库', 'docs', '指导书.docx');
  assert.equal(isPathInside(path.join(ROOT, '技术知识库'), managed), true);
  assert.equal(isPathInside(path.join(ROOT, '技术知识库'), sibling), false);
});
