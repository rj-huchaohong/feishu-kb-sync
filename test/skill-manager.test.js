'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manager = require('../lib/skill-manager.js');

function makeRoot(prefix = 'feishu-kb-skill-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('syncKnowledgeBaseSkill creates a query Skill from the user-provided abbreviation', () => {
  const root = makeRoot();
  try {
    const result = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: 'EDN方案',
      spaceId: 'space-edn-1',
      requestedSuffix: 'edn',
    });

    assert.equal(result.skillName, 'feishu-kb-edn');
    assert.equal(fs.existsSync(path.join(result.directory, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(result.directory, manager.MANAGED_MARKER)), true);

    const skill = fs.readFileSync(path.join(result.directory, 'SKILL.md'), 'utf8');
    const sentence = 'feishu-kb-query skill\u4e2d\u77e5\u8bc6\u5e93\u4f7f\u7528\u300cEDN\u65b9\u6848\u300d\u3002';
    const expected = `---\nname: feishu-kb-edn\ndescription: ${JSON.stringify(sentence)}\n---\n\n${sentence}\n`;
    assert.equal(skill, expected);
    assert.doesNotMatch(skill, /status|manifest|tree/);

    const marker = manager.readManagedMarker(result.directory);
    assert.equal(marker.managed_by, manager.MANAGED_BY);
    assert.equal(marker.space_id, 'space-edn-1');
    assert.equal(marker.skill_suffix, 'edn');
  } finally {
    cleanup(root);
  }
});

test('a new knowledge base requires a user-provided Skill suffix', () => {
  const root = makeRoot();
  try {
    assert.throws(
      () => manager.syncKnowledgeBaseSkill({
        skillsRoot: root,
        knowledgeBaseName: '网络自动化知识库',
        spaceId: 'space-chinese-1',
      }),
      (error) => error.code === 'SKILL_SUFFIX_REQUIRED',
    );

    const result = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: '网络自动化知识库',
      spaceId: 'space-chinese-1',
      requestedSuffix: 'network',
    });
    assert.equal(result.skillName, 'feishu-kb-network');
  } finally {
    cleanup(root);
  }
});

test('ASCII mode validates the user-provided suffix instead of deriving one', () => {
  const root = makeRoot();
  try {
    assert.throws(
      () => manager.syncKnowledgeBaseSkill({
        skillsRoot: root,
        knowledgeBaseName: '网络自动化知识库',
        spaceId: 'space-chinese-2',
        requestedSuffix: '网络',
      }),
      (error) => error.code === 'SKILL_SUFFIX_INVALID',
    );
  } finally {
    cleanup(root);
  }
});

test('syncKnowledgeBaseSkill updates the same managed Skill when the display name changes', () => {
  const root = makeRoot();
  try {
    const original = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: 'EDN方案',
      spaceId: 'space-edn-2',
      requestedSuffix: 'edn',
    });
    const updated = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: 'EDN方案新版',
      spaceId: 'space-edn-2',
      existingSuffix: original.suffix,
    });

    assert.equal(updated.skillName, original.skillName);
    assert.deepEqual(fs.readdirSync(root), ['feishu-kb-edn']);
    assert.match(fs.readFileSync(path.join(updated.directory, 'SKILL.md'), 'utf8'), /EDN方案新版/);
    assert.equal(manager.readManagedMarker(updated.directory).knowledge_base_name, 'EDN方案新版');
  } finally {
    cleanup(root);
  }
});

test('syncKnowledgeBaseSkill changes the generated directory when the user changes the suffix', () => {
  const root = makeRoot();
  try {
    const original = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: 'EDN方案',
      spaceId: 'space-edn-3',
      requestedSuffix: 'edn',
    });
    const updated = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: 'EDN方案',
      spaceId: 'space-edn-3',
      requestedSuffix: 'campus',
    });

    assert.equal(original.skillName, 'feishu-kb-edn');
    assert.equal(updated.skillName, 'feishu-kb-campus');
    assert.deepEqual(fs.readdirSync(root), ['feishu-kb-campus']);
  } finally {
    cleanup(root);
  }
});

test('removeKnowledgeBaseSkills deletes managed directories and preserves unrelated directories', () => {
  const root = makeRoot();
  try {
    const result = manager.syncKnowledgeBaseSkill({
      skillsRoot: root,
      knowledgeBaseName: 'EDN方案',
      spaceId: 'space-edn-4',
      requestedSuffix: 'edn',
    });
    const unrelated = path.join(root, 'my-own-skill');
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, 'SKILL.md'), 'user content', 'utf8');

    const removed = manager.removeKnowledgeBaseSkills({ skillsRoot: root, spaceId: 'space-edn-4' });

    assert.deepEqual(removed.removed, [result.directory]);
    assert.equal(fs.existsSync(result.directory), false);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    cleanup(root);
  }
});

test('syncKnowledgeBaseSkill protects an existing unmarked Skill directory', () => {
  const root = makeRoot();
  try {
    const directory = path.join(root, 'feishu-kb-edn');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), 'user content', 'utf8');

    assert.throws(
      () => manager.syncKnowledgeBaseSkill({
        skillsRoot: root,
        knowledgeBaseName: 'EDN方案',
        spaceId: 'space-edn-5',
        requestedSuffix: 'edn',
      }),
      /Skill 目录冲突/,
    );
    assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), 'user content');
  } finally {
    cleanup(root);
  }
});

