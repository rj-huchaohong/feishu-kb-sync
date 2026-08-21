'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseLarkCliAccount,
  selectLarkCliAuthCandidate,
} = require('../lib/auth.js');

test('parses dynamic lark-cli account names without hardcoded identities', () => {
  assert.deepEqual(
    parseLarkCliAccount('cli_dynamic:ou_dynamic'),
    { appId: 'cli_dynamic', userOpenId: 'ou_dynamic' },
  );
  assert.deepEqual(
    parseLarkCliAccount('appsecret:cli_dynamic'),
    { appId: 'cli_dynamic', userOpenId: null },
  );
});

test('selects the active lark-cli app and user from multiple credentials', () => {
  const entries = [
    {
      account: 'cli_first:ou_first',
      value: JSON.stringify({ access_token: 'token-first', app_id: 'cli_first', user_open_id: 'ou_first' }),
    },
    {
      account: 'cli_second:ou_second',
      value: JSON.stringify({ access_token: 'token-second', app_id: 'cli_second', user_open_id: 'ou_second' }),
    },
  ];

  const selected = selectLarkCliAuthCandidate(entries, {
    appId: 'cli_second',
    onBehalfOf: { openId: 'ou_second' },
  });

  assert.equal(selected.appId, 'cli_second');
  assert.equal(selected.userOpenId, 'ou_second');
  assert.equal(selected.raw.access_token, 'token-second');
});

test('does not guess when multiple credentials cannot be matched', () => {
  const entries = [
    { account: 'cli_first:ou_first', value: JSON.stringify({ access_token: 'token-first' }) },
    { account: 'cli_second:ou_second', value: JSON.stringify({ access_token: 'token-second' }) },
  ];
  assert.equal(selectLarkCliAuthCandidate(entries, null), null);
});
