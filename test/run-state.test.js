'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runState = require('../lib/run-state.js');

test('per-knowledge-base lock prevents duplicate runs and can be released', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-sync-test-'));
  try {
    const paths = runState.getRunPaths('space-1', { appDir });
    const first = runState.acquireLock(paths, {
      run_id: 'run-1',
      knowledge_base: 'kb',
      space_id: 'space-1',
      pid: process.pid,
    });
    const second = runState.acquireLock(paths, {
      run_id: 'run-2',
      knowledge_base: 'kb',
      space_id: 'space-1',
      pid: process.pid,
    });

    assert.equal(first.acquired, true);
    assert.equal(second.acquired, false);
    assert.equal(second.lock.run_id, 'run-1');
    assert.equal(runState.releaseLock(paths, 'run-1'), true);
    assert.equal(runState.acquireLock(paths, {
      run_id: 'run-3',
      knowledge_base: 'kb',
      space_id: 'space-1',
      pid: process.pid,
    }).acquired, true);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test('missing worker lock is reconciled as a failed run', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-sync-test-'));
  try {
    const paths = runState.getRunPaths('space-2', { appDir });
    runState.writeStatus(paths, {
      status: 'running',
      knowledge_base: 'kb',
      space_id: 'space-2',
      started_at: runState.now(),
    });
    const result = runState.reconcileRunningStatus(paths, {
      kbName: 'kb',
      spaceId: 'space-2',
    });
    assert.equal(result.status, 'failed');
    assert.match(result.last_error, /退出|完成/);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
