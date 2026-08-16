'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../lib/cli.js');
const sync = require('../lib/sync.js');

function stub(t, object, key, value) {
  const original = object[key];
  object[key] = value;
  t.after(() => {
    object[key] = original;
  });
}

test('CLI dispatches sync arguments including the knowledge-base name', async (t) => {
  let received;
  stub(t, sync, 'sync', async (argv) => {
    received = argv;
  });

  await cli.run(['sync', '测试知识库', '--background', '--json']);
  assert.deepEqual(received, ['测试知识库', '--background', '--json']);
});

test('CLI dispatches top-level status arguments to sync.status', async (t) => {
  let received;
  stub(t, sync, 'status', async (argv) => {
    received = argv;
  });

  await cli.run(['status', '测试知识库', '--json']);
  assert.deepEqual(received, ['测试知识库', '--json']);
});

test('CLI help contains the stable sync, status, and Skill lifecycle contracts', async (t) => {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  t.after(() => {
    console.log = originalLog;
  });

  await cli.run([]);
  const help = output.join('\n');
  assert.doesNotMatch(help, /`n/);
  assert.match(help, /config add/);
  assert.match(help, /--skill-suffix/);
  assert.match(help, /config remove .*专属 Skill/);
  assert.match(help, /sync .*--space-id <id>.*--background.*--json/);
  assert.match(help, /status <库名> \[--json\]/);
});

test('sync parser accepts ASCII space_id for scheduled workers', () => {
  assert.deepEqual(sync.parseSyncArgs(['--space-id', 'space-1', '--background', '--json']), {
    kbName: null,
    spaceId: 'space-1',
    all: false,
    force: false,
    background: true,
    json: true,
    worker: false,
    runId: null,
    trigger: 'manual',
    reason: 'manual trigger',
  });
});


test('executeAllSync runs knowledge bases sequentially and returns each result', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-sync-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const contexts = [
    { kbName: 'alpha', spaceId: 'space-a', cachePath: 'C:\\cache\\alpha', paths: { logFile: 'alpha.log' } },
    { kbName: 'beta', spaceId: 'space-b', cachePath: 'C:\\cache\\beta', paths: { logFile: 'beta.log' } },
  ];
  const order = [];
  let active = 0;
  let maxActive = 0;
  const result = await sync.executeAllSync(contexts, { appDir: root, trigger: 'scheduled' }, async (context) => {
    order.push(context.kbName);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { counts: { added: 0, updated: 0, moved: 0, deleted: 0, unchanged: 0, failed: 0 }, summary: null };
  });

  assert.deepEqual(order, ['alpha', 'beta']);
  assert.equal(maxActive, 1);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.knowledge_bases.map((item) => item.knowledge_base), ['alpha', 'beta']);
});

test('sync parser accepts the all-knowledge-base scope', () => {
  assert.deepEqual(sync.parseSyncArgs(['--all', '--trigger', 'scheduled', '--background']), {
    kbName: null,
    spaceId: null,
    all: true,
    force: false,
    background: true,
    json: false,
    worker: false,
    runId: null,
    trigger: 'scheduled',
    reason: 'scheduled task',
  });
});

test('sync resolves a configured knowledge base by space_id', () => {
  const context = sync.resolveKnowledgeBase(null, { root: 'C:\\cache', spaces: { 'test-kb': 'space-1' } }, 'space-1');
  assert.equal(context.kbName, 'test-kb');
  assert.equal(context.spaceId, 'space-1');
});

test('sync parser accepts an ASCII space_id for scheduled invocations', () => {
  assert.deepEqual(sync.parseSyncArgs(['--space-id', '7263753032704196609', '--background', '--json']), {
    kbName: null,
    spaceId: '7263753032704196609',
    all: false,
    force: false,
    background: true,
    json: true,
    worker: false,
    runId: null,
    trigger: 'manual',
    reason: 'manual trigger',
  });
});

test('sync parser records the trigger type and optional reason', () => {
  const scheduled = sync.parseSyncArgs(['--space-id', 'space-1', '--trigger', 'scheduled']);
  assert.equal(scheduled.trigger, 'scheduled');
  assert.equal(scheduled.reason, 'scheduled task');

  const manual = sync.parseSyncArgs(['test-kb', '--reason', 'user-requested refresh']);
  assert.equal(manual.trigger, 'manual');
  assert.equal(manual.reason, 'user-requested refresh');
});
