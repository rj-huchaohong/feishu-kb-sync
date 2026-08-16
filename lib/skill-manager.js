'use strict';

/**
 * Knowledge-base Skill lifecycle manager.
 *
 * Each configured knowledge base owns one generated Skill directory. The marker
 * file keeps lifecycle operations scoped to directories created by this module.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isPathInside } = require('./paths.js');

const MANAGED_MARKER = '.feishu-kb-sync.json';
const SKILL_PREFIX = 'feishu-kb-';
const MANAGED_BY = 'feishu-kb-sync';
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SUFFIX_LENGTH = MAX_SKILL_NAME_LENGTH - SKILL_PREFIX.length;
const UNICODE_NAME_MODE = 'unicode';

function defaultSkillsRoot() {
  return path.join(os.homedir(), '.agents', 'skills');
}

function resolveSkillsRoot(root) {
  return path.resolve(root || defaultSkillsRoot());
}

function normalizeAsciiSuffix(value) {
  const source = String(value ?? '').normalize('NFKC').trim().toLowerCase();
  if (!source || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source)) return '';
  return source.slice(0, MAX_SUFFIX_LENGTH).replace(/-+$/g, '');
}

function normalizeUnicodeSuffix(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, MAX_SUFFIX_LENGTH)
    .replace(/-+$/g, '');
}

function unicodeNamesEnabled() {
  return String(process.env.FEISHU_KB_SKILL_NAME_MODE || '').trim().toLowerCase() === UNICODE_NAME_MODE;
}

function suffixRequiredError() {
  const error = new Error('\u9996\u6b21\u521b\u5efa\u77e5\u8bc6\u5e93\u65f6\u5fc5\u987b\u7531\u7528\u6237\u63d0\u4f9b Skill \u7b80\u79f0\uff1a--skill-suffix <\u7b80\u79f0>');
  error.code = 'SKILL_SUFFIX_REQUIRED';
  return error;
}

function invalidSuffixError() {
  const message = unicodeNamesEnabled()
    ? '\u7528\u6237\u63d0\u4f9b\u7684 Skill \u7b80\u79f0\u4e0d\u5305\u542b\u53ef\u7528\u5b57\u7b26'
    : '\u8bf7\u63d0\u4f9b\u82f1\u6587 Skill \u7b80\u79f0\uff08\u5c0f\u5199\u5b57\u6bcd\u3001\u6570\u5b57\u548c\u8fde\u5b57\u7b26\uff09';
  const error = new Error(message);
  error.code = 'SKILL_SUFFIX_INVALID';
  return error;
}

/**
 * Resolve a Skill suffix from a value supplied by the user during knowledge-base
 * initialization. Existing suffixes are reused only because they were already
 * recorded from an earlier user choice.
 */
function resolveSkillSuffix({ requestedSuffix = null, existingSuffix = null }) {
  const source = requestedSuffix || existingSuffix;
  if (!source || !String(source).trim()) throw suffixRequiredError();

  const candidate = unicodeNamesEnabled()
    ? normalizeUnicodeSuffix(source)
    : normalizeAsciiSuffix(source);
  if (!candidate) throw invalidSuffixError();
  return candidate;
}

function skillNameForSuffix(suffix) {
  const name = `${SKILL_PREFIX}${suffix}`;
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`生成的 Skill 名称过长：${name}`);
  }
  return name;
}

function safeDisplayName(value) {
  return String(value ?? '').replace(/[<>]/g, '').trim() || '未命名知识库';
}

function cliQuoted(value) {
  return JSON.stringify(String(value ?? '')).replace(/</g, '').replace(/>/g, '');
}

function renderSkill({ knowledgeBaseName, skillName }) {
  const displayName = safeDisplayName(knowledgeBaseName);
  const sentence = `feishu-kb-query skill\u4e2d\u77e5\u8bc6\u5e93\u4f7f\u7528\u300c${displayName}\u300d\u3002`;
  const body = `---
name: ${skillName}
description: ${JSON.stringify(sentence)}
---

${sentence}
`;
  return { description: sentence, body };
}

function markerPath(skillDir) {
  return path.join(skillDir, MANAGED_MARKER);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readManagedMarker(skillDir) {
  const marker = readJson(markerPath(skillDir));
  if (!marker || marker.managed_by !== MANAGED_BY) return null;
  return marker;
}

function listManagedSkills(root, spaceId = null) {
  const skillsRoot = resolveSkillsRoot(root);
  if (!fs.existsSync(skillsRoot)) return [];
  const result = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(skillsRoot, entry.name);
    const marker = readManagedMarker(directory);
    if (!marker) continue;
    if (spaceId != null && String(marker.space_id) !== String(spaceId)) continue;
    result.push({ directory, marker });
  }
  return result;
}

function assertSkillDirectoryIsManaged(directory, spaceId) {
  const marker = readManagedMarker(directory);
  if (!marker || String(marker.space_id) !== String(spaceId)) {
    throw new Error(`Skill 目录冲突：${directory} 不是当前知识库的托管目录`);
  }
  return marker;
}

function replaceTextFile(file, content) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content, 'utf8');
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(err.code)) throw err;
    fs.rmSync(file, { force: true });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function ensureSkillDirectory({ skillsRoot, skillName, spaceId, existing }) {
  const directory = path.join(skillsRoot, skillName);
  if (existing && path.resolve(existing.directory) !== path.resolve(directory)) {
    if (fs.existsSync(directory)) {
      assertSkillDirectoryIsManaged(directory, spaceId);
      throw new Error(`Skill 名称冲突：${directory} 已由另一个托管记录占用`);
    }
    fs.renameSync(existing.directory, directory);
  } else if (fs.existsSync(directory)) {
    assertSkillDirectoryIsManaged(directory, spaceId);
  } else {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

function syncKnowledgeBaseSkill({ skillsRoot = null, knowledgeBaseName, spaceId, requestedSuffix = null, existingSuffix = null }) {
  if (!knowledgeBaseName) throw new Error('生成知识库 Skill 需要 knowledgeBaseName');
  if (spaceId == null || String(spaceId).trim() === '') throw new Error('生成知识库 Skill 需要 spaceId');

  const root = resolveSkillsRoot(skillsRoot);
  fs.mkdirSync(root, { recursive: true });

  const suffix = resolveSkillSuffix({ requestedSuffix, existingSuffix });
  const skillName = skillNameForSuffix(suffix);
  const existing = listManagedSkills(root, spaceId).find((item) => item.marker.skill_name === skillName)
    || listManagedSkills(root, spaceId)[0]
    || null;
  const directory = ensureSkillDirectory({ skillsRoot: root, skillName, spaceId, existing });
  const rendered = renderSkill({ knowledgeBaseName, spaceId, skillName, suffix });
  const marker = {
    managed_by: MANAGED_BY,
    marker_version: 1,
    knowledge_base_name: String(knowledgeBaseName),
    space_id: String(spaceId),
    skill_name: skillName,
    skill_suffix: suffix,
    generated_at: new Date().toISOString(),
  };

  replaceTextFile(path.join(directory, 'SKILL.md'), rendered.body);
  replaceTextFile(markerPath(directory), `${JSON.stringify(marker, null, 2)}\n`);

  for (const item of listManagedSkills(root, spaceId)) {
    if (path.resolve(item.directory) === path.resolve(directory)) continue;
    if (!isPathInside(root, item.directory) || path.dirname(path.resolve(item.directory)) !== path.resolve(root)) {
      throw new Error(`托管 Skill 路径越界：${item.directory}`);
    }
    fs.rmSync(item.directory, { recursive: true, force: true });
  }

  return {
    skillsRoot: root,
    directory,
    skillName,
    suffix,
    marker,
  };
}

function removeKnowledgeBaseSkills({ skillsRoot = null, spaceId }) {
  if (spaceId == null || String(spaceId).trim() === '') throw new Error('删除知识库 Skill 需要 spaceId');
  const root = resolveSkillsRoot(skillsRoot);
  const removed = [];
  for (const item of listManagedSkills(root, spaceId)) {
    if (!isPathInside(root, item.directory) || path.dirname(path.resolve(item.directory)) !== path.resolve(root)) {
      throw new Error(`托管 Skill 路径越界：${item.directory}`);
    }
    fs.rmSync(item.directory, { recursive: true, force: true });
    removed.push(item.directory);
  }
  return { skillsRoot: root, removed };
}

module.exports = {
  MANAGED_MARKER,
  MANAGED_BY,
  SKILL_PREFIX,
  MAX_SKILL_NAME_LENGTH,
  defaultSkillsRoot,
  resolveSkillsRoot,
  normalizeAsciiSuffix,
  normalizeUnicodeSuffix,
  resolveSkillSuffix,
  skillNameForSuffix,
  renderSkill,
  readManagedMarker,
  listManagedSkills,
  syncKnowledgeBaseSkill,
  removeKnowledgeBaseSkills,
};
