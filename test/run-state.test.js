'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getRunPaths,
  readStatus,
  writeStatus,
  acquireLock,
  readLock,
  releaseLock,
  reconcileRunningStatus,
} = require('../lib/run-state.js');

function makeContext(t) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-state-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const paths = getRunPaths('space-test', { appDir });
  return { appDir, paths };
}

test('run-state writes and reads machine-readable statuses', (t) => {
  const { paths } = makeContext(t);
  const identity = { kbName: '测试知识库', spaceId: 'space-test', cacheDir: 'C:\\cache\\测试知识库' };

  assert.equal(readStatus(paths, identity).status, 'idle');
  const running = writeStatus(paths, { ...readStatus(paths, identity), ...identity, status: 'running', run_id: 'run-1' });
  assert.equal(running.status, 'running');
  assert.deepEqual(readStatus(paths, identity).run_id, 'run-1');

  const success = writeStatus(paths, { ...running, status: 'success', run_id: null, last_success_at: '2026-08-16T00:00:00.000Z' });
  assert.equal(success.status, 'success');
  assert.equal(readStatus(paths, identity).last_success_at, '2026-08-16T00:00:00.000Z');
});

test('run-state lock prevents duplicate runs and releases ownership', (t) => {
  const { paths } = makeContext(t);
  const first = acquireLock(paths, {
    run_id: 'run-1',
    knowledge_base: '测试知识库',
    space_id: 'space-test',
    pid: process.pid,
    role: 'foreground',
  });
  assert.equal(first.acquired, true);
  assert.equal(readLock(paths).run_id, 'run-1');

  const duplicate = acquireLock(paths, {
    run_id: 'run-2',
    knowledge_base: '测试知识库',
    space_id: 'space-test',
    pid: process.pid,
    role: 'foreground',
  });
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.lock.run_id, 'run-1');

  assert.equal(releaseLock(paths, 'run-2'), false);
  assert.equal(readLock(paths).run_id, 'run-1');
  assert.equal(releaseLock(paths, 'run-1'), true);
  assert.equal(readLock(paths), null);
});

test('reconcileRunningStatus marks a missing worker as failed', (t) => {
  const { paths } = makeContext(t);
  const identity = { kbName: '测试知识库', spaceId: 'space-test', cacheDir: 'C:\\cache\\测试知识库' };
  writeStatus(paths, {
    ...readStatus(paths, identity),
    ...identity,
    status: 'running',
    run_id: 'run-1',
    pid: 999999,
  });

  const reconciled = reconcileRunningStatus(paths, identity);
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.last_error, /同步进程已退出/);
});