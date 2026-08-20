'use strict';

const VERSION_MODES = new Set(['current', 'patch', 'minor']);

function validateVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error(`版本必须是三段数字版本，当前为：${version}`);
  }
}

function nextVersion(version, mode) {
  validateVersion(version);
  if (!VERSION_MODES.has(mode)) throw new Error(`未知版本模式：${mode}`);
  if (mode === 'current') return version;

  const [major, minor, patch] = version.split('.').map(Number);
  if (mode === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function modeLabel(mode) {
  if (mode === 'current') return '当前版本（不递增）';
  if (mode === 'minor') return '大版本（中间段 +1，末尾清零）';
  return '小版本（末尾 +1）';
}

module.exports = { nextVersion, modeLabel, validateVersion };
