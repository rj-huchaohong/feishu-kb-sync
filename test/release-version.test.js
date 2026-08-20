'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextVersion, modeLabel } = require('../scripts/release-version.js');

test('release defaults to the current version without incrementing', () => {
  assert.equal(nextVersion('0.1.3', 'current'), '0.1.3');
  assert.equal(modeLabel('current'), '当前版本（不递增）');
});

test('explicit patch and minor modes increment the version', () => {
  assert.equal(nextVersion('0.1.3', 'patch'), '0.1.4');
  assert.equal(nextVersion('0.1.3', 'minor'), '0.2.0');
});
