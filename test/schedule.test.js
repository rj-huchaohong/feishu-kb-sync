'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TASK_NAME,
  writeVbs,
  buildTaskRunValue,
  buildInstallArgs,
  parseTaskCsv,
  formatLocalDateTime,
  formatSyncStatusLines,
  parseInstallArgs,
  syncStatusesForConfiguredKnowledgeBases,
  status: scheduleStatus,
} = require('../lib/schedule.js');

test('Windows schedule command uses user-level schtasks and absolute hidden launcher paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-schedule-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vbsFile = path.join(root, 'run-sync.vbs');
  const logFile = path.join(root, 'logs', 'sync.log');
  const cliPath = path.join(root, 'bin', 'feishu-kb-sync.js');
  const nodePath = path.join(root, 'node.exe');

  writeVbs('test-kb', { vbsFile, logFile, cliPath, nodePath, launcherPath: false, spaceId: 'space-test' });
  const vbs = fs.readFileSync(vbsFile, 'utf8');
  assert.match(vbs, /--space-id ""space-test""/);
  assert.match(vbs, /--trigger scheduled/);
  assert.match(vbs, new RegExp(nodePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(vbs, new RegExp(cliPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(vbs, /ws\.Run .*0, False/);

  const args = buildInstallArgs('08:30', vbsFile, 'C:\\Windows');
  assert.deepEqual(args.slice(0, 2), ['/Create', '/TN']);
  assert.equal(args[1], '/TN');
  assert.ok(args.includes(TASK_NAME));
  assert.ok(args.includes('/SC'));
  assert.ok(args.includes('DAILY'));
  assert.ok(args.includes('/ST'));
  assert.ok(args.includes('08:30'));
  assert.ok(args.includes('/F'));
  assert.equal(args.includes('/RU'), false);
  assert.match(args[args.indexOf('/TR') + 1], /wscript\.exe/);
  assert.match(args[args.indexOf('/TR') + 1], /run-sync\.vbs/);
});

test('scheduled VBS launches the all-knowledge-base scope', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-schedule-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vbsFile = path.join(root, 'run-sync.vbs');
  const logFile = path.join(root, 'logs', 'sync.log');

  writeVbs(null, { vbsFile, logFile, cliPath: path.join(root, 'cli.js'), nodePath: path.join(root, 'node.exe'), launcherPath: false, all: true });
  const vbs = fs.readFileSync(vbsFile, 'utf8');
  assert.match(vbs, /sync --all/);
  assert.match(vbs, /--trigger scheduled/);
  assert.doesNotMatch(vbs, /--space-id/);
});

test('schedule install accepts only the daily time and targets all configured knowledge bases', () => {
  assert.deepEqual(parseInstallArgs(['--time', '08:30']), { help: false, time: '08:30' });
  assert.throws(() => parseInstallArgs(['--kb', 'test-kb']), /all configured knowledge bases/);
});

test('schedule status collects one status record for every configured knowledge base', () => {
  const statuses = syncStatusesForConfiguredKnowledgeBases({
    spaces: { alpha: 'space-a', beta: 'space-b' },
  }, (name, cfg) => ({ knowledge_base: name, space_id: cfg.spaces[name], status: name === 'alpha' ? 'success' : 'running' }));

  assert.deepEqual(statuses, [
    { knowledge_base: 'alpha', space_id: 'space-a', status: 'success' },
    { knowledge_base: 'beta', space_id: 'space-b', status: 'running' },
  ]);
});


test('schedule status returns the scheduler state and every knowledge-base sync status', async (t) => {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));
  t.after(() => { console.log = originalLog; });

  const result = await scheduleStatus(['--json'], {
    schtasks: async () => '"TaskName","Next Run Time","Status"\r\n"feishu-kb-sync","2026/8/16 08:30:00","Ready"',
    readScheduleMetadata: () => ({ scope: 'all', time: '08:30' }),
    loadConfig: () => ({ spaces: { alpha: 'space-a', beta: 'space-b' } }),
    statusReader: (name, cfg) => ({ knowledge_base: name, space_id: cfg.spaces[name], status: name === 'alpha' ? 'success' : 'failed' }),
  });

  assert.equal(result.registered, true);
  assert.equal(result.scope, 'all');
  assert.equal(result.next_run_time, '2026/8/16 08:30:00');
  assert.deepEqual(result.knowledge_bases.map((item) => item.knowledge_base), ['alpha', 'beta']);
  assert.match(output[0], /knowledge_bases/);
});

test('schedule status parser reads English and Chinese schtasks CSV', () => {
  const english = parseTaskCsv('"TaskName","Next Run Time","Status"\r\n"feishu-kb-sync","8/16/2026 8:30:00 AM","Ready"');
  assert.deepEqual(english, {
    task_name: 'feishu-kb-sync',
    next_run_time: '8/16/2026 8:30:00 AM',
    status: 'Ready',
  });

  const chinese = parseTaskCsv('"任务名","下次运行时间","模式"\r\n"feishu-kb-sync","2026/8/16 08:30:00","就绪"');
  assert.equal(chinese.status, '就绪');
  assert.equal(chinese.next_run_time, '2026/8/16 08:30:00');
});

test('local timestamp formatter uses the requested timezone while preserving the instant', () => {
  assert.equal(formatLocalDateTime('2026-08-16T00:00:00.000Z', 'Asia/Shanghai'), '2026-08-16 08:00:00');
  assert.equal(formatLocalDateTime('2026-08-16T00:00:00.000Z', 'America/Los_Angeles'), '2026-08-15 17:00:00');
  assert.equal(formatLocalDateTime('not-a-date', 'Asia/Shanghai'), 'not-a-date');
});

test('schedule status formats local start time and explains manual runs', () => {
  assert.deepEqual(formatSyncStatusLines({
    started_at: '2026-08-16T00:00:00.000Z',
    trigger: 'manual',
    reason: 'user-requested refresh',
    last_success_at: '2026-08-16T01:02:03.000Z',
  }, 'Asia/Shanghai'), [
    'Sync started: 2026-08-16 08:00:00',
    'Sync reason: user-requested refresh',
    'Last success: 2026-08-16 09:02:03',
  ]);

  assert.deepEqual(formatSyncStatusLines({
    started_at: '2026-08-16T00:00:00.000Z',
    trigger: 'scheduled',
    reason: 'scheduled task',
  }, 'Asia/Shanghai'), [
    'Sync started: 2026-08-16 08:00:00',
  ]);
});
