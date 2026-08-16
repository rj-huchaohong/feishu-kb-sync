'use strict';

/**
 * schedule 命令：Windows 用户级系统定时调度。
 *
 * Windows 实现：
 *   - 不指定 /RU，schtasks 使用当前用户注册任务，不要求管理员权限；
 *   - 使用绝对路径调用 wscript、Node.js 和 CLI，不依赖计划任务环境的 PATH；
 *   - 使用隐藏窗口的 VBS wrapper 启动同步；
 *   - 通过 schtasks /Query 读取任务状态和下次运行时间。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { loadConfig, APP_DIR } = require('./config.js');
const runState = require('./run-state.js');
const syncCore = require('./sync.js');

const TASK_NAME = 'feishu-kb-sync';
const VBS_FILE = path.join(APP_DIR, 'run-sync.vbs');
const LOG_DIR = path.join(APP_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sync.log');
const SCHEDULE_FILE = path.join(APP_DIR, 'schedule.json');

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeScheduleMetadata(metadata) {
  ensureParent(SCHEDULE_FILE);
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(metadata, null, 2), 'utf8');
}

function readScheduleMetadata() {
  if (!fs.existsSync(SCHEDULE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function quoteWindowsArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function resolveGlobalLauncherPath() {
  if (process.platform !== 'win32') return null;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const prefixes = [
    process.env.npm_config_prefix,
    appData,
  ].filter(Boolean);
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [];
  for (const prefix of prefixes) {
    candidates.push(path.join(prefix, 'feishu-kb-sync.cmd'));
    candidates.push(path.join(prefix, 'bin', 'feishu-kb-sync.cmd'));
    candidates.push(path.join(prefix, 'feishu-kb-sync.bat'));
    candidates.push(path.join(prefix, 'bin', 'feishu-kb-sync.bat'));
    candidates.push(path.join(prefix, 'npm', 'feishu-kb-sync.cmd'));
    candidates.push(path.join(prefix, 'npm', 'feishu-kb-sync.bat'));
  }
  for (const dir of pathDirs) {
    candidates.push(path.join(dir, 'feishu-kb-sync.cmd'));
    candidates.push(path.join(dir, 'feishu-kb-sync.bat'));
  }
  return [...new Set(candidates)].find((candidate) => fs.existsSync(candidate)) || null;
}

function wscriptPath(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return path.join(systemRoot, 'System32', 'wscript.exe');
}

/**
 * 生成 VBS wrapper：wscript 无窗口启动 node 跑 sync，输出重定向到日志。
 * options 仅用于测试和多环境路径注入，默认值保持生产行为不变。
 */
function writeVbs(kbName, options = {}) {
  const vbsFile = options.vbsFile || VBS_FILE;
  const logFile = options.logFile || LOG_FILE;
  const nodePath = options.nodePath || process.execPath;
  const cliPath = options.cliPath || path.resolve(__dirname, '..', 'bin', 'feishu-kb-sync.js');
  const launcherPath = options.launcherPath === false ? null : (options.launcherPath || resolveGlobalLauncherPath());
  if (!launcherPath && options.launcherPath !== false) {
    throw new Error('Global feishu-kb-sync launcher was not found. Install feishu-kb-sync globally before configuring Windows scheduling.');
  }
  ensureParent(vbsFile);
  ensureParent(logFile);

  const syncTarget = options.all
    ? ['sync', '--all']
    : options.spaceId
      ? ['sync', '--space-id', quoteWindowsArg(options.spaceId)]
      : ['sync', quoteWindowsArg(kbName)];
  syncTarget.push('--trigger', 'scheduled');
  const executable = launcherPath
    ? [quoteWindowsArg(launcherPath)]
    : [quoteWindowsArg(nodePath), quoteWindowsArg(cliPath)];
  const command = [
    ...executable,
    ...syncTarget,
    '--background',
    '--json',
  ].join(' ');
  const vbsEncoded = command.replace(/"/g, '""');
  const vbs = [
    "' feishu-kb-sync scheduled sync (hidden window)",
    'Set ws = CreateObject("WScript.Shell")',
    'ws.Run "' + vbsEncoded + '", 0, False',
  ].join('\r\n');
  fs.writeFileSync(vbsFile, vbs, 'utf8');
  return vbsFile;
}

function buildTaskRunValue(vbsFile, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return `${quoteWindowsArg(wscriptPath(systemRoot))} ${quoteWindowsArg(vbsFile)}`;
}

function buildInstallArgs(time, vbsFile, systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  return [
    '/Create',
    '/TN', TASK_NAME,
    '/TR', buildTaskRunValue(vbsFile, systemRoot),
    '/SC', 'DAILY',
    '/ST', time,
    '/F',
  ];
}

/** 调用 schtasks；Windows 中文系统输出 GBK，显式转 UTF-8 防乱码。 */
function schtasks(args) {
  return new Promise((resolve, reject) => {
    execFile('schtasks', args, { windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      const decode = (buf) => {
        if (!buf || !buf.length) return '';
        try {
          return new TextDecoder('gbk').decode(buf);
        } catch (_) {
          return buf.toString('utf8');
        }
      };
      if (err) {
        reject(new Error(`schtasks 执行失败: ${decode(stderr) || decode(stdout) || err.message}`));
      } else {
        resolve(decode(stdout));
      }
    });
  });
}

/** 解析 --time HH:MM（默认 10:00），校验格式。 */
function parseTime(argv) {
  const idx = argv.indexOf('--time');
  if (idx === -1) return '10:00';
  const v = argv[idx + 1];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
    throw new Error(`无效时间 "${v}"，格式应为 HH:MM（如 10:00）`);
  }
  return v;
}

/** 解析 --kb <库名>；未指定且有多个库时报错。 */
function resolveConfiguredKnowledgeBases() {
  const cfg = loadConfig();
  const knowledgeBases = Object.entries(cfg.spaces || {}).map(([name, spaceId]) => ({
    knowledge_base: name,
    space_id: String(spaceId),
  }));
  if (knowledgeBases.length === 0) {
    throw new Error('no knowledge base is configured; add one with: feishu-kb-sync config add <name> <link|space_id>');
  }
  return { cfg, knowledgeBases };
}

function parseInstallArgs(argv) {
  const time = parseTime(argv);
  if (argv.includes('--kb')) {
    throw new Error('schedule install now synchronizes all configured knowledge bases; remove --kb');
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--time') {
      i += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') return { help: true, time };
    throw new Error('unknown argument: ' + arg + '\nUsage: feishu-kb-sync schedule install [--time HH:MM]');
  }
  return { help: false, time };
}

async function install(argv) {
  const options = parseInstallArgs(argv);
  if (options.help) {
    console.log('feishu-kb-sync schedule install [--time HH:MM]');
    return { ok: true, help: true };
  }
  const { knowledgeBases } = resolveConfiguredKnowledgeBases();
  const time = options.time;
  let vbs;
  try {
    vbs = writeVbs(null, { all: true });
  } catch (err) {
    throw new Error('Cannot prepare Windows scheduling files under ' + APP_DIR + ': ' + err.message + '. The current user must be able to write this directory.');
  }
  try {
    await schtasks(buildInstallArgs(time, vbs));
    await schtasks(['/Query', '/TN', TASK_NAME, '/FO', 'CSV']);
  } catch (err) {
    throw new Error('Windows scheduled task registration could not be verified for the current user: ' + err.message);
  }
  writeScheduleMetadata({
    task_name: TASK_NAME,
    scope: 'all',
    knowledge_bases: knowledgeBases,
    time,
    vbs_file: vbs,
    updated_at: new Date().toISOString(),
  });

  console.log('Scheduled task registered: ' + TASK_NAME);
  console.log('Knowledge bases: ' + knowledgeBases.map((item) => item.knowledge_base).join(' / '));
  console.log('Daily time: ' + time);
  console.log('Run mode: current user, hidden window, sequential background sync');
  console.log('Each knowledge base keeps its own sync status and log.');
  return { ok: true, task_name: TASK_NAME, scope: 'all', knowledge_bases: knowledgeBases, time };
}

async function uninstall() {
  try {
    await schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
    console.log(`已删除计划任务「${TASK_NAME}」`);
  } catch (err) {
    if (/does not exist|ERROR_FILE_NOT_FOUND|cannot find the file specified|cannot find the path specified|\u7cfb\u7edf\u627e\u4e0d\u5230\u6307\u5b9a\u7684\u6587\u4ef6|\u7cfb\u7edf\u627e\u4e0d\u5230\u6307\u5b9a\u7684\u8def\u5f84|\u6ca1\u6709\u8fd0\u884c\u7684\u4efb\u52a1|\u4e0d\u5b58\u5728/i.test(err.message)) {
      console.log(`计划任务「${TASK_NAME}」不存在（无需卸载）`);
    } else {
      throw err;
    }
  }
  try {
    if (fs.existsSync(VBS_FILE)) {
      fs.unlinkSync(VBS_FILE);
      console.log(`已删除 ${VBS_FILE}`);
    }
  } catch (_) {
    // VBS 残留无害，下次 install 会覆盖。
  }
}

function parseCsvRow(row) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function parseTaskCsv(output) {
  const lines = String(output || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return null;
  const header = parseCsvRow(lines[0].replace(/^\uFEFF/, ''));
  const data = parseCsvRow(lines[lines.length - 1]);
  const indexOf = (...names) => {
    for (const name of names) {
      const index = header.findIndex((column) => column.trim() === name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const taskIndex = indexOf('任务名', 'TaskName', 'Task Name');
  const nextIndex = indexOf('下次运行时间', 'Next Run Time');
  const statusIndex = indexOf('模式', 'Status', '状态');
  return {
    task_name: data[taskIndex >= 0 ? taskIndex : 0] || TASK_NAME,
    next_run_time: data[nextIndex >= 0 ? nextIndex : 1] || null,
    status: data[statusIndex >= 0 ? statusIndex : 2] || '已注册',
  };
}

function formatLocalDateTime(value, timeZone) {
  if (!value) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formatterOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  if (timeZone) formatterOptions.timeZone = timeZone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', formatterOptions)
    .formatToParts(date)
    .filter(({ type }) => type !== 'literal')
    .map(({ type, value: partValue }) => [type, partValue]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatSyncStatusLines(syncStatus, timeZone) {
  const lines = [];
  if (syncStatus?.started_at) lines.push('Sync started: ' + formatLocalDateTime(syncStatus.started_at, timeZone));
  if (syncStatus?.trigger === 'manual' && syncStatus?.reason) lines.push('Sync reason: ' + syncStatus.reason);
  if (syncStatus?.last_success_at) lines.push('Last success: ' + formatLocalDateTime(syncStatus.last_success_at, timeZone));
  if (syncStatus?.last_error) lines.push('Last error: ' + syncStatus.last_error);
  return lines;
}

function formatSyncSummaryLines(summary) {
  const labels = { added: 'Added', updated: 'Updated', moved: 'Moved', deleted: 'Deleted', skipped: 'Skipped', failed: 'Failed' };
  const lines = [];
  for (const [kind, label] of Object.entries(labels)) {
    const group = summary?.[kind];
    if (!group || !group.count) continue;
    lines.push(label + ': ' + group.count);
    for (const item of group.items || []) {
      let line = '  - ' + (item.title || item.node_token || '<unknown>');
      if (item.error) line += ' | error=' + item.error;
      if (item.phase) line += ' | phase=' + item.phase;
      lines.push(line);
    }
    if (group.truncated) lines.push('  ... ' + (group.count - (group.items || []).length) + ' more');
  }
  return lines;
}

function parseScheduleStatusArgs(argv = []) {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') return { help: true, json: false };
    else throw new Error('Unknown schedule status argument: ' + arg + '\\nUsage: feishu-kb-sync schedule status [--json]');
  }
  return { help: false, json };
}

function syncStatusesForConfiguredKnowledgeBases(cfg = loadConfig(), statusReader = (name, config) => {
  const context = syncCore.resolveKnowledgeBase(name, config);
  return syncCore.statusFor(context);
}) {
  return Object.keys(cfg.spaces || {}).map((name) => statusReader(name, cfg));
}

async function status(argv = [], dependencies = {}) {
  const options = parseScheduleStatusArgs(argv);
  const runSchtasks = dependencies.schtasks || schtasks;
  const readMetadata = dependencies.readScheduleMetadata || readScheduleMetadata;
  const loadConfiguration = dependencies.loadConfig || loadConfig;
  if (options.help) {
    console.log('feishu-kb-sync schedule status [--json]');
    return { ok: true, help: true };
  }

  const metadata = readMetadata();
  let details = null;
  try {
    const out = await runSchtasks(['/Query', '/TN', TASK_NAME, '/FO', 'CSV']);
    details = parseTaskCsv(out);
  } catch (err) {
    if (!/does not exist|ERROR_FILE_NOT_FOUND|cannot find the file specified|cannot find the path specified|\u7cfb\u7edf\u627e\u4e0d\u5230\u6307\u5b9a\u7684\u6587\u4ef6|\u7cfb\u7edf\u627e\u4e0d\u5230\u6307\u5b9a\u7684\u8def\u5f84|\u6ca1\u6709\u8fd0\u884c\u7684\u4efb\u52a1|\u4e0d\u5b58\u5728/i.test(err.message)) throw err;
  }

  const cfg = loadConfiguration();
  const knowledgeBases = syncStatusesForConfiguredKnowledgeBases(cfg, dependencies.statusReader);
  const result = {
    ok: true,
    task_name: TASK_NAME,
    registered: Boolean(details),
    scope: metadata?.scope || 'all',
    configured_time: metadata?.time || null,
    task_status: details?.status || 'not_registered',
    next_run_time: details?.next_run_time || null,
    knowledge_bases: knowledgeBases,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
    return result;
  }

  console.log('Scheduler: ' + (result.registered ? 'registered' : 'not_registered'));
  console.log('Scope: all configured knowledge bases');
  if (result.configured_time) console.log('Configured time: daily ' + result.configured_time);
  if (result.next_run_time) console.log('Next run: ' + result.next_run_time);
  if (result.knowledge_bases.length === 0) {
    console.log('Knowledge bases: none configured');
  } else {
    console.log('Knowledge bases:');
    for (const syncStatus of result.knowledge_bases) {
      console.log('  - ' + syncStatus.knowledge_base + ': ' + (syncStatus.status || 'idle'));
      for (const line of formatSyncStatusLines(syncStatus)) console.log('    ' + line);
      if (syncStatus.last_counts) console.log('    Last summary: added=' + syncStatus.last_counts.added + ' updated=' + syncStatus.last_counts.updated + ' moved=' + syncStatus.last_counts.moved + ' deleted=' + syncStatus.last_counts.deleted + ' failed=' + syncStatus.last_counts.failed);
      for (const line of formatSyncSummaryLines(syncStatus.last_summary)) console.log('    ' + line);
      if (syncStatus.log_file) console.log('    Sync log: ' + syncStatus.log_file);
    }
  }
  return result;
}

module.exports = {
  TASK_NAME,
  resolveGlobalLauncherPath,
  VBS_FILE,
  LOG_FILE,
  SCHEDULE_FILE,
  install,
  uninstall,
  status,
  parseScheduleStatusArgs,
  parseInstallArgs,
  resolveConfiguredKnowledgeBases,
  syncStatusesForConfiguredKnowledgeBases,
  writeVbs,
  buildTaskRunValue,
  buildInstallArgs,
  parseCsvRow,
  parseTaskCsv,
  formatLocalDateTime,
  formatSyncStatusLines,
};