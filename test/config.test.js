'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpaceId, parseAddArgs } = require('../lib/config.js');

test('parseSpaceId accepts a space id and a space URL', () => {
  assert.equal(parseSpaceId('7659409018099616732'), '7659409018099616732');
  assert.equal(
    parseSpaceId('https://example.feishu.cn/wiki/space/7659409018099616732'),
    '7659409018099616732',
  );
});

test('parseSpaceId rejects a node URL with an actionable message', () => {
  assert.throws(
    () => parseSpaceId('https://example.feishu.cn/wiki/NZ09wYWfPiDy6ekj7xOckL1FnVd'),
    /node-token|space_id/i,
  );
});

test('parseAddArgs keeps the configuration interface narrow', () => {
  assert.deepEqual(parseAddArgs(['故障根因定位', '7659409018099616732']), {
    name: '故障根因定位',
    link: '7659409018099616732',
  });
  assert.throws(() => parseAddArgs(['only-name']), /用法/);
  assert.throws(() => parseAddArgs(['name', 'id', 'extra']), /用法/);
});
