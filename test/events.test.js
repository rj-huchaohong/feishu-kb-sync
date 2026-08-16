'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../lib/config.js');
const http = require('../lib/feishu-http.js');
const cli = require('../lib/cli.js');
const {
  subscribe,
  extractNodeToken,
  fileTypeForNode,
  parseFlags,
  USAGE,
} = require('../lib/events.js');

function captureConsole(t) {
  const lines = [];
  const originalLog = console.log;
  t.after(() => {
    console.log = originalLog;
  });
  console.log = (...args) => lines.push(args.join(' '));
  return lines;
}

function stub(t, object, key, value) {
  const original = object[key];
  object[key] = value;
  t.after(() => {
    object[key] = original;
  });
}

test('extractNodeToken accepts Wiki URLs and raw node tokens', () => {
  assert.equal(
    extractNodeToken('https://ruijie.feishu.cn/wiki/PMBiwkohjiP9XmkLRiHc5QsunSc?fromScene=spaceOverview'),
    'PMBiwkohjiP9XmkLRiHc5QsunSc'
  );
  assert.equal(extractNodeToken('PMBiwkohjiP9XmkLRiHc5QsunSc'), 'PMBiwkohjiP9XmkLRiHc5QsunSc');
});

test('extractNodeToken rejects malformed and Wiki space URLs', () => {
  assert.throws(
    () => extractNodeToken('https://ruijie.feishu.cn/wiki/space/7669414055416695988'),
    /具体 Wiki 节点链接/
  );
  assert.throws(
    () => extractNodeToken('https://ruijie.feishu.cn/docs/abc'),
    /未找到 Wiki node_token/
  );
  assert.throws(() => extractNodeToken(''), /请提供 Wiki 链接或 node_token/);
});

test('fileTypeForNode uses the underlying cloud document type', () => {
  assert.equal(fileTypeForNode({ obj_type: 'docx' }), 'docx');
  assert.equal(fileTypeForNode({ obj_type: ' FILE ' }), 'file');
  assert.throws(() => fileTypeForNode({ obj_type: 'wiki' }), /暂不支持/);
  assert.throws(() => fileTypeForNode({}), /未返回底层 obj_type/);
});

test('parseFlags accepts --json and rejects unknown arguments', () => {
  assert.deepEqual(parseFlags(['--json']), { json: true });
  assert.deepEqual(parseFlags([]), { json: false });
  assert.throws(() => parseFlags(['--force']), new RegExp(`未知参数: --force.*${USAGE}`));
});

test('subscribe resolves a Wiki node and calls the underlying document subscription endpoint', async (t) => {
  const output = captureConsole(t);
  const calls = [];
  stub(t, config, 'loadConfig', () => ({ spaces: { '测试知识库': 'space-1' } }));
  stub(t, http, 'nodeGet', async (nodeToken) => {
    assert.equal(nodeToken, 'parent-node');
    return {
      space_id: 'space-1',
      title: '父页面',
      obj_token: 'obj-token/1',
      obj_type: 'docx',
    };
  });
  stub(t, http, 'api', async (method, path, options) => {
    calls.push({ method, path, options });
    return { code: 0, msg: 'Success', data: {} };
  });

  const result = await subscribe(['测试知识库', 'https://ruijie.feishu.cn/wiki/parent-node', '--json']);

  assert.equal(result.ok, true);
  assert.equal(result.space_id, 'space-1');
  assert.equal(result.obj_token, 'obj-token/1');
  assert.equal(result.file_type, 'docx');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/drive/v1/files/obj-token%2F1/subscribe',
    options: { query: { file_type: 'docx' }, bucket: 'wiki' },
  });
  assert.match(output.join('\n'), /"obj_token": "obj-token\/1"/);
});

test('subscribe rejects a node from another configured knowledge base before writing', async (t) => {
  const output = captureConsole(t);
  let apiCalled = false;
  stub(t, config, 'loadConfig', () => ({ spaces: { '测试知识库': 'space-1' } }));
  stub(t, http, 'nodeGet', async () => ({
    space_id: 'space-2',
    title: '其他页面',
    obj_token: 'obj-token',
    obj_type: 'docx',
  }));
  stub(t, http, 'api', async () => {
    apiCalled = true;
    return { code: 0 };
  });

  await assert.rejects(
    () => subscribe(['测试知识库', 'parent-node']),
    /目标节点不属于知识库「测试知识库」/
  );
  assert.equal(apiCalled, false);
  assert.deepEqual(output, []);
});

test('subscribe reports missing node metadata and wraps remote failures', async (t) => {
  stub(t, config, 'loadConfig', () => ({ spaces: { '测试知识库': 'space-1' } }));

  stub(t, http, 'nodeGet', async () => ({ space_id: 'space-1', obj_type: 'docx' }));
  await assert.rejects(
    () => subscribe(['测试知识库', 'parent-node']),
    /没有底层 obj_token/
  );

  stub(t, http, 'nodeGet', async () => {
    throw new Error('401 Unauthorized');
  });
  await assert.rejects(
    () => subscribe(['测试知识库', 'parent-node']),
    /解析 Wiki 节点失败.*401 Unauthorized/
  );
});

test('subscribe rejects unsupported flags and remote subscription failures', async (t) => {
  stub(t, config, 'loadConfig', () => ({ spaces: { '测试知识库': 'space-1' } }));
  stub(t, http, 'nodeGet', async () => ({
    space_id: 'space-1',
    title: '父页面',
    obj_token: 'obj-token',
    obj_type: 'docx',
  }));

  await assert.rejects(
    () => subscribe(['测试知识库', 'parent-node', '--unexpected']),
    /未知参数: --unexpected/
  );

  stub(t, http, 'api', async () => {
    throw new Error('403 Forbidden');
  });
  await assert.rejects(
    () => subscribe(['测试知识库', 'parent-node']),
    /提交文档事件订阅失败.*403 Forbidden/
  );
});

test('CLI exposes group and command help without contacting Feishu', async (t) => {
  const output = captureConsole(t);

  await cli.run(['events', '--help']);
  await cli.run(['events', 'subscribe', '--help']);

  const text = output.join('\n');
  assert.match(text, /events subscribe <知识库名称> <Wiki链接\|node_token> \[--json\]/);
  assert.match(text, /用法:/);
});