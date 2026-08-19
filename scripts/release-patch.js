'use strict';

/**
 * 自动发布版本：
 *   默认将 patch +1；使用 --minor 时将 minor +1，并将 patch 清零
 *   运行测试
 *   提交版本变更
 *   推送 main
 *   创建并推送 v<version> Tag
 *
 * 默认会在执行真实发布前要求确认：
 *   node scripts/release-patch.js
 *
 * 预览而不修改：
 *   node scripts/release-patch.js --dry-run
 *
 * 自动确认：
 *   node scripts/release-patch.js --minor --yes
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
const DRY_RUN = process.argv.includes('--dry-run');
const AUTO_CONFIRM = process.argv.includes('--yes');
const VERSION_MODES = ['--patch', '--minor'];
const requestedModes = VERSION_MODES.filter((arg) => process.argv.includes(arg));
if (requestedModes.length > 1) {
  fail('版本参数只能选择一个：--patch 或 --minor');
}
const VERSION_MODE = requestedModes[0] === '--minor' ? 'minor' : 'patch';
const knownArgs = new Set(['--dry-run', '--yes', ...VERSION_MODES]);

for (const arg of process.argv.slice(2)) {
  if (!knownArgs.has(arg)) {
    fail(`未知参数: ${arg}\n用法: node scripts/release-patch.js [--patch|--minor] [--dry-run] [--yes]`);
  }
}

function fail(message) {
  throw new Error(message);
}

function executable(command) {
  return process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
}

function displayCommand(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(' ');
}

function run(command, args) {
  console.log(`$ ${displayCommand(command, args)}`);
  const result = spawnSync(executable(command), args, {
    cwd: ROOT,
    stdio: 'inherit',
    // Windows 的 npm.cmd 是批处理文件，必须通过 shell 启动；Git 仍保持 shell:false。
    shell: process.platform === 'win32' && command === 'npm',
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`命令失败（退出码 ${result.status}）：${displayCommand(command, args)}`);
  }
}

function capture(command, args) {
  const result = spawnSync(executable(command), args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`命令失败（退出码 ${result.status}）：${displayCommand(command, args)}${detail ? `\n${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function readPackage() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
  } catch (error) {
    fail(`无法读取 package.json：${error.message}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) {
    fail(`package.json version 必须是三段数字版本，当前为：${pkg.version}`);
  }
  return pkg;
}

function nextVersion(version, mode) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (mode === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function ensureCleanMainBranch() {
  const branch = capture('git', ['branch', '--show-current']);
  if (branch !== 'main') fail(`当前分支是 ${branch || '<detached>'}，发布脚本只允许在 main 分支运行`);

  const status = capture('git', ['status', '--porcelain']);
  if (status) fail('工作区不是干净状态，请先提交或处理现有改动：\n' + status);
}

function ensureTagAvailable(tag) {
  const localTag = capture('git', ['tag', '--list', tag]);
  if (localTag === tag) fail(`本地 Tag 已存在：${tag}`);

  const result = spawnSync(executable('git'), ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) fail(`远程 Tag 已存在：${tag}`);
  if (result.status !== 2) {
    const detail = String(result.stderr || '').trim();
    fail(`无法检查远程 Tag ${tag}，请确认 GitHub 认证和网络连接${detail ? `\n${detail}` : ''}`);
  }
}

function confirmRelease(tag, currentVersion, nextVersion) {
  if (AUTO_CONFIRM) return Promise.resolve(true);
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    input.question(
      `确认发布 ${tag}（${currentVersion} → ${nextVersion}，将推送 main 和 Tag）？[y/N] `,
      (answer) => {
        input.close();
        resolve(answer.trim().toLowerCase() === 'y');
      },
    );
  });
}

async function main() {
  ensureCleanMainBranch();
  const pkg = readPackage();
  const currentVersion = pkg.version;
  const targetVersion = nextVersion(currentVersion, VERSION_MODE);
  const tag = `v${targetVersion}`;

  if (!DRY_RUN) ensureTagAvailable(tag);

  console.log(`当前版本: ${currentVersion}`);
  console.log(`版本模式: ${VERSION_MODE === 'minor' ? '大版本（中间段 +1，末尾清零）' : '小版本（末尾 +1）'}`);
  console.log(`下一个版本: ${targetVersion}`);
  console.log(`目标 Tag: ${tag}`);

  if (DRY_RUN) {
    console.log('Dry run：未修改文件，未执行测试、提交或推送。');
    return;
  }

  if (!(await confirmRelease(tag, currentVersion, targetVersion))) {
    console.log('已取消发布。');
    return;
  }

  const originalPackage = fs.readFileSync(PACKAGE_FILE, 'utf8');
  let committed = false;
  let packageUpdated = false;
  try {
    run('npm', ['test']);

    const nextPackage = { ...pkg, version: targetVersion };
    fs.writeFileSync(PACKAGE_FILE, `${JSON.stringify(nextPackage, null, 2)}\n`, 'utf8');
    packageUpdated = true;

    run('git', ['add', 'package.json']);
    run('git', ['commit', '-m', `release: ${tag}`]);
    committed = true;

    run('git', ['push', 'origin', 'main']);
    run('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
    run('git', ['push', 'origin', tag]);

    console.log(`发布流程完成：${tag}`);
    console.log(`GitHub Actions 将开始构建并创建 ${tag} Release。`);
  } catch (error) {
    if (!committed && packageUpdated) {
      fs.writeFileSync(PACKAGE_FILE, originalPackage, 'utf8');
      try {
        run('git', ['restore', '--staged', 'package.json']);
      } catch (_) {
        // 保留原始错误；工作区恢复失败时由错误信息提示用户检查。
      }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`\n发布失败：${error.message}`);
  process.exitCode = 1;
});
