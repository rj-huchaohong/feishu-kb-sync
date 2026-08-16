'use strict';

/**
 * 文档事件订阅最小验证命令。
 *
 * Wiki 节点是目录层身份；文档事件订阅使用 Wiki 节点对应的底层 obj_token
 * 和 obj_type，不使用 Wiki node_token 作为 file_token。
 */

const config = require('./config.js');
const http = require('./feishu-http.js');

const USAGE = '用法: feishu-kb-sync events subscribe <知识库名称> <Wiki链接|node_token> [--json]';

const SUPPORTED_FILE_TYPES = new Set([
  'doc',
  'docx',
  'sheet',
  'bitable',
  'file',
  'slides',
  'mindnote',
]);

function extractNodeToken(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('请提供 Wiki 链接或 node_token');
  if (!/^https?:\/\//i.test(value)) return value;

  let url;
  try {
    url = new URL(value);
  } catch (err) {
    throw new Error(`Wiki 链接格式无效: ${err.message}`);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const wikiIndex = parts.indexOf('wiki');
  if (wikiIndex < 0 || !parts[wikiIndex + 1]) {
    throw new Error('链接中未找到 Wiki node_token');
  }
  if (parts[wikiIndex + 1] === 'space') {
    throw new Error('请提供具体 Wiki 节点链接，不要提供知识库空间链接');
  }
  return parts[wikiIndex + 1];
}

function fileTypeForNode(node) {
  const fileType = String(node?.obj_type || '').trim().toLowerCase();
  if (!fileType) throw new Error('Wiki 节点未返回底层 obj_type，无法订阅文档事件');
  if (!SUPPORTED_FILE_TYPES.has(fileType)) {
    throw new Error(`节点类型 ${node.obj_type} 暂不支持文档事件订阅`);
  }
  return fileType;
}

function parseFlags(args) {
  const flags = { json: false };
  for (const arg of args) {
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}\n${USAGE}`);
  }
  return flags;
}

async function subscribe([kbName, target, ...rest]) {
  if (!kbName || !target) throw new Error(USAGE);

  const flags = parseFlags(rest);
  const loaded = config.loadConfig();
  const spaceId = loaded.spaces?.[kbName];
  if (!spaceId) throw new Error(`知识库「${kbName}」未配置`);

  const nodeToken = extractNodeToken(target);
  let node;
  try {
    node = await http.nodeGet(nodeToken);
  } catch (err) {
    throw new Error(`解析 Wiki 节点失败（${nodeToken}）: ${err.message}`);
  }
  if (!node || typeof node !== 'object') {
    throw new Error(`解析 Wiki 节点失败（${nodeToken}）: 接口未返回节点信息`);
  }
  if (!node.space_id) {
    throw new Error(`Wiki 节点未返回 space_id: ${nodeToken}`);
  }
  if (String(node.space_id) !== String(spaceId)) {
    throw new Error(`目标节点不属于知识库「${kbName}」（目标 space_id=${node.space_id}，配置 space_id=${spaceId}）`);
  }

  const objToken = String(node.obj_token || '').trim();
  if (!objToken) throw new Error(`Wiki 节点没有底层 obj_token: ${nodeToken}`);
  const fileType = fileTypeForNode(node);

  let subscription;
  try {
    subscription = await http.api('POST', `/drive/v1/files/${encodeURIComponent(objToken)}/subscribe`, {
      query: { file_type: fileType },
      bucket: 'wiki',
    });
  } catch (err) {
    throw new Error(`提交文档事件订阅失败（${objToken}）: ${err.message}`);
  }

  const result = {
    ok: true,
    knowledge_base_name: kbName,
    space_id: String(spaceId),
    node_token: nodeToken,
    node_title: node.title,
    obj_token: objToken,
    file_type: fileType,
    subscription,
    callback_receiver_required: true,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`已提交文档事件订阅: ${node.title || nodeToken}`);
    console.log(`  知识库: ${kbName}`);
    console.log(`  Wiki node_token: ${nodeToken}`);
    console.log(`  底层 obj_token: ${objToken}`);
    console.log(`  file_type: ${fileType}`);
    console.log(`  接口结果: ${subscription?.msg || 'Success'}`);
    console.log('  事件接收: 需要应用已配置 webhook 或 WebSocket 接收端');
  }
  return result;
}

module.exports = {
  subscribe,
  extractNodeToken,
  fileTypeForNode,
  parseFlags,
  SUPPORTED_FILE_TYPES,
  USAGE,
};