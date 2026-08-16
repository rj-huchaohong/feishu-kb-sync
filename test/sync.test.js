'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncSpace, buildNodePathInfo, downloadOnline } = require('../lib/sync.js');

function makeResponse(content) {
  return new Response(Buffer.from(content));
}

function makeClient() {
  const state = {
    mode: 'full',
    folderTitle: '01 说明',
    onlineContent: '第一版内容',
    onlineEditTime: '1',
    fileDownloads: 0,
    onlineDownloads: 0,
    docContentCalls: 0,
    docContent: '# Docs content document\n\n- Preserved Markdown structure\n',
    docContentError: null,
    lastDocContentRequest: null,
  };

  const folder = () => ({
    node_token: 'folder-token',
    title: state.folderTitle,
    obj_type: 'docx',
    obj_token: 'folder-obj',
    parent_node_token: null,
    has_child: true,
    obj_edit_time: '1',
  });
  const file = () => ({
    node_token: 'file-token',
    title: '设备说明.pptx',
    obj_type: 'file',
    obj_token: 'file-obj',
    parent_node_token: 'folder-token',
    has_child: false,
    obj_edit_time: '1',
  });
  const online = () => ({
    node_token: 'online-token',
    title: '在线文档',
    obj_type: 'docx',
    obj_token: 'online-obj',
    parent_node_token: 'folder-token',
    has_child: false,
    obj_edit_time: state.onlineEditTime,
  });

  return {
    state,
    async nodeList(_spaceId, parentToken) {
      if (state.mode === 'incomplete' && parentToken === 'folder-token') {
        throw new Error('模拟子树失败');
      }
      if (state.mode === 'deleted') return { items: [], has_more: false };
      if (!parentToken) return { items: [folder()], has_more: false };
      if (parentToken === 'folder-token') return { items: [file(), online()], has_more: false };
      return { items: [], has_more: false };
    },
    async mediaDownload() {
      state.fileDownloads++;
      return makeResponse('binary-file-content');
    },
    async docContent(token, type) {
      state.docContentCalls++;
      state.lastDocContentRequest = { token, type };
      if (state.docContentError) throw new Error(state.docContentError);
      return state.docContent;
    },
    async docRawContent() {
      state.onlineDownloads++;
      return state.onlineContent;
    },
  };
}

function quietLogger() {
  return { log() {}, warn() {}, error() {} };
}

test('buildNodePathInfo mirrors the remote parent directory for docs and text', () => {
  const nodes = {
    folder: { node_token: 'folder', title: '03交换机', parent: null, obj_type: 'docx', has_child: true },
    file: { node_token: 'file', title: '指导书.pptx', parent: 'folder', obj_type: 'file', has_child: false },
    doc: { node_token: 'doc', title: '在线指导', parent: 'folder', obj_type: 'docx', has_child: false },
  };
  const dir = path.join('C:', 'cache', '技术知识库');
  const info = buildNodePathInfo(nodes, dir);
  assert.equal(info.file.local_path, path.join(dir, 'docs', '03交换机', '指导书.pptx'));
  assert.equal(info.doc.text_path, path.join(dir, 'text', '03交换机', '在线指导.md'));
  assert.deepEqual(info.file.remote_path, ['03交换机', '指导书.pptx']);
});

test('syncSpace mirrors directories and moves cached files without re-downloading', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = makeClient();
  const logger = quietLogger();

  await syncSpace({ kbName: '技术知识库', spaceId: 'space-1', root, client, logger });
  const cache = path.join(root, '技术知识库');
  const oldFile = path.join(cache, 'docs', '01 说明', '设备说明.pptx');
  const oldText = path.join(cache, 'text', '01 说明', '在线文档.md');
  assert.equal(fs.existsSync(oldFile), true);
  assert.equal(fs.existsSync(oldText), true);
  assert.equal(fs.existsSync(path.join(cache, 'docs', 'file-token')), false);
  assert.equal(client.state.fileDownloads, 1);
  assert.equal(client.state.docContentCalls, 1);
  assert.equal(client.state.onlineDownloads, 0);

  client.state.folderTitle = '02 说明';
  await syncSpace({ kbName: '技术知识库', spaceId: 'space-1', root, client, logger });
  const newFile = path.join(cache, 'docs', '02 说明', '设备说明.pptx');
  const newText = path.join(cache, 'text', '02 说明', '在线文档.md');
  assert.equal(fs.existsSync(newFile), true);
  assert.equal(fs.existsSync(newText), true);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(oldText), false);
  assert.equal(client.state.fileDownloads, 1);
  assert.equal(client.state.docContentCalls, 1);
  assert.equal(client.state.onlineDownloads, 0);

  client.state.onlineEditTime = '2';
  client.state.onlineContent = 'raw fallback content';
  client.state.docContent = '# Second version\n';
  await syncSpace({ kbName: '\u6280\u672f\u77e5\u8bc6\u5e93', spaceId: 'space-1', root, client, logger });
  assert.equal(fs.readFileSync(newText, 'utf8'), '# Second version\n');
  assert.equal(client.state.fileDownloads, 1);
  assert.equal(client.state.docContentCalls, 2);
  assert.equal(client.state.onlineDownloads, 0);
});

test('downloadOnline uses the Docs Markdown content helper for docx and doc nodes', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = makeClient();

  for (const objType of ['docx', 'doc']) {
    const target = path.join(root, `${objType}.md`);
    const result = await downloadOnline({ obj_type: objType, obj_token: `${objType}-token` }, target, client);
    assert.equal(result.format, 'online-md');
    assert.equal(fs.readFileSync(target, 'utf8'), '# Docs content document\n\n- Preserved Markdown structure\n');
  }

  assert.equal(client.state.docContentCalls, 2);
  assert.equal(client.state.onlineDownloads, 0);
  assert.equal(client.state.lastDocContentRequest.type, 'doc');
});

test('downloadOnline falls back to raw_content when Markdown export fails', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-export-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'fallback.md');
  const client = makeClient();
  client.state.docContentError = 'simulated Docs Markdown content failure';
  client.state.onlineContent = 'raw fallback content';

  const result = await downloadOnline({ obj_type: 'docx', obj_token: 'doc-token' }, target, client);

  assert.equal(result.format, 'online-raw');
  assert.equal(fs.readFileSync(target, 'utf8'), 'raw fallback content');
  assert.equal(client.state.docContentCalls, 1);
  assert.equal(client.state.onlineDownloads, 1);
});

test('downloadOnline skips sheet and bitable nodes without downloading', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-online-skip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = makeClient();

  for (const objType of ['sheet', 'bitable']) {
    const target = path.join(root, `${objType}.md`);
    const result = await downloadOnline({ obj_type: objType, obj_token: `${objType}-token` }, target, client);
    assert.deepEqual(result, { skipped: true, format: `online-${objType}` });
    assert.equal(fs.existsSync(target), false);
  }

  assert.equal(client.state.docContentCalls, 0);
  assert.equal(client.state.onlineDownloads, 0);
});

test('incomplete traversal preserves existing cached files and complete deletion removes them', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = makeClient();
  const logger = quietLogger();
  await syncSpace({ kbName: '技术知识库', spaceId: 'space-1', root, client, logger });

  client.state.mode = 'incomplete';
  const partial = await syncSpace({ kbName: '技术知识库', spaceId: 'space-1', root, client, logger });
  assert.equal(partial.tree.complete, false);
  assert.equal(fs.existsSync(path.join(root, '技术知识库', 'docs', '01 说明', '设备说明.pptx')), true);
  assert.equal(fs.existsSync(path.join(root, '技术知识库', 'text', '01 说明', '在线文档.md')), true);

  client.state.mode = 'deleted';
  const deleted = await syncSpace({ kbName: '技术知识库', spaceId: 'space-1', root, client, logger });
  assert.equal(deleted.tree.complete, true);
  assert.equal(fs.existsSync(path.join(root, '技术知识库', 'docs', '01 说明', '设备说明.pptx')), false);
  assert.equal(fs.existsSync(path.join(root, '技术知识库', 'text', '01 说明', '在线文档.md')), false);
});

test('syncSpace upgrades a legacy space_id cache into the named directory layout', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spaceId = 'space-legacy';
  const legacyDir = path.join(root, spaceId);
  const oldFile = path.join(legacyDir, 'docs', '设备说明.pptx');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, 'legacy-content', 'utf8');
  fs.writeFileSync(path.join(legacyDir, 'manifest.json'), JSON.stringify({
    docs: {
      'file-token': {
        title: '设备说明.pptx',
        format: 'file',
        edit_time: '1',
        local_path: oldFile,
      },
    },
  }), 'utf8');

  const client = {
    async nodeList(_spaceId, parentToken) {
      if (!parentToken) {
        return { items: [{
          node_token: 'folder-token',
          title: '01 说明',
          obj_type: 'docx',
          obj_token: 'folder-obj',
          parent_node_token: null,
          has_child: true,
          obj_edit_time: '1',
        }], has_more: false };
      }
      return { items: [{
        node_token: 'file-token',
        title: '设备说明.pptx',
        obj_type: 'file',
        obj_token: 'file-obj',
        parent_node_token: 'folder-token',
        has_child: false,
        obj_edit_time: '1',
      }], has_more: false };
    },
    async mediaDownload() {
      throw new Error('legacy cache should move without downloading');
    },
  };

  await syncSpace({ kbName: '技术知识库', spaceId, root, client, logger: quietLogger() });
  const namedDir = path.join(root, '技术知识库');
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(fs.existsSync(path.join(namedDir, 'docs', '01 说明', '设备说明.pptx')), true);
});

test('buildNodePathInfo adds stable token suffixes for same-directory name collisions', () => {
  const nodes = {
    'token-one': { node_token: 'token-one', title: '指导?.pdf', parent: null, obj_type: 'file', has_child: false },
    'token-two': { node_token: 'token-two', title: '指导_.pdf', parent: null, obj_type: 'file', has_child: false },
  };
  const info = buildNodePathInfo(nodes, path.join('C:', 'cache', '库'));
  assert.notEqual(info['token-one'].local_path, info['token-two'].local_path);
  assert.match(path.basename(info['token-one'].local_path), /token-/);
  assert.match(path.basename(info['token-two'].local_path), /token-/);
});




test('syncSpace reports concrete failed documents and preserves the previous cache', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-sync-failure-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = makeClient();
  client.mediaDownload = async () => { throw new Error('simulated document download failure'); };

  await assert.rejects(
    syncSpace({ kbName: '?????', spaceId: 'space-failure', root, client, logger: quietLogger() }),
    (err) => {
      assert.equal(err.code, 'SYNC_PARTIAL_FAILURE');
      assert.equal(err.result.counts.failed, 1);
      assert.equal(err.result.summary.failed.count, 1);
      assert.match(err.result.summary.failed.items[0].title, /\.pptx$/);
      assert.equal(err.result.summary.failed.items[0].phase, 'download');
      assert.match(err.result.summary.failed.items[0].error, /simulated document download failure/);
      return true;
    },
  );
});
