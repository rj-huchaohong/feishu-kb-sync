'use strict';

const path = require('path');

const INVALID_SEGMENT_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
const TRAILING_DOTS_SPACES = /[. ]+$/g;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * 将飞书标题转换为单个本地路径段。
 * 路径段不允许携带目录分隔符，避免远端标题改变本地目录层级或越界写入。
 */
function sanitizeSegment(value, fallback = '未命名') {
  let segment = String(value ?? '')
    .replace(INVALID_SEGMENT_CHARS, '_')
    .replace(/[\r\n\t]/g, '_')
    .trim()
    .replace(TRAILING_DOTS_SPACES, '')
    .replace(/[_ ]+$/g, '');

  if (!segment) segment = fallback;
  if (WINDOWS_RESERVED_NAME.test(segment)) segment = `_${segment}`;
  return segment.slice(0, 80) || fallback;
}

function cacheDir(root, knowledgeBaseName) {
  return path.join(path.resolve(root), sanitizeSegment(knowledgeBaseName, 'knowledge-base'));
}

function legacyCacheDir(root, spaceId) {
  return path.join(path.resolve(root), String(spaceId));
}

/** 判断目标路径是否位于指定根目录内（根目录本身也算在内）。 */
function isPathInside(root, target) {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const relative = path.relative(rootAbs, targetAbs);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function toPosixPath(segments) {
  return segments.filter(Boolean).join('/');
}

module.exports = {
  sanitizeSegment,
  cacheDir,
  legacyCacheDir,
  isPathInside,
  toPosixPath,
};
