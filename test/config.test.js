'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cacheDir, migrateCacheDir, parseAddArgs } = require('../lib/config.js');

test('migrateCacheDir moves a configured cache when the same space receives a new name', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldDir = cacheDir(root, '旧名称');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'manifest.json'), JSON.stringify({ space_id: 'space-1', docs: {} }), 'utf8');

  const result = migrateCacheDir(root, '旧名称', '新名称', 'space-1');
  assert.equal(result.moved, true);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(cacheDir(root, '新名称')), true);
});

test('migrateCacheDir rejects a non-empty target directory to protect another cache', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'feishu-kb-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldDir = cacheDir(root, '旧名称');
  const newDir = cacheDir(root, '新名称');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'marker.txt'), 'existing', 'utf8');

  assert.throws(
    () => migrateCacheDir(root, '旧名称', '新名称', 'space-1'),
    /目标目录已有缓存/,
  );
  assert.equal(fs.existsSync(oldDir), true);
});

test('parseAddArgs accepts an optional dedicated Skill suffix', () => {
  assert.deepEqual(
    parseAddArgs(['EDN方案', '7263753032704196609', '--skill-suffix', 'edn']),
    { name: 'EDN方案', link: '7263753032704196609', skillSuffix: 'edn' },
  );
  assert.deepEqual(
    parseAddArgs(['EDN方案', '7263753032704196609']),
    { name: 'EDN方案', link: '7263753032704196609', skillSuffix: null },
  );
});

test('CLI requires the user-provided suffix when creating a new knowledge base', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-kb-config-home-'));
  const skillsRoot = path.join(home, 'skills');
  const bin = path.resolve(__dirname, '../bin/feishu-kb-sync.js');
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOMEDRIVE: '',
    HOMEPATH: '',
    FEISHU_KB_SKILLS_ROOT: skillsRoot,
  };
  const name = 'EDN??';
  const spaceId = '7263753032704196609';

  try {
    const missing = spawnSync(process.execPath, [bin, 'config', 'add', name, spaceId], {
      env,
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /--skill-suffix/);

    const created = spawnSync(process.execPath, [
      bin,
      'config',
      'add',
      name,
      spaceId,
      '--skill-suffix',
      'edn',
    ], { env, encoding: 'utf8' });
    assert.equal(created.status, 0, `${created.stdout}${created.stderr}`);
    assert.equal(fs.existsSync(path.join(skillsRoot, 'feishu-kb-edn', 'SKILL.md')), true);

    const removed = spawnSync(process.execPath, [bin, 'config', 'remove', name], {
      env,
      encoding: 'utf8',
    });
    assert.equal(removed.status, 0, `${removed.stdout}${removed.stderr}`);
    assert.equal(fs.existsSync(path.join(skillsRoot, 'feishu-kb-edn')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
