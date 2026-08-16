'use strict';

/**
 * feishu-http：飞书 OpenAPI 直连层（HTTP 直连改造的核心）
 *
 * 职责：
 *   - 统一鉴权（Bearer user_access_token，请求前 ensureFreshAuth 自动刷新）
 *   - 按接口分组令牌桶限流（实测/文档限频：wiki 100/min、export 100/min、media 5 QPS、raw_content 5 QPS）
 *   - 指数退避重试（网络瞬时故障 / 限流 99991400 / 5xx）
 *   - 401 → 强制刷新 token 后重试一次
 *
 * API 映射（对应 lark-cli 命令 → 官方 OpenAPI）：
 *   wiki +node-list  → GET /open-apis/wiki/v2/spaces/{space_id}/nodes?page_size=50&page_token=&parent_node_token=
 *   wiki +node-get   → GET /open-apis/wiki/v2/spaces/get_node?token={node_token}
 *   drive +download  → GET /open-apis/drive/v1/medias/{file_token}/download
 *   drive +export    → POST /open-apis/drive/v1/export_tasks + GET /drive/v1/export_tasks/{ticket} 轮询 + GET /drive/v1/export_tasks/file/{file_token}/download
 *   docs content     -> GET /open-apis/docs/v1/content?doc_token=&doc_type=docx&content_type=markdown (online Markdown)
 *   docx raw_content -> GET /open-apis/docx/v1/documents/{document_id}/raw_content (plain-text fallback)
 */

const { ensureFreshAuth } = require('./auth.js');

const BASE = 'https://open.feishu.cn/open-apis';

// ---- 令牌桶限流器 ----
// 每个限频组一个桶。窗口滑动：维护 [tokens, lastRefill]。
class TokenBucket {
  constructor(ratePerSec, burst) {
    this.ratePerSec = ratePerSec;   // 每秒补充速率
    this.burst = burst;             // 桶容量（允许突发）
    this.tokens = burst;
    this.last = Date.now();
  }
  /** 尝试取 1 个 token；不足则等待所需时间 */
  async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 5000)));
    }
  }
}

// 限频组（对应开放平台文档/实测）
const buckets = {
  wiki:    new TokenBucket(100 / 60, 20),  // wiki v2 节点接口：100 次/分钟
  export:  new TokenBucket(100 / 60, 10),  // export_tasks：100 次/分钟
  media:   new TokenBucket(5, 5),          // 文件下载：5 QPS
  doc:     new TokenBucket(5, 5),          // raw_content / 文档读取：5 QPS
};

/** 一次带限流的 HTTP 请求（自动刷新 token + 线性重试，无递归） */
async function api(method, path, { bucket = 'wiki', body, query, binary = false } = {}) {
  let lastErr;
  // 线性重试：最多 3 次（403/网络错误/非 JSON），每次重新取 token + 限流
  for (let attempt = 0; attempt < 3; attempt++) {
    await buckets[bucket].take();
    let accessToken;
    try {
      const fresh = await ensureFreshAuth();
      accessToken = fresh.accessToken;
    } catch (err) {
      throw new Error(`认证失败: ${err.message}`);
    }

    const url = BASE + path + (query ? '?' + new URLSearchParams(query).toString() : '');
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };

    let resp;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      lastErr = err;
      await sleep(500 * (attempt + 1)); // 0.5s/1s/1.5s 退避
      continue;
    }

    // 401 → token 失效，强制刷新（下次循环 ensureFreshAuth 会用新 token）
    if (resp.status === 401) {
      await forceRefresh();
      lastErr = new Error('HTTP 401 未授权');
      await sleep(500 * (attempt + 1));
      continue;
    }

    // 二进制（文件下载）
    if (binary) {
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        lastErr = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      return resp;
    }

    const json = await resp.json().catch(() => null);
    if (!json) {
      lastErr = new Error(`响应非 JSON（HTTP ${resp.status}）`);
      await sleep(500 * (attempt + 1));
      continue;
    }

    // 飞书业务错误码：限流 / token 失效
    if (json.code === 99991400) { // 限流
      lastErr = new Error('限流 99991400');
      await sleep(3000);
      continue;
    }
    if (json.code === 99991661 || json.code === 99991663) { // token 无效/过期
      await forceRefresh();
      lastErr = new Error(`token 失效 ${json.code}`);
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (json.code !== 0) {
      throw new Error(`飞书 API ${path}: ${json.code} ${json.msg || ''}`);
    }
    return json;
  }
  throw new Error(`请求 ${path} 重试 3 次仍失败: ${lastErr?.message || '未知错误'}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 强制刷新 token（清空过期状态，下次 ensureFreshAuth 会 refresh） */
async function forceRefresh() {
  const fs = require('fs');
  const { AUTH_FILE } = require('./auth.js');
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (auth.expiresAt) auth.expiresAt = 0; // 标记过期
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
  } catch (_) {}
}

// ---- 业务 API（sync.js 用） ----

/** wiki 节点列表（分页）；返回 { items, has_more, page_token } */
async function nodeList(spaceId, parentNodeToken, pageToken) {
  const query = { page_size: 50 };
  if (parentNodeToken) query.parent_node_token = parentNodeToken;
  if (pageToken) query.page_token = pageToken;
  const json = await api('GET', `/wiki/v2/spaces/${spaceId}/nodes`, { query, bucket: 'wiki' });
  return json.data || { items: [], has_more: false };
}

/** wiki 节点信息（含 obj_edit_time / obj_token） */
async function nodeGet(nodeToken) {
  const json = await api('GET', `/wiki/v2/spaces/get_node`, { query: { token: nodeToken }, bucket: 'wiki' });
  return json.data.node;
}

/** 下载文件（PDF/Word 等二进制）→ 返回 Response（调用方 stream 到文件）
 * 注意：官方文档有 medias/{file_token}/download（文档内嵌资源用）和
 * files/{file_token}/download（云空间文件用）两个接口。lark-cli +download 实测用后者
 * （源码 shortcuts/drive/drive_download.go:192）。medias 版对 wiki 文件节点返回 403。
 * 下载前先查权限（permissions/{token}/members/auth，与 lark-cli 同）：auth_result=false
 * 时抛 FileNoPermissionError，调用方跳过该文件（文件本身无权限，非代码错误）。
 */
async function mediaDownload(fileToken) {
  // 权限预检（与 lark-cli CheckDriveFileExportPermission 一致）
  const perm = await api('GET', `/drive/v1/permissions/${fileToken}/members/auth`, {
    query: { type: 'file', action: 'export' }, bucket: 'media',
  });
  if (perm.data?.auth_result === false) {
    const err = new Error(`文件无下载权限（auth_result=false）`);
    err.code = 'FILE_NO_PERMISSION';
    throw err;
  }
  return api('GET', `/drive/v1/files/${fileToken}/download`, { bucket: 'media', binary: true });
}

/** 创建导出任务（docx → markdown 等）；返回 ticket */
async function exportCreate(fileToken, type, fileExtension) {
  const json = await api('POST', `/drive/v1/export_tasks`, {
    bucket: 'export',
    body: { file_extension: fileExtension, token: fileToken, type },
  });
  return json.data.ticket;
}

/** 查询导出任务结果；返回 { job_status, file_token, job_error_msg } */
async function exportResult(ticket) {
  const json = await api('GET', `/drive/v1/export_tasks/${ticket}`, { bucket: 'export' });
  return json.data.result || {};
}

/** 下载导出产物（文件二进制）→ Response */
async function exportDownload(fileToken) {
  return api('GET', `/drive/v1/export_tasks/file/${fileToken}/download`, { bucket: 'export', binary: true });
}

/** Online document Markdown content via Docs v1. */
async function docContent(documentId, documentType = 'docx') {
  const json = await api('GET', '/docs/v1/content', {
    query: {
      doc_token: documentId,
      doc_type: documentType === 'doc' ? 'docx' : documentType,
      content_type: 'markdown',
      lang: 'zh',
    },
    bucket: 'doc',
  });
  return json.data?.content;
}

/** Plain-text fallback via docx raw_content. */
async function docRawContent(documentId) {
  const json = await api('GET', `/docx/v1/documents/${documentId}/raw_content`, { bucket: 'doc' });
  return json.data.content;
}

/** 导出任务全流程：创建 → 轮询（最多 30s）→ 返回导出产物 file_token */
async function exportWait(token, type, fileExtension) {
  const ticket = await exportCreate(token, type, fileExtension);
  const deadline = Date.now() + 30000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await exportResult(ticket);
    if (r.job_status === 0) return r.file_token; // 成功
    if (r.job_status === 1) { // 处理中
      if (Date.now() > deadline) throw new Error('导出超时（30s）');
      continue;
    }
    throw new Error(`导出失败: ${r.job_error_msg || '未知错误'} (status=${r.job_status})`);
  }
}

module.exports = { api, nodeList, nodeGet, mediaDownload, exportCreate, exportResult, exportDownload, docContent, docRawContent, exportWait, BASE };
