'use strict';

/**
 * config 命令：缓存根目录和知识库配置。
 *
 * 数据模型（config.json，固定存于 ~/.feishu-kb-sync/，不跟随 root 变化）：
 * {
 *   "root": "<绝对路径>",
 *   "spaces": {
 *     "<配置名称>": "<space_id>"
 *   }
 * }
 *
 * 缓存布局：
 *   ~/.feishu-kb-sync/config.json
 *   <root>/<配置名称>/tree.json + manifest.json + 远端目录镜像文件
 *   历史缓存保留原有 docs/ + text/ 布局，新缓存使用单一目录布局。
 *
 * 配置名称是本地目录名称，space_id 是知识库稳定身份。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cacheDir,
  legacyCacheDir,
  sanitizeSegment,
} = require('./paths.js');
const APP_DIR = path.join(os.homedir(), '.feishu-kb-sync');
const DEFAULT_ROOT = path.join(APP_DIR, 'cache');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');

/** 读取 config.json；不存在则返回默认结构（不落盘，首次写入时创建）。 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      root: DEFAULT_ROOT,
      spaces: {},
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      root: raw.root || DEFAULT_ROOT,
      spaces: raw.spaces || {},
    };
  } catch (err) {
    throw new Error(`config.json 解析失败（${CONFIG_FILE}）：${err.message}`);
  }
}

/** 保存 config.json（原子写：先写 .tmp 再 rename）。 */
function saveConfig(cfg) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 从飞书知识库链接中提取 space_id。 */
function parseSpaceId(input) {
  const trimmed = input.trim();
  if (/^\d{10,20}$/.test(trimmed)) {
    return trimmed;
  }
  const m = trimmed.match(/\/wiki\/space\/(\d{10,20})/);
  if (m) return m[1];
  throw new Error(
    `无法从 "${input}" 解析 space_id（支持纯数字 space_id 或 https://xxx.feishu.cn/wiki/space/<id> 链接）。\n` +
    '如果是节点链接（/wiki/<字母数字token>），请用: lark-cli wiki +node-get --node-token <链接> 解析出 space_id 后手动填入'
  );
}

// ---- 缓存目录迁移 ----

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 从缓存元数据中读取 space_id，用于防止目录覆盖。 */
function readCacheSpaceId(dir) {
  const manifest = readJsonIfExists(path.join(dir, 'manifest.json'));
  if (manifest?.space_id) return String(manifest.space_id);
  const tree = readJsonIfExists(path.join(dir, 'tree.json'));
  if (tree?.space_id) return String(tree.space_id);
  return null;
}

function isEmptyDirectory(dir) {
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
}

/**
 * 将同一 space_id 的旧配置名称目录迁移到新配置名称目录。
 * 迁移只处理安全的“目标不存在”场景，已有目标数据由用户显式处理，避免覆盖缓存。
 */
function migrateCacheDir(root, oldName, newName, spaceId) {
  const oldDir = cacheDir(root, oldName);
  const newDir = cacheDir(root, newName);
  if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(oldDir)) {
    return { moved: false, oldDir, newDir };
  }

  if (fs.existsSync(newDir)) {
    const targetSpaceId = readCacheSpaceId(newDir);
    if (targetSpaceId && targetSpaceId !== String(spaceId)) {
      throw new Error(`知识库目录冲突：${newDir} 已属于 space_id ${targetSpaceId}`);
    }
    if (!isEmptyDirectory(newDir)) {
      throw new Error(`知识库目录冲突：目标目录已有缓存，请先处理 ${newDir}`);
    }
    fs.rmdirSync(newDir);
  }

  fs.mkdirSync(path.dirname(newDir), { recursive: true });
  fs.renameSync(oldDir, newDir);
  return { moved: true, oldDir, newDir };
}

// ---- 命令实现 ----

/** 调 HTTP API 解析 wiki 链接 → space_id。 */
async function larkNodeGet(nodeUrl) {
  const http = require('./feishu-http.js');
  const m = nodeUrl.match(/\/wiki\/(?:space\/)?([A-Za-z0-9]{10,})/);
  const nodeToken = m ? m[1] : nodeUrl.trim();
  try {
    const node = await http.nodeGet(nodeToken);
    return { space_id: node.space_id, title: node.title };
  } catch (err) {
    throw new Error(`解析链接失败: ${err.message}`);
  }
}

function parseAddArgs(args) {
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      throw new Error(`未知参数: ${arg}\n用法: feishu-kb-sync config add <名称> <链接|space_id>`);
    }
    positional.push(arg);
  }
  const [name, link] = positional;
  if (!name || !link || positional.length > 2) {
    throw new Error('用法: feishu-kb-sync config add <名称> <链接|space_id>');
  }
  return { name, link };
}

async function setRoot([rootPath]) {
  if (!rootPath) throw new Error('用法: feishu-kb-sync config set-root <路径>');
  const resolved = path.resolve(rootPath);
  const syncDirs = ['onedrive', '坚果云', 'icloud', 'dropbox', 'nutstore'];
  const lower = resolved.toLowerCase();
  const hit = syncDirs.find((d) => lower.includes(d));
  const cfg = loadConfig();

  const oldRoot = cfg.root;
  cfg.root = resolved;
  saveConfig(cfg);
  console.log(`已设置缓存根目录: ${resolved}`);

  if (hit) {
    console.warn(`⚠️  警告：检测到路径包含「${hit}」，可能处于云盘同步目录。云盘自动上传会触发风扇+带宽双爆，且同步中断可能产生脏文件被云盘同步。建议换用非云盘路径。`);
  }
  if (oldRoot !== DEFAULT_ROOT && oldRoot !== resolved) {
    console.warn(`⚠️  提示：原根目录 ${oldRoot} 下已有数据，如需迁移请手动移动（config.json 在 ${APP_DIR}，不随 root 迁移）。`);
  }
}

async function add(args) {
  const { name, link } = parseAddArgs(args);
  const cfg = loadConfig();
  let spaceId;
  try {
    spaceId = parseSpaceId(link);
  } catch (_) {
    console.log('  解析链接中...');
    const data = await larkNodeGet(link.trim());
    spaceId = data.space_id;
    if (!spaceId) throw new Error(`链接解析成功但未取到 space_id（${data.title || ''}）`);
  }
  spaceId = String(spaceId);

  const existingId = cfg.spaces[name];
  if (existingId && String(existingId) !== spaceId) {
    throw new Error(`配置名称「${name}」已经指向另一个 space_id：${existingId}`);
  }

  const oldNameEntry = Object.entries(cfg.spaces)
    .find(([existingName, existingSpaceId]) => existingName !== name && String(existingSpaceId) === spaceId);
  if (oldNameEntry) {
    const [oldName] = oldNameEntry;
    migrateCacheDir(cfg.root, oldName, name, spaceId);
    delete cfg.spaces[oldName];
    console.log(`已迁移本地缓存目录: ${sanitizeSegment(oldName)} → ${sanitizeSegment(name)}`);
  }

  cfg.spaces[name] = spaceId;
  saveConfig(cfg);
  console.log(`已配置知识库「${name}」→ space_id: ${spaceId}`);
}
async function list() {
  const cfg = loadConfig();
  console.log(`缓存根目录: ${cfg.root}`);
  const names = Object.keys(cfg.spaces);
  if (names.length === 0) {
    console.log('尚未配置任何知识库（config add <名称> <链接|space_id>）');
    return;
  }
  console.log('已配置知识库:');
  for (const n of names) {
    const spaceId = String(cfg.spaces[n]);
    console.log(`  ${n}  →  ${spaceId}`);
  }
}

async function remove([name]) {
  if (!name) throw new Error('用法: feishu-kb-sync config remove <名称>');
  const cfg = loadConfig();
  const spaceId = cfg.spaces[name];
  if (!spaceId) {
    console.log(`知识库「${name}」不存在`);
    return;
  }

  delete cfg.spaces[name];
  saveConfig(cfg);
  console.log(`已移除知识库「${name}」的同步配置`);
}
module.exports = {
  setRoot,
  add,
  list,
  remove,
  loadConfig,
  DEFAULT_ROOT,
  APP_DIR,
  CONFIG_FILE,
  parseSpaceId,
  parseAddArgs,
  cacheDir,
  legacyCacheDir,
  migrateCacheDir,
  readCacheSpaceId,
};

