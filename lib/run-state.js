'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATUS_VALUES = new Set(['idle', 'running', 'success', 'failed']);

function keyForSpace(spaceId) {
  return crypto.createHash('sha256').update(String(spaceId)).digest('hex').slice(0, 16);
}

function getRunPaths(spaceId, options = {}) {
  const appDir = path.resolve(options.appDir || path.join(require('os').homedir(), '.feishu-kb-sync'));
  const key = keyForSpace(spaceId);
  return {
    appDir,
    key,
    stateFile: path.join(appDir, 'state', `${key}.json`),
    lockFile: path.join(appDir, 'locks', `${key}.lock`),
    logFile: path.join(appDir, 'logs', `${key}.log`),
  };
}

function now() {
  return new Date().toISOString();
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function replaceFile(tmp, target) {
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
    fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
  }
}

function writeJsonAtomic(file, value) {
  ensureParent(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  replaceFile(tmp, file);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function baseStatus({ kbName, spaceId, cacheDir, logFile }) {
  return {
    status: 'idle',
    knowledge_base: kbName,
    space_id: String(spaceId),
    cache_dir: cacheDir || null,
    started_at: null,
    finished_at: null,
    last_success_at: null,
    trigger: null,
    reason: null,
    last_error: null,
    progress: null,
    last_counts: null,
    last_summary: null,
    pid: null,
    run_id: null,
    log_file: logFile || null,
    updated_at: null,
  };
}

function readStatus(paths, identity = {}) {
  const raw = readJson(paths.stateFile);
  const fallback = baseStatus({ ...identity, logFile: paths.logFile });
  if (!raw || !STATUS_VALUES.has(raw.status)) return fallback;
  return {
    ...fallback,
    ...raw,
    space_id: String(raw.space_id || identity.spaceId || ''),
    log_file: raw.log_file || paths.logFile,
  };
}

function writeStatus(paths, status) {
  if (!STATUS_VALUES.has(status.status)) {
    throw new Error(`无效同步状态: ${status.status}`);
  }
  const next = {
    ...status,
    updated_at: now(),
    log_file: status.log_file || paths.logFile,
  };
  writeJsonAtomic(paths.stateFile, next);
  return next;
}

function readLock(paths) {
  if (!fs.existsSync(paths.lockFile)) return null;
  return readJson(paths.lockFile);
}

function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function lockPids(lock) {
  return [lock?.pid, lock?.launcher_pid, lock?.worker_pid]
    .map((pid) => Number(pid))
    .filter((pid, index, values) => Number.isInteger(pid) && pid > 0 && values.indexOf(pid) === index);
}

function lockIsAlive(lock) {
  return lockPids(lock).some(processIsAlive);
}

function removeLock(paths, runId) {
  const current = readLock(paths);
  if (!current || !runId || current.run_id === runId) {
    try { fs.rmSync(paths.lockFile, { force: true }); } catch (_) {}
    return true;
  }
  return false;
}

function acquireLock(paths, metadata) {
  ensureParent(paths.lockFile);
  const payload = {
    run_id: metadata.run_id,
    knowledge_base: metadata.knowledge_base,
    space_id: String(metadata.space_id),
    pid: Number(metadata.pid || process.pid),
    launcher_pid: metadata.launcher_pid == null ? Number(metadata.pid || process.pid) : Number(metadata.launcher_pid),
    worker_pid: metadata.worker_pid == null ? null : Number(metadata.worker_pid),
    role: metadata.role || 'foreground',
    trigger: metadata.trigger || null,
    reason: metadata.reason || null,
    started_at: metadata.started_at || now(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.lockFile, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, lock: payload };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const current = readLock(paths);
      if (!current || lockIsAlive(current)) {
        return { acquired: false, lock: current };
      }
      removeLock(paths);
    }
  }
  return { acquired: false, lock: readLock(paths) };
}

function updateLock(paths, runId, patch) {
  const current = readLock(paths);
  if (!current || current.run_id !== runId) return false;
  writeJsonAtomic(paths.lockFile, { ...current, ...patch });
  return true;
}

function releaseLock(paths, runId) {
  return removeLock(paths, runId);
}

function reconcileRunningStatus(paths, identity = {}) {
  const status = readStatus(paths, identity);
  if (status.status !== 'running') return status;

  const lock = readLock(paths);
  if (lock && lockIsAlive(lock)) return status;

  return writeStatus(paths, {
    ...status,
    status: 'failed',
    finished_at: status.finished_at || now(),
    pid: null,
    last_error: status.last_error || '同步进程已退出，未报告完成状态',
  });
}

module.exports = {
  STATUS_VALUES,
  keyForSpace,
  getRunPaths,
  now,
  readStatus,
  writeStatus,
  readLock,
  processIsAlive,
  lockIsAlive,
  acquireLock,
  updateLock,
  releaseLock,
  reconcileRunningStatus,
};