'use strict';

/**
 * sync 命令：同步核心（HTTP 直连并发版）
 *
 * 本地缓存按配置的知识库名称组织，文档按飞书目录镜像保存：
 *   <root>/<知识库名称>/
 *     ├── tree.json
 *     ├── manifest.json
 *     └── <飞书相对目录>/<Markdown 或原文>
 * 历史缓存继续使用 docs/ + text/ 布局，并由缓存结构自动识别。
 *
 * node_token 是稳定身份，目录和标题是可变化的本地路径信息。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile, spawn } = require('child_process');
const config = require('./config.js');
const { mapLimit } = require('./pool.js');
const http = require('./feishu-http.js');
const runState = require('./run-state.js');
const {
  cacheDir,
  legacyCacheDir,
  sanitizeSegment,
  isPathInside,
  toPosixPath,
} = require('./paths.js');

const CONCURRENCY = {
  TRAVERSE: 10,
  DOWNLOAD: 3,
  ONLINE: 3,
};

const SYNC_TRIGGERS = new Set(['manual', 'scheduled']);
const ALL_SCOPE_ID = '__all__';
const CACHE_LAYOUTS = Object.freeze({
  LEGACY: 'legacy',
  SINGLE: 'single',
});

function syncTriggerMetadata(options = {}) {
  const trigger = options.trigger || 'manual';
  if (!SYNC_TRIGGERS.has(trigger)) {
    throw new Error('sync trigger must be manual or scheduled');
  }
  const providedReason = String(options.reason ?? '').trim();
  return {
    trigger,
    reason: providedReason || (trigger === 'scheduled' ? 'scheduled task' : 'manual trigger'),
  };
}

const PY_VENV = path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
const PY_SYS = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe');

function findPython(module) {
  const candidates = [PY_VENV, PY_SYS, 'python', 'python3'];
  for (const candidate of candidates) {
    try {
      const output = execFileSyncSafe(candidate, ['-c', `import ${module}; print('ok')`]);
      if (output && String(output).includes('ok')) return candidate;
    } catch (_) {
      // 尝试下一个解释器。
    }
  }
  return null;
}

function execFileSyncSafe(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
  } catch (_) {
    return null;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'buffer', timeout: 120000, ...opts }, (err, stdout, stderr) => {
      const out = stdout ? stdout.toString('utf8') : '';
      let errOut = '';
      if (stderr && stderr.length) {
        try {
          errOut = new TextDecoder('gbk').decode(stderr);
        } catch (_) {
          errOut = stderr.toString('utf8');
        }
      }
      if (err) reject(new Error(errOut || out || err.message));
      else resolve(out);
    });
  });
}

// ---- 文件与状态 ----

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  replaceFile(tmp, file);
}

function writeTextAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  replaceFile(tmp, file);
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

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return { docs: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function remapPathPrefix(value, oldDir, newDir) {
  if (!value || !isPathInside(oldDir, value)) return value;
  const relative = path.relative(path.resolve(oldDir), path.resolve(value));
  return path.join(newDir, relative);
}

function remapManifestPaths(manifest, oldDir, newDir) {
  for (const entry of Object.values(manifest.docs || {})) {
    if (entry.local_path) entry.local_path = remapPathPrefix(entry.local_path, oldDir, newDir);
    if (entry.text_path) entry.text_path = remapPathPrefix(entry.text_path, oldDir, newDir);
  }
  return manifest;
}

function manifestUsesLegacyLayout(manifest, dir) {
  const legacyRoots = [path.join(dir, 'docs'), path.join(dir, 'text')];
  return Object.values(manifest.docs || {}).some((entry) => [entry?.local_path, entry?.text_path]
    .filter(Boolean)
    .some((file) => legacyRoots.some((root) => isPathInside(root, file))));
}

function detectCacheLayout(dir) {
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = readManifest(dir);
  if (manifest.cache_layout === CACHE_LAYOUTS.SINGLE) return CACHE_LAYOUTS.SINGLE;
  if (manifest.cache_layout === CACHE_LAYOUTS.LEGACY) return CACHE_LAYOUTS.LEGACY;
  if (!fs.existsSync(manifestFile)) return CACHE_LAYOUTS.SINGLE;
  if (fs.existsSync(path.join(dir, 'docs')) || fs.existsSync(path.join(dir, 'text'))) {
    return CACHE_LAYOUTS.LEGACY;
  }
  return manifestUsesLegacyLayout(manifest, dir) ? CACHE_LAYOUTS.LEGACY : CACHE_LAYOUTS.SINGLE;
}

function resolveCacheLayout(dir, requested = null) {
  if (requested === CACHE_LAYOUTS.LEGACY || requested === CACHE_LAYOUTS.SINGLE) return requested;
  return detectCacheLayout(dir);
}

function prepareCacheDir(root, knowledgeBaseName, spaceId) {
  const dir = cacheDir(root, knowledgeBaseName);
  const legacy = legacyCacheDir(root, spaceId);
  const samePath = path.resolve(dir) === path.resolve(legacy);
  let migratedFrom = null;

  if (!samePath && !fs.existsSync(dir) && fs.existsSync(legacy)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(legacy, dir);
    migratedFrom = legacy;
  }

  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    layout: detectCacheLayout(dir),
    migratedFrom,
    legacyPresent: !samePath && fs.existsSync(legacy),
  };
}
/** 流式写文件，避免将完整原文加载到内存。 */
async function streamToFile(resp, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  const ws = fs.createWriteStream(tmp);
  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!ws.write(value)) await new Promise((resolve) => ws.once('drain', resolve));
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    replaceFile(tmp, filePath);
  } catch (err) {
    try { ws.destroy(); } catch (_) {}
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw err;
  }
}

function managedArtifactRoots(dir, layout = CACHE_LAYOUTS.LEGACY) {
  return layout === CACHE_LAYOUTS.LEGACY ? [path.join(dir, 'docs'), path.join(dir, 'text')] : [dir];
}

function isManagedArtifact(dir, file, layout = CACHE_LAYOUTS.LEGACY) {
  if (!file) return false;
  if (layout === CACHE_LAYOUTS.LEGACY) {
    return managedArtifactRoots(dir, layout).some((root) => isPathInside(root, file));
  }
  if (!isPathInside(dir, file)) return false;
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  if (!relative || relative === 'tree.json' || relative === 'manifest.json') return false;
  return !relative.split(path.sep).some((segment) => segment.startsWith('.feishu-kb-sync-'));
}

function removeArtifact(dir, file, layout = CACHE_LAYOUTS.LEGACY) {
  if (!file || !isManagedArtifact(dir, file, layout)) return false;
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) return false;
  fs.rmSync(file, { force: true });
  return true;
}

function removeEntryArtifacts(entry, dir, keep = new Set(), layout = CACHE_LAYOUTS.LEGACY) {
  let removed = 0;
  for (const file of [entry?.local_path, entry?.text_path]) {
    if (file && !keep.has(path.resolve(file)) && removeArtifact(dir, file, layout)) removed++;
  }
  return removed;
}

function removeObsoleteArtifacts(previous, current, dir, layout = CACHE_LAYOUTS.LEGACY) {
  const keep = new Set([current?.local_path, current?.text_path].filter(Boolean).map((file) => path.resolve(file)));
  return removeEntryArtifacts(previous, dir, keep, layout);
}

function removeEmptyDirs(dir, layout = CACHE_LAYOUTS.LEGACY) {
  if (layout === CACHE_LAYOUTS.LEGACY) {
    for (const root of managedArtifactRoots(dir, layout)) {
      if (!fs.existsSync(root)) continue;
      removeEmptyDirsFrom(root);
    }
    return;
  }

  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    removeEmptyDirsFrom(path.join(dir, entry.name));
  }
}

function removeEmptyDirsFrom(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) removeEmptyDirsFrom(child);
  }
  if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
}

function moveArtifact(dir, from, to, layout = CACHE_LAYOUTS.LEGACY) {
  if (!from || !to || path.resolve(from) === path.resolve(to)) return false;
  if (!isManagedArtifact(dir, from, layout) || !isManagedArtifact(dir, to, layout)) {
    throw new Error(`本地路径不在缓存目录内: ${from} → ${to}`);
  }
  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) return false;
    throw new Error(`本地缓存文件不存在: ${from}`);
  }
  if (fs.existsSync(to)) throw new Error(`本地路径冲突: ${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return true;
}

function reconcileCachedPaths(previous, desired, dir, layout = CACHE_LAYOUTS.LEGACY) {
  moveArtifact(dir, previous?.local_path, desired.local_path, layout);
  moveArtifact(dir, previous?.text_path, desired.text_path, layout);
}
// ---- 遍历 ----

/**
 * 递归遍历知识库树。
 * HTTP v2 node-list 直接返回 obj_edit_time，遍历一次即可完成时间戳采集。
 */
async function walk(spaceId, onProgress, client = http) {
  const nodes = {};
  const errors = [];
  let count = 0;

  async function visitChildren(parentToken) {
    let items = [];
    try {
      let pageToken = null;
      do {
        const response = await client.nodeList(spaceId, parentToken, pageToken);
        items = items.concat(response.items || []);
        pageToken = response.has_more ? response.page_token : null;
      } while (pageToken);
    } catch (err) {
      errors.push({ parent: parentToken || null, message: err.message });
      return;
    }

    count += items.length;
    if (onProgress) onProgress(count, items.length ? items[items.length - 1].title : '');
    for (const node of items) {
      nodes[node.node_token] = {
        node_token: node.node_token,
        title: node.title,
        obj_type: node.obj_type,
        obj_token: node.obj_token,
        parent: node.parent_node_token || null,
        has_child: Boolean(node.has_child),
        edit_time: node.obj_edit_time || null,
      };
    }

    const children = items.filter((node) => node.has_child).map((node) => node.node_token);
    await mapLimit(children, CONCURRENCY.TRAVERSE, (child) => visitChildren(child));
  }

  await visitChildren(null);
  return { nodes, count, complete: errors.length === 0, errors };
}

// ---- 路径计算 ----

function extFromTitle(title) {
  const match = String(title || '').match(/\.(\w{2,5})$/i);
  return match ? `.${match[1].toLowerCase()}` : null;
}

function isOnlineNode(node) {
  return node.obj_type === 'docx' || node.obj_type === 'doc' || node.obj_type === 'sheet' || node.obj_type === 'bitable';
}

function isTextOnlineNode(node) {
  return node.obj_type === 'docx' || node.obj_type === 'doc';
}

function fileNameParts(node) {
  const raw = String(node.title || node.node_token);
  if (node.has_child || isOnlineNode(node)) {
    return { base: sanitizeSegment(raw, node.node_token), ext: '' };
  }

  const ext = extFromTitle(raw) || '.bin';
  const rawBase = extFromTitle(raw) ? raw.slice(0, -ext.length) : raw;
  return { base: sanitizeSegment(rawBase, node.node_token), ext };
}

function formatSegment(parts) {
  return `${parts.base}${parts.ext}`;
}

function addCollisionSuffix(parts, token) {
  return `${parts.base}_${token.slice(0, 8)}${parts.ext}`;
}

/** 为每个父目录下的节点生成稳定、可读的本地名称。 */
function buildLocalSegments(nodes) {
  const groups = new Map();
  for (const node of Object.values(nodes)) {
    const key = node.parent || '__root__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }

  const segments = {};
  for (const siblings of groups.values()) {
    siblings.sort((a, b) => String(a.node_token).localeCompare(String(b.node_token)));
    const partsByToken = new Map();
    const counts = new Map();
    for (const node of siblings) {
      const parts = fileNameParts(node);
      const baseName = formatSegment(parts);
      partsByToken.set(node.node_token, parts);
      counts.set(baseName, (counts.get(baseName) || 0) + 1);
    }
    for (const node of siblings) {
      const parts = partsByToken.get(node.node_token);
      const baseName = formatSegment(parts);
      segments[node.node_token] = counts.get(baseName) > 1
        ? addCollisionSuffix(parts, node.node_token)
        : baseName;
    }
  }
  return segments;
}

function ancestorTokens(nodes, token) {
  const ancestors = [];
  const seen = new Set([token]);
  let current = nodes[token];
  while (current?.parent) {
    if (seen.has(current.parent)) throw new Error(`知识库目录存在循环引用: ${token}`);
    seen.add(current.parent);
    const parent = nodes[current.parent];
    if (!parent) break;
    ancestors.unshift(parent.node_token);
    current = parent;
  }
  return ancestors;
}

function replaceExtension(fileName, extension) {
  const current = path.extname(fileName);
  return current ? `${fileName.slice(0, -current.length)}${extension}` : `${fileName}${extension}`;
}

function textNameForOnline(fileName, node) {
  const titleExt = extFromTitle(node.title);
  if (titleExt === '.md' || titleExt === '.docx' || titleExt === '.doc') {
    return replaceExtension(fileName, '.md');
  }
  return `${fileName}.md`;
}

function conversionForExtension(ext, layout) {
  if (layout === CACHE_LAYOUTS.LEGACY) {
    if (ext === '.pdf') return 'pdf-text';
    if (ext === '.docx' || ext === '.doc') return 'word';
    return null;
  }
  if (ext === '.md') return 'markdown';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.doc') return 'word';
  if (ext === '.pptx') return 'pptx';
  return null;
}

function buildNodePathInfo(nodes, dir, layout = CACHE_LAYOUTS.LEGACY) {
  const segments = buildLocalSegments(nodes);
  const info = {};
  const singleLayout = layout === CACHE_LAYOUTS.SINGLE;

  for (const [token, node] of Object.entries(nodes)) {
    const ancestors = ancestorTokens(nodes, token);
    const safeDirs = ancestors.map((ancestor) => segments[ancestor]);
    const rawRemotePath = [...ancestors.map((ancestor) => nodes[ancestor].title), node.title];
    const fileName = segments[token];
    const docsDir = path.join(dir, 'docs', ...safeDirs);
    const textDir = path.join(dir, 'text', ...safeDirs);
    const contentDir = path.join(dir, ...safeDirs);
    const item = {
      relative_dir: toPosixPath(safeDirs),
      remote_path: rawRemotePath,
      file_name: fileName,
      local_path: null,
      text_path: null,
    };

    if (!node.has_child) {
      if (isTextOnlineNode(node)) {
        item.text_path = path.join(singleLayout ? contentDir : textDir, textNameForOnline(fileName, node));
      } else if (!isOnlineNode(node)) {
        const ext = path.extname(fileName).toLowerCase();
        const originalPath = path.join(singleLayout ? contentDir : docsDir, fileName);
        const conversion = conversionForExtension(ext, layout);
        if (singleLayout && conversion) {
          item.text_path = path.join(contentDir, ext === '.md' ? fileName : replaceExtension(fileName, '.md'));
          item.source_path = originalPath;
          item.conversion = conversion;
        } else {
          item.local_path = originalPath;
          if (conversion) {
            item.text_path = path.join(textDir, replaceExtension(fileName, conversion === 'pdf-text' ? '.txt' : '.md'));
            item.conversion = conversion;
          }
        }
      }
    }
    info[token] = item;
  }
  return info;
}
function expectedPaths(node, info) {
  const paths = {};
  if (info.local_path) paths.local_path = info.local_path;
  if (info.text_path) paths.text_path = info.text_path;
  return paths;
}

function metadataFor(node, info) {
  return {
    title: node.title,
    parent: node.parent || null,
    remote_path: info.remote_path,
    relative_dir: info.relative_dir,
    file_name: info.file_name,
    edit_time: node.edit_time,
  };
}

function applyPaths(entry, paths) {
  const result = { ...entry };
  delete result.local_path;
  delete result.text_path;
  if (paths.local_path) result.local_path = paths.local_path;
  if (paths.text_path) result.text_path = paths.text_path;
  return result;
}

function refreshEntry(previous, node, info) {
  return applyPaths({ ...previous, ...metadataFor(node, info) }, expectedPaths(node, info));
}

function makeContainerEntry(node, info) {
  return {
    ...metadataFor(node, info),
    format: 'container',
    status: 'container',
    container: true,
  };
}

function makeSkippedEntry(node, info) {
  return {
    ...metadataFor(node, info),
    format: `online-${node.obj_type}`,
    status: 'skipped',
    skipped: true,
  };
}

function makeNoPermissionEntry(node, info) {
  return {
    ...metadataFor(node, info),
    format: 'file-no-permission',
    status: 'no_permission',
    no_permission: true,
  };
}

function makeSyncedEntry(node, info, format) {
  return applyPaths({
    ...metadataFor(node, info),
    format,
    status: 'synced',
  }, expectedPaths(node, info));
}

function samePath(a, b) {
  return (a || null) === (b || null);
}

function pathsChanged(previous, desired) {
  return !samePath(previous?.local_path, desired.local_path) || !samePath(previous?.text_path, desired.text_path);
}

function artifactsExist(entry, node, info, layout = CACHE_LAYOUTS.LEGACY) {
  if (entry?.skipped || entry?.no_permission) return true;
  if (node.has_child) return true;
  if (layout === CACHE_LAYOUTS.SINGLE) {
    if (entry?.text_path) return fs.existsSync(entry.text_path);
    if (entry?.local_path) return fs.existsSync(entry.local_path);
    return false;
  }
  if (isTextOnlineNode(node)) return Boolean(entry?.text_path && fs.existsSync(entry.text_path));
  if (isOnlineNode(node)) return true;
  if (!entry?.local_path || !fs.existsSync(entry.local_path)) return false;
  if (info.text_path && (!entry.text_path || !fs.existsSync(entry.text_path))) return false;
  return true;
}

function needsSync(previous, node, info, force, layout = CACHE_LAYOUTS.LEGACY) {
  if (!previous) return true;
  if (force) return true;
  if (node.has_child) return false;
  if (previous.container) return true;
  if (String(previous.edit_time) !== String(node.edit_time)) return true;
  if (previous.original_fallback) return true;
  if (previous.skipped || previous.no_permission) return false;
  return !artifactsExist(previous, node, info, layout);
}
// ---- 下载与提取 ----

async function downloadOnline(node, targetPath, client = http) {
  if (!isTextOnlineNode(node)) return { skipped: true, format: `online-${node.obj_type}` };

  let markdownError;
  try {
    if (typeof client.docContent !== 'function') {
      throw new Error('Docs Markdown content API unavailable');
    }
    const content = await client.docContent(node.obj_token, node.obj_type);
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Docs Markdown content API returned an empty document');
    }
    writeTextAtomic(targetPath, content);
    return { textPath: targetPath, format: 'online-md' };
  } catch (err) {
    markdownError = err;
  }

  try {
    if (typeof client.docRawContent !== 'function') {
      throw new Error('raw_content API unavailable');
    }
    const content = await client.docRawContent(node.obj_token);
    writeTextAtomic(targetPath, content);
    return { textPath: targetPath, format: 'online-raw' };
  } catch (rawError) {
    throw new Error(
      `Docs Markdown content failed (${markdownError?.message || 'unknown error'}); `
      + `raw_content fallback failed (${rawError.message})`,
    );
  }
}

async function downloadFile(node, targetPath, client = http) {
  const response = await client.mediaDownload(node.obj_token);
  await streamToFile(response, targetPath);
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    throw new Error('下载文件为空');
  }
  return { filePath: targetPath, format: 'file' };
}

async function extractFile(filePath, node, textPath, layout = CACHE_LAYOUTS.LEGACY) {
  if (!textPath) return null;
  const ext = path.extname(filePath).toLowerCase();
  let py;
  let kind;
  if (ext === '.pdf') {
    py = findPython('fitz') || findPython('pymupdf');
    kind = layout === CACHE_LAYOUTS.SINGLE ? 'pdf' : 'pdf-text';
  } else if (ext === '.docx' || ext === '.doc') {
    py = findPython('docx');
    kind = 'word';
  } else if (ext === '.pptx') {
    py = findPython('zipfile');
    kind = 'pptx';
  } else {
    return null;
  }
  if (!py) throw new Error('未找到文档提取所需的 Python 解释器或模块');

  const tmp = textPath + '.tmp';
  try {
    await run(py, [path.join(__dirname, 'extract.py'), kind, filePath, tmp]);
    if (!fs.existsSync(tmp)) throw new Error('提取未生成产物');
    replaceFile(tmp, textPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw err;
  }
  return textPath;
}

function makeOriginalFallbackEntry(node, info, fallbackPath) {
  const fallbackInfo = { ...info, local_path: fallbackPath, text_path: null };
  const entry = makeSyncedEntry(node, fallbackInfo, 'file-original');
  entry.original_fallback = true;
  return entry;
}

async function downloadSingleLayoutFile(node, info, dir, previous, client) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-sync-convert-'));
  const tempPath = path.join(tempDir, info.file_name);
  try {
    const result = await downloadFile(node, tempPath, client);
    if (info.conversion === 'markdown') {
      fs.mkdirSync(path.dirname(info.text_path), { recursive: true });
      replaceFile(tempPath, info.text_path);
      const entry = makeSyncedEntry(node, info, 'file-markdown');
      removeObsoleteArtifacts(previous, entry, dir, CACHE_LAYOUTS.SINGLE);
      return entry;
    }

    try {
      const textPath = await extractFile(tempPath, node, info.text_path, CACHE_LAYOUTS.SINGLE);
      const entry = makeSyncedEntry(node, info, 'file-markdown');
      if (textPath) entry.text_path = textPath;
      removeObsoleteArtifacts(previous, entry, dir, CACHE_LAYOUTS.SINGLE);
      return entry;
    } catch (error) {
      if (!info.source_path) throw error;
      fs.mkdirSync(path.dirname(info.source_path), { recursive: true });
      replaceFile(tempPath, info.source_path);
      const entry = makeOriginalFallbackEntry(node, info, info.source_path);
      removeObsoleteArtifacts(previous, entry, dir, CACHE_LAYOUTS.SINGLE);
      return entry;
    }
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function downloadNode(node, info, dir, previous, client = http, layout = CACHE_LAYOUTS.LEGACY) {
  if (node.obj_type === 'docx' || node.obj_type === 'doc' || node.obj_type === 'sheet' || node.obj_type === 'bitable') {
    if (!info.text_path) return makeSkippedEntry(node, info);
    const result = await downloadOnline(node, info.text_path, client);
    if (result.skipped) return makeSkippedEntry(node, info);
    const entry = makeSyncedEntry(node, info, result.format);
    removeObsoleteArtifacts(previous, entry, dir, layout);
    return entry;
  }

  if (layout === CACHE_LAYOUTS.SINGLE && info.text_path && info.conversion) {
    return downloadSingleLayoutFile(node, info, dir, previous, client);
  }

  if (!info.local_path) throw new Error(`节点缺少本地原文路径: ${node.node_token}`);
  const result = await downloadFile(node, info.local_path, client);
  const textPath = await extractFile(result.filePath, node, info.text_path, layout);
  const entry = makeSyncedEntry(node, info, result.format);
  if (textPath) entry.text_path = textPath;
  removeObsoleteArtifacts(previous, entry, dir, layout);
  return entry;
}
/**
 * Synchronize documents directly into the final cache directory.
 * Each successful document is written independently; failed documents keep
 * their previous cache and remain eligible for retry.
 */
async function syncSpace(options) {
  const result = await syncSpaceAtDir(options);
  if (result.counts.failed > 0) {
    const error = new Error(`\u540c\u6b65\u90e8\u5206\u5b8c\u6210\uff1a\u6210\u529f\u6587\u6863\u5df2\u5199\u5165\u6b63\u5f0f\u7f13\u5b58\uff0c\u5931\u8d25\u6587\u6863\u4fdd\u7559\u539f\u7f13\u5b58\uff08${result.counts.failed} \u4e2a\u5931\u8d25\u9879\uff09`);
    error.code = 'SYNC_PARTIAL_FAILURE';
    error.result = result;
    throw error;
  }
  return result;
}

const CHANGE_DISPLAY_LIMIT = 10;

function documentChange(node, info, extra = {}) {
  return {
    node_token: node?.node_token || extra.node_token || null,
    title: node?.title || extra.title || null,
    format: node?.obj_type || extra.format || null,
    local_path: info?.local_path || extra.local_path || null,
    text_path: info?.text_path || extra.text_path || null,
    ...extra,
  };
}

function compactChangeList(items, includeAll = false) {
  const list = Array.isArray(items) ? items : [];
  return {
    count: list.length,
    items: includeAll ? list : list.slice(0, CHANGE_DISPLAY_LIMIT),
    truncated: !includeAll && list.length > CHANGE_DISPLAY_LIMIT,
  };
}

function summarizeChanges(changes) {
  return {
    added: compactChangeList(changes.added),
    updated: compactChangeList(changes.updated),
    moved: compactChangeList(changes.moved),
    deleted: compactChangeList(changes.deleted),
    skipped: compactChangeList(changes.skipped),
    failed: compactChangeList(changes.failed, true),
  };
}

function countsFromChanges(changes, unchanged = 0) {
  return {
    added: changes.added.length,
    updated: changes.updated.length,
    changed: changes.updated.length,
    moved: changes.moved.length,
    unchanged,
    deleted: changes.deleted.length,
    skipped: changes.skipped.length,
    failed: changes.failed.length,
  };
}

function formatChangeSummary(summary) {
  const labels = {
    added: 'Added',
    updated: 'Updated',
    moved: 'Moved',
    deleted: 'Deleted',
    skipped: 'Skipped',
    failed: 'Failed',
  };
  const lines = [];
  for (const [kind, label] of Object.entries(labels)) {
    const group = summary?.[kind];
    if (!group || !group.count) continue;
    lines.push(label + ': ' + group.count);
    for (const item of group.items || []) {
      let line = '  - ' + (item.title || item.node_token || '<unknown>');
      if (item.local_path) line += ' | ' + item.local_path;
      if (item.phase) line += ' | phase=' + item.phase;
      if (item.error) line += ' | error=' + item.error;
      lines.push(line);
    }
    if (group.truncated) lines.push('  ... ' + (group.count - (group.items || []).length) + ' more');
  }
  return lines;
}

async function syncSpaceAtDir({ kbName, spaceId, root, force = false, client = http, logger = console, cachePath = null, prepared: suppliedPrepared = null, onProgress = null, layout: requestedLayout = null }) {
  const prepared = suppliedPrepared || prepareCacheDir(root, kbName, spaceId);
  const dir = cachePath || prepared.dir;
  const layout = resolveCacheLayout(dir, requestedLayout || prepared.layout);
  if (prepared.legacyPresent) {
    logger.warn?.(`⚠️ 检测到旧 token 缓存目录仍存在: ${legacyCacheDir(root, spaceId)}；当前同步使用 ${dir}`);
  }

  logger.log?.(`[1/3] 遍历知识库「${kbName}」(${spaceId})...`);
  const result = await walk(spaceId, (count) => {
    if (count % 10 === 0) logger.log?.(`  已遍历 ${count} 节点`);
  }, client);
  logger.log?.(`  共 ${result.count} 节点${result.complete ? '' : '（遍历不完整）'}`);
  if (result.errors.length) {
    for (const error of result.errors) logger.warn?.(`  ⚠️ 子树遍历失败: ${error.parent || '根'} — ${error.message}`);
  }

  const tree = {
    space_id: String(spaceId),
    knowledge_base_name: kbName,
    updated_at: new Date().toISOString(),
    complete: result.complete,
    errors: result.errors,
    nodes: result.nodes,
  };
  writeJson(path.join(dir, 'tree.json'), tree);

  const manifest = readManifest(dir);
  if (prepared.migratedFrom) remapManifestPaths(manifest, prepared.migratedFrom, dir);
  const previousDocs = manifest.docs || {};
  const nodes = result.nodes;
  const pathInfo = buildNodePathInfo(nodes, dir, layout);
  const nextDocs = {};
  const todo = [];
  let addedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let movedCount = 0;
  let deletedCount = 0;
  let failedCount = 0;
  const changes = { added: [], updated: [], moved: [], deleted: [], skipped: [], failed: [] };

  // 完整树确认后处理删除；不完整遍历保留旧条目，防止误删。
  if (result.complete) {
    for (const [token, previous] of Object.entries(previousDocs)) {
      if (nodes[token]) continue;
      try {
        removeEntryArtifacts(previous, dir, new Set(), layout);
        deletedCount++;
        changes.deleted.push(documentChange(null, null, { node_token: token, title: previous.title || token, action: 'delete', local_path: previous.local_path || null, text_path: previous.text_path || null }));
        logger.log?.(`  删除本地镜像: ${previous.title || token}`);
      } catch (err) {
        failedCount++;
        nextDocs[token] = previous;
        changes.failed.push(documentChange(null, null, { node_token: token, title: previous.title || token, action: 'delete', phase: 'delete', local_path: previous.local_path || null, text_path: previous.text_path || null, error: err.message, preserved_previous: true }));
        logger.warn?.(`  ⚠️ 删除本地镜像失败: ${previous.title || token} — ${err.message}`);
      }
    }
  }

  for (const [token, node] of Object.entries(nodes)) {
    const info = pathInfo[token];
    const previous = previousDocs[token];

    if (node.has_child) {
      if (previous && !previous.container) removeEntryArtifacts(previous, dir, new Set(), layout);
      nextDocs[token] = makeContainerEntry(node, info);
      continue;
    }

    const desired = expectedPaths(node, info);
    if (needsSync(previous, node, info, force, layout)) {
      if (previous) changedCount++;
      else addedCount++;
      todo.push({ token, node, info, previous, action: previous ? 'updated' : 'added' });
      continue;
    }

    try {
      if (previous && pathsChanged(previous, desired)) {
        reconcileCachedPaths(previous, desired, dir, layout);
        movedCount++;
        changes.moved.push(documentChange(node, info, { action: 'moved', previous_local_path: previous.local_path || null, previous_text_path: previous.text_path || null }));
      }
      nextDocs[token] = refreshEntry(previous, node, info);
      unchangedCount++;
    } catch (err) {
      failedCount++;
      nextDocs[token] = previous || undefined;
      changes.failed.push(documentChange(node, info, { action: 'moved', phase: 'path', error: err.message, preserved_previous: Boolean(previous) }));
      logger.warn?.(`  ⚠️ 本地路径处理失败: ${node.title || token} — ${err.message}`);
    }
  }

  onProgress?.({ phase: 'syncing', total_documents: todo.length, completed_documents: 0, detected: { added: addedCount, updated: changedCount, moved: movedCount, deleted: deletedCount }, failed: failedCount });

  logger.log?.(`[2/3] 差异: 新增 ${addedCount} / 变更 ${changedCount} / 移动或重命名 ${movedCount} / 未变 ${unchangedCount} / 已删除 ${deletedCount}${force ? '（--force 全量重下）' : ''}`);
  logger.log?.(`[3/3] 同步 ${todo.length} 个文档（HTTP 并发）...`);

  let completedDownloads = 0;
  const results = await mapLimit(todo, Math.max(CONCURRENCY.ONLINE, CONCURRENCY.DOWNLOAD), async (task) => {
    try {
      const entry = await downloadNode(task.node, task.info, dir, task.previous, client, layout);
      logger.log?.(`  ${task.node.title || task.token} → ${entry.format}`);
      completedDownloads++;
      onProgress?.({ phase: 'syncing', total_documents: todo.length, completed_documents: completedDownloads, detected: { added: addedCount, updated: changedCount, moved: movedCount, deleted: deletedCount }, failed: failedCount });
      return { ...task, ok: true, entry };
    } catch (err) {
      if (err.code === 'FILE_NO_PERMISSION') {
        logger.log?.(`  ⚠️ ${task.node.title || task.token}: 无下载权限（跳过，已登记）`);
        completedDownloads++;
        onProgress?.({ phase: 'syncing', total_documents: todo.length, completed_documents: completedDownloads, detected: { added: addedCount, updated: changedCount, moved: movedCount, deleted: deletedCount }, failed: failedCount });
        return { ...task, ok: true, skipped: true, entry: makeNoPermissionEntry(task.node, task.info) };
      }
      logger.error?.(`  ✗ ${task.node.title || task.token}: ${err.message.slice(0, 500)}`);
      completedDownloads++;
      onProgress?.({ phase: 'syncing', total_documents: todo.length, completed_documents: completedDownloads, detected: { added: addedCount, updated: changedCount, moved: movedCount, deleted: deletedCount }, failed: failedCount + 1 });
      return { ...task, ok: false, error: err };
    }
  });

  for (const task of results) {
    if (task.ok) {
      nextDocs[task.token] = task.entry;
      if (task.skipped) {
        changes.skipped.push(documentChange(task.node, task.info, { action: 'skipped', phase: 'download', reason: 'no_permission', preserved_previous: Boolean(task.previous) }));
      } else {
        changes[task.action].push(documentChange(task.node, task.info, { action: task.action, format: task.entry.format, local_path: task.entry.localPath || task.info.local_path || null, text_path: task.entry.textPath || task.info.text_path || null }));
      }
    } else {
      if (task.previous) nextDocs[task.token] = task.previous;
      failedCount++;
      changes.failed.push(documentChange(task.node, task.info, { action: task.action, phase: 'download', error: task.error?.message || 'unknown error', preserved_previous: Boolean(task.previous) }));
    }
  }

  if (!result.complete) {
    for (const [token, previous] of Object.entries(previousDocs)) {
      if (!Object.prototype.hasOwnProperty.call(nextDocs, token)) nextDocs[token] = previous;
    }
  }

  const outputManifest = {
    space_id: String(spaceId),
    knowledge_base_name: kbName,
    updated_at: new Date().toISOString(),
    complete: result.complete,
    docs: nextDocs,
  };
  if (layout === CACHE_LAYOUTS.SINGLE) outputManifest.cache_layout = CACHE_LAYOUTS.SINGLE;
  writeJson(path.join(dir, 'manifest.json'), outputManifest);
  removeEmptyDirs(dir, layout);

  onProgress?.({ phase: 'finalizing', total_documents: todo.length, completed_documents: completedDownloads, detected: { added: addedCount, updated: changedCount, moved: movedCount, deleted: deletedCount }, failed: failedCount });

  const counts = countsFromChanges(changes, unchangedCount);
  const summary = summarizeChanges(changes);
  logger.log?.('Sync completed: added ' + counts.added + ' / updated ' + counts.updated + ' / deleted ' + counts.deleted + ' / failed ' + counts.failed);
  if (counts.failed > 0) logger.log?.('Failed documents kept their previous cache when available and will be retried.');
  const resultManifest = {
    ...manifest,
    complete: result.complete,
    docs: nextDocs,
  };
  if (layout === CACHE_LAYOUTS.SINGLE) resultManifest.cache_layout = CACHE_LAYOUTS.SINGLE;
  else delete resultManifest.cache_layout;

  return {
    dir,
    layout,
    tree: tree,
    manifest: resultManifest,
    counts,
    changes: summary,
    summary,
  };
}

function parseSyncArgs(argv) {
  const options = {
    kbName: null,
    spaceId: null,
    all: false,
    force: false,
    background: false,
    json: false,
    worker: false,
    runId: null,
    trigger: 'manual',
    reason: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--background') options.background = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--worker') options.worker = true;
    else if (arg === '--space-id') {
      options.spaceId = argv[++i];
      if (!options.spaceId) throw new Error('--space-id requires a value');
    } else if (arg === '--run-id') {
      options.runId = argv[++i];
      if (!options.runId) throw new Error('--run-id requires a value');
    } else if (arg === '--trigger') {
      options.trigger = argv[++i];
      if (!options.trigger) throw new Error('--trigger requires a value');
    } else if (arg === '--reason') {
      options.reason = argv[++i];
      if (!options.reason || !String(options.reason).trim()) throw new Error('--reason requires a value');
    } else if (arg.startsWith('-')) {
      throw new Error('unknown argument: ' + arg + '\nusage: feishu-kb-sync sync <name> | --space-id <space_id> | --all [--force] [--background] [--json] [--trigger manual|scheduled] [--reason <text>]');
    } else if (!options.kbName) {
      options.kbName = arg;
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }

  if (options.kbName && options.spaceId) throw new Error('knowledge-base name and --space-id are mutually exclusive');
  if (options.all && (options.kbName || options.spaceId)) throw new Error('--all cannot be combined with a knowledge-base name or --space-id');
  if (options.worker && !options.runId) throw new Error('background worker requires --run-id');
  if (options.worker && options.background) throw new Error('--worker cannot be combined with --background');
  Object.assign(options, syncTriggerMetadata(options));
  return options;
}

function parseStatusArgs(argv) {
  let kbName = null;
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}\n用法: feishu-kb-sync status <库名> [--json]`);
    else if (!kbName) kbName = arg;
    else throw new Error(`未知参数: ${arg}`);
  }
  return { kbName, json };
}

function resolveKnowledgeBase(kbName, cfg, requestedSpaceId = null) {
  const spaces = cfg.spaces || {};
  const names = Object.keys(spaces);
  let spaceId = requestedSpaceId == null ? null : String(requestedSpaceId);

  if (spaceId) {
    const match = Object.entries(spaces).find(([, configuredId]) => String(configuredId) === spaceId);
    if (!match) throw new Error('space_id is not configured: ' + spaceId);
    kbName = match[0];
  }

  if (!kbName) {
    if (names.length === 0) throw new Error('no knowledge base is configured');
    if (names.length > 1) throw new Error('specify a knowledge base: ' + names.join(' / '));
    kbName = names[0];
  }
  if (!spaces[kbName]) throw new Error('knowledge base is not configured: ' + kbName);
  const configuredSpaceId = String(spaces[kbName]);
  if (spaceId && configuredSpaceId !== spaceId) {
    throw new Error('knowledge base does not match --space-id: ' + kbName);
  }
  spaceId = configuredSpaceId;
  const cachePath = cacheDir(cfg.root, kbName);
  const paths = runState.getRunPaths(spaceId, { appDir: config.APP_DIR });
  return { kbName, spaceId, root: cfg.root, cachePath, paths };
}

function resolveKnowledgeBases(cfg) {
  const names = Object.keys(cfg.spaces || {});
  if (names.length === 0) throw new Error('no knowledge base is configured');
  return names.map((name) => resolveKnowledgeBase(name, cfg));
}

function identityFor(context) {
  return {
    kbName: context.kbName,
    spaceId: context.spaceId,
    cacheDir: context.cachePath,
  };
}

function statusFor(context) {
  let status = runState.reconcileRunningStatus(context.paths, identityFor(context));
  const lock = runState.readLock(context.paths);
  if (lock && runState.lockIsAlive(lock) && status.status !== 'running') {
    status = runState.writeStatus(context.paths, {
      ...status,
      status: 'running',
      started_at: lock.started_at || status.started_at,
      finished_at: null,
      pid: lock.worker_pid || lock.pid || null,
      run_id: lock.run_id || status.run_id,
      trigger: lock.trigger || status.trigger,
      reason: lock.reason || status.reason,
      last_error: null,
    });
  }
  return {
    ok: true,
    ...status,
    knowledge_base: context.kbName,
    space_id: context.spaceId,
    cache_dir: context.cachePath,
    log_file: context.paths.logFile,
  };
}

function errorText(err) {
  return String(err?.message || err || '未知错误').slice(0, 2000);
}

function appendLog(logFile, level, args) {
  const text = args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${level.toUpperCase()} ${text}\n`, 'utf8');
  } catch (_) {
    // 日志写入失败不应掩盖同步结果；状态文件仍然是机器可读的事实来源。
  }
}

function createSyncLogger(logFile, echo) {
  const write = (level, args) => {
    appendLog(logFile, level, args);
    if (!echo) return;
    const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    output(...args);
  };
  return {
    log(...args) { write('info', args); },
    warn(...args) { write('warn', args); },
    error(...args) { write('error', args); },
  };
}

function setRunningStatus(context, runId, pid, startedAt, metadata = {}) {
  const current = runState.readStatus(context.paths, identityFor(context));
  const trigger = syncTriggerMetadata(metadata);
  return runState.writeStatus(context.paths, {
    ...current,
    ...identityFor(context),
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    trigger: trigger.trigger,
    reason: trigger.reason,
    last_error: null,
    pid: pid || null,
    run_id: runId,
    last_run_id: current.last_run_id || null,
  });
}

function backgroundPayload(context, status, action, started) {
  return {
    ok: true,
    action,
    status: status.status,
    knowledge_base: context.kbName,
    space_id: context.spaceId,
    cache_dir: context.cachePath,
    log_file: context.paths.logFile,
    run_id: status.run_id || null,
    pid: status.pid || null,
    started_at: status.started_at || null,
    trigger: status.trigger || null,
    reason: status.reason || null,
    started,
  };
}

function markBackgroundFailure(context, runId, err) {
  const current = runState.readStatus(context.paths, identityFor(context));
  runState.writeStatus(context.paths, {
    ...current,
    status: 'failed',
    finished_at: runState.now(),
    pid: null,
    run_id: null,
    last_run_id: runId,
    last_error: errorText(err),
  });
  runState.releaseLock(context.paths, runId);
  appendLog(context.paths.logFile, 'error', [`后台同步启动失败: ${errorText(err)}`]);
}

function startBackgroundSync(context, options) {
  const runId = options.runId || crypto.randomUUID();
  const startedAt = runState.now();
  const trigger = syncTriggerMetadata(options);
  const acquired = runState.acquireLock(context.paths, {
    run_id: runId,
    knowledge_base: context.kbName,
    space_id: context.spaceId,
    pid: process.pid,
    launcher_pid: process.pid,
    role: 'launcher',
    trigger: trigger.trigger,
    reason: trigger.reason,
    started_at: startedAt,
  });

  if (!acquired.acquired) {
    const status = statusFor(context);
    return backgroundPayload(context, status, 'already_running', false);
  }

  let running = setRunningStatus(context, runId, null, startedAt, trigger);
  const logger = createSyncLogger(context.paths.logFile, false);
  logger.log(`后台同步已启动: ${context.kbName}`);

  const cliPath = path.resolve(__dirname, '..', 'bin', 'feishu-kb-sync.js');
  const workerArgs = [cliPath, 'sync', '--space-id', context.spaceId];
  if (options.force) workerArgs.push('--force');
  workerArgs.push('--worker', '--run-id', runId, '--trigger', trigger.trigger, '--reason', trigger.reason);

  try {
    const child = spawn(process.execPath, workerArgs, {
      cwd: path.dirname(cliPath),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, FEISHU_KB_SYNC_WORKER: '1' },
    });
    if (!child.pid) throw new Error('后台 worker 未返回进程号');
    runState.updateLock(context.paths, runId, {
      pid: child.pid,
      worker_pid: child.pid,
      role: 'worker',
    });
    running = runState.writeStatus(context.paths, {
      ...running,
      pid: child.pid,
    });
    child.once('error', (err) => markBackgroundFailure(context, runId, err));
    child.unref();
    return backgroundPayload(context, running, 'started', true);
  } catch (err) {
    markBackgroundFailure(context, runId, err);
    throw err;
  }
}

async function executeSync(context, options) {
  const runId = options.runId || crypto.randomUUID();
  const startedAt = runState.now();
  const trigger = syncTriggerMetadata(options);
  let acquired;

  if (options.worker) {
    const lock = runState.readLock(context.paths);
    if (!lock || lock.run_id !== runId) {
      const err = new Error('Sync worker lock is missing or owned by another run');
      err.code = 'SYNC_LOCK_MISSING';
      throw err;
    }
    runState.updateLock(context.paths, runId, {
      pid: process.pid,
      worker_pid: process.pid,
      role: 'worker',
    });
    acquired = { acquired: true };
  } else {
    acquired = runState.acquireLock(context.paths, {
      run_id: runId,
      knowledge_base: context.kbName,
      space_id: context.spaceId,
      pid: process.pid,
      role: 'foreground',
      trigger: trigger.trigger,
      reason: trigger.reason,
      started_at: startedAt,
    });
  }

  if (!acquired.acquired) {
    const status = statusFor(context);
    const err = new Error('A sync task is already running for this knowledge base');
    err.code = 'SYNC_ALREADY_RUNNING';
    err.status = status;
    throw err;
  }

  const running = setRunningStatus(context, runId, process.pid, startedAt, trigger);
  const initialProgress = {
    phase: 'starting',
    total_nodes: null,
    total_documents: null,
    completed_documents: 0,
    detected: { added: 0, updated: 0, moved: 0, deleted: 0 },
    failed: 0,
  };
  runState.writeStatus(context.paths, { ...running, progress: initialProgress });
  const logger = createSyncLogger(context.paths.logFile, !options.worker && !options.json);
  let lastProgressWrite = 0;
  const reportProgress = (progress, force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastProgressWrite < 500) return;
    lastProgressWrite = nowMs;
    runState.writeStatus(context.paths, { ...running, progress });
  };
  logger.log('Starting sync for ' + context.kbName);

  try {
    const result = await syncSpace({
      kbName: context.kbName,
      spaceId: context.spaceId,
      root: context.root,
      force: options.force,
      logger,
      onProgress: reportProgress,
    });
    const finishedAt = runState.now();
    const completedProgress = {
      phase: 'completed',
      total_nodes: result.tree?.nodes ? Object.keys(result.tree.nodes).length : null,
      total_documents: result.counts.added + result.counts.updated + result.counts.moved + result.counts.deleted + result.counts.unchanged,
      completed_documents: result.counts.added + result.counts.updated + result.counts.moved + result.counts.deleted,
      detected: { added: result.counts.added, updated: result.counts.updated, moved: result.counts.moved, deleted: result.counts.deleted },
      failed: result.counts.failed,
    };
    runState.writeStatus(context.paths, {
      ...running,
      status: 'success',
      finished_at: finishedAt,
      last_success_at: finishedAt,
      last_error: null,
      progress: completedProgress,
      last_counts: result.counts,
      last_summary: result.summary,
      pid: null,
      run_id: null,
      last_run_id: runId,
    });
    runState.releaseLock(context.paths, runId);
    logger.log('Sync succeeded for ' + context.kbName);
    return result;
  } catch (err) {
    const finishedAt = runState.now();
    const failedResult = err.result || null;
    runState.writeStatus(context.paths, {
      ...running,
      status: 'failed',
      finished_at: finishedAt,
      last_error: errorText(err),
      progress: { phase: 'failed', error: errorText(err) },
      last_counts: failedResult?.counts || null,
      last_summary: failedResult?.summary || null,
      pid: null,
      run_id: null,
      last_run_id: runId,
    });
    runState.releaseLock(context.paths, runId);
    logger.error('Sync failed for ' + context.kbName + ': ' + errorText(err));
    throw err;
  }
}

function allRunPaths(appDir = config.APP_DIR) {
  return runState.getRunPaths(ALL_SCOPE_ID, { appDir });
}

function allKnowledgeBasePayload(contexts) {
  return contexts.map((context) => ({
    knowledge_base: context.kbName,
    space_id: context.spaceId,
    cache_dir: context.cachePath,
    log_file: context.paths.logFile,
  }));
}

function allBackgroundPayload(contexts, status, action, started, metadata = {}) {
  return {
    ok: true,
    action,
    status,
    scope: 'all',
    knowledge_bases: allKnowledgeBasePayload(contexts),
    run_id: metadata.run_id || null,
    pid: metadata.pid || null,
    started_at: metadata.started_at || null,
    trigger: metadata.trigger || null,
    reason: metadata.reason || null,
    started,
  };
}

function acquireAllRun(paths, metadata) {
  return runState.acquireLock(paths, {
    run_id: metadata.run_id,
    knowledge_base: '<all>',
    space_id: ALL_SCOPE_ID,
    pid: Number(metadata.pid || process.pid),
    launcher_pid: metadata.launcher_pid == null ? Number(metadata.pid || process.pid) : Number(metadata.launcher_pid),
    worker_pid: metadata.worker_pid == null ? null : Number(metadata.worker_pid),
    role: metadata.role || 'foreground',
    trigger: metadata.trigger || null,
    reason: metadata.reason || null,
    started_at: metadata.started_at || runState.now(),
  });
}

async function executeAllSync(contexts, options = {}, execute = executeSync, statusReader = statusFor) {
  const paths = allRunPaths(options.appDir);
  const runId = options.runId || crypto.randomUUID();
  const startedAt = runState.now();
  const trigger = syncTriggerMetadata(options);
  let acquired;

  if (options.worker) {
    const lock = runState.readLock(paths);
    if (!lock || lock.run_id !== runId) {
      const err = new Error('All-knowledge-base sync worker lock is missing or owned by another run');
      err.code = 'SYNC_ALL_LOCK_MISSING';
      throw err;
    }
    runState.updateLock(paths, runId, {
      pid: process.pid,
      worker_pid: process.pid,
      role: 'worker',
    });
    acquired = { acquired: true };
  } else {
    acquired = acquireAllRun(paths, {
      run_id: runId,
      pid: process.pid,
      role: 'foreground',
      trigger: trigger.trigger,
      reason: trigger.reason,
      started_at: startedAt,
    });
  }

  if (!acquired.acquired) {
    const err = new Error('An all-knowledge-base sync task is already running');
    err.code = 'SYNC_ALL_ALREADY_RUNNING';
    throw err;
  }

  const results = [];
  try {
    for (const context of contexts) {
      try {
        const result = await execute(context, {
          ...options,
          background: false,
          worker: false,
          runId: null,
        });
        results.push({
          ok: true,
          status: 'success',
          knowledge_base: context.kbName,
          space_id: context.spaceId,
          cache_dir: context.cachePath,
          log_file: context.paths.logFile,
          counts: result.counts || null,
          changes: result.summary || result.changes || null,
        });
      } catch (err) {
        const alreadyRunning = err.code === 'SYNC_ALREADY_RUNNING';
        results.push({
          ok: false,
          status: alreadyRunning ? 'skipped' : 'failed',
          knowledge_base: context.kbName,
          space_id: context.spaceId,
          cache_dir: context.cachePath,
          log_file: context.paths.logFile,
          reason: alreadyRunning ? 'already_running' : null,
          error: errorText(err),
          sync_status: statusReader(context),
        });
      }
    }

    const incomplete = results.filter((item) => item.status !== 'success');
    return {
      ok: incomplete.length === 0,
      action: 'completed',
      status: incomplete.length === 0 ? 'success' : 'partial_failure',
      scope: 'all',
      trigger: trigger.trigger,
      reason: trigger.reason,
      started_at: startedAt,
      finished_at: runState.now(),
      knowledge_bases: results,
    };
  } finally {
    runState.releaseLock(paths, runId);
  }
}

function startBackgroundSyncAll(contexts, options) {
  const paths = allRunPaths(options.appDir);
  const runId = options.runId || crypto.randomUUID();
  const startedAt = runState.now();
  const trigger = syncTriggerMetadata(options);
  const acquired = acquireAllRun(paths, {
    run_id: runId,
    pid: process.pid,
    launcher_pid: process.pid,
    role: 'launcher',
    trigger: trigger.trigger,
    reason: trigger.reason,
    started_at: startedAt,
  });

  if (!acquired.acquired) {
    const status = acquired.lock || {};
    return allBackgroundPayload(contexts, 'running', 'already_running', false, {
      run_id: status.run_id || null,
      pid: status.worker_pid || status.pid || null,
      started_at: status.started_at || null,
      trigger: status.trigger || null,
      reason: status.reason || null,
    });
  }

  const cliPath = path.resolve(__dirname, '..', 'bin', 'feishu-kb-sync.js');
  const workerArgs = [
    cliPath,
    'sync',
    '--all',
    '--worker',
    '--run-id', runId,
    '--trigger', trigger.trigger,
    '--reason', trigger.reason,
  ];
  if (options.force) workerArgs.push('--force');

  try {
    const child = spawn(process.execPath, workerArgs, {
      cwd: path.dirname(cliPath),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, FEISHU_KB_SYNC_WORKER: '1' },
    });
    if (!child.pid) throw new Error('all-knowledge-base background worker did not return a process id');
    runState.updateLock(paths, runId, {
      pid: child.pid,
      worker_pid: child.pid,
      role: 'worker',
    });
    child.unref();
    return allBackgroundPayload(contexts, 'running', 'started', true, {
      run_id: runId,
      pid: child.pid,
      started_at: startedAt,
      trigger: trigger.trigger,
      reason: trigger.reason,
    });
  } catch (err) {
    runState.releaseLock(paths, runId);
    throw err;
  }
}

function printAllSyncResult(result) {
  if (result.action === 'started' || result.action === 'already_running') {
    console.log('All knowledge bases: ' + result.action);
    for (const item of result.knowledge_bases || []) console.log('  - ' + item.knowledge_base);
    return;
  }
  console.log('All knowledge bases sync: ' + result.status);
  for (const item of result.knowledge_bases || []) {
    console.log('  - ' + item.knowledge_base + ': ' + item.status + (item.error ? ' | ' + item.error : ''));
  }
}

async function sync(argv) {
  const options = parseSyncArgs(argv);
  const cfg = config.loadConfig();
  if (options.all) {
    const contexts = resolveKnowledgeBases(cfg);
    if (options.background) {
      const payload = startBackgroundSyncAll(contexts, options);
      if (options.json) console.log(JSON.stringify(payload));
      else printAllSyncResult(payload);
      return payload;
    }
    const result = await executeAllSync(contexts, options);
    if (options.json) console.log(JSON.stringify(result));
    else printAllSyncResult(result);
    return result;
  }

  const context = resolveKnowledgeBase(options.kbName, cfg, options.spaceId);

  if (options.background) {
    const payload = startBackgroundSync(context, options);
    if (options.json) console.log(JSON.stringify(payload));
    else if (payload.action === 'already_running') console.log(`知识库「${context.kbName}」已有同步任务运行，继续使用旧缓存。`);
    else console.log(`已启动知识库「${context.kbName}」后台同步（PID ${payload.pid}）。日志: ${payload.log_file}`);
    return payload;
  }

  const result = await executeSync(context, options);
  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      action: 'completed',
      status: 'success',
      knowledge_base: context.kbName,
      space_id: context.spaceId,
      cache_dir: context.cachePath,
      log_file: context.paths.logFile,
      counts: result.counts,
      changes: result.summary,
    }));
  } else {
    for (const line of formatChangeSummary(result.summary)) console.log(line);
  }
  return result;
}

async function status(argv) {
  const options = parseStatusArgs(argv);
  const cfg = config.loadConfig();
  const contexts = options.kbName
    ? [resolveKnowledgeBase(options.kbName, cfg)]
    : Object.keys(cfg.spaces || {}).map((name) => resolveKnowledgeBase(name, cfg));
  if (contexts.length === 0) throw new Error('No knowledge base is configured');

  const payloads = contexts.map(statusFor);
  if (options.json) {
    console.log(JSON.stringify(options.kbName ? payloads[0] : {
      ok: true,
      knowledge_bases: payloads,
    }));
  } else {
    for (const payload of payloads) {
      console.log('Knowledge base: ' + payload.knowledge_base);
      console.log('  space_id: ' + payload.space_id);
      console.log('  sync_status: ' + payload.status);
      console.log('  cache_dir: ' + payload.cache_dir);
      if (payload.started_at) console.log('  started_at: ' + payload.started_at);
      if (payload.finished_at) console.log('  finished_at: ' + payload.finished_at);
      if (payload.last_success_at) console.log('  last_success_at: ' + payload.last_success_at);
      if (payload.last_error) console.log('  last_error: ' + payload.last_error);
      if (payload.pid) console.log('  pid: ' + payload.pid);
      if (payload.progress) {
        const progress = payload.progress;
        const completed = progress.completed_documents == null ? '' : progress.completed_documents;
        const total = progress.total_documents == null ? '?' : progress.total_documents;
        console.log('  progress: ' + (progress.phase || 'unknown') + ' ' + completed + '/' + total);
        if (progress.detected) console.log('  detected: added=' + progress.detected.added + ' updated=' + progress.detected.updated + ' moved=' + progress.detected.moved + ' deleted=' + progress.detected.deleted);
      }
      if (payload.last_counts) console.log('  last_summary: added=' + payload.last_counts.added + ' updated=' + payload.last_counts.updated + ' moved=' + payload.last_counts.moved + ' deleted=' + payload.last_counts.deleted + ' failed=' + payload.last_counts.failed);
      for (const line of formatChangeSummary(payload.last_summary)) console.log('  ' + line);
      console.log('  log_file: ' + payload.log_file);
    }
  }
  return options.kbName ? payloads[0] : { ok: true, knowledge_bases: payloads };
}

module.exports = {
  sync,
  status,
  ALL_SCOPE_ID,
  syncSpace,
  syncSpaceAtDir,
  CACHE_LAYOUTS,
  detectCacheLayout,
  resolveCacheLayout,
  startBackgroundSync,
  startBackgroundSyncAll,
  executeSync,
  executeAllSync,
  parseSyncArgs,
  parseStatusArgs,
  resolveKnowledgeBase,
  resolveKnowledgeBases,
  statusFor,
  walk,
  downloadOnline,
  downloadFile,
  extractFile,
  buildLocalSegments,
  buildNodePathInfo,
  buildTitleFilenames: buildLocalSegments,
  sanitize: sanitizeSegment,
  cacheDir,
  legacyCacheDir,
  prepareCacheDir,
  remapManifestPaths,
  removeEmptyDirs,
};