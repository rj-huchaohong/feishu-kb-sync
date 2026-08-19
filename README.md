# feishu-kb-sync

飞书知识库到本地缓存的同步器。它负责知识库配置、认证、增量同步、同步状态和系统周期调度；知识库查询与专属 Skill 生命周期由上层 `feishu-kb-query` 负责。

## 功能

- 遍历飞书知识库目录并同步可读取文档
- 按知识库名称维护本地缓存目录
- 支持增量同步、移动、重命名、删除保护和失败恢复
- 支持前台同步、后台同步和查看同步状态
- 支持 Windows 用户级周期调度
- 支持从公开 GitHub Release 下载版本化运行包

## 环境要求

- Node.js 18 或更高版本
- 已完成飞书应用授权，或本机已有可复用的 `lark-cli` 登录态

## 安装

### 从 GitHub Release 安装

在仓库的 Releases 页面下载对应版本的 ZIP，解压后进入目录执行：

```bash
npm install -g .
feishu-kb-sync --help
```

公开 Release 资产地址遵循以下格式：

```text
https://github.com/rj-huchaohong/feishu-kb-sync/releases/download/v<version>/feishu-kb-sync-v<version>.zip
```

### 从源码运行

```bash
git clone https://github.com/rj-huchaohong/feishu-kb-sync.git
cd feishu-kb-sync
npm test
npm install -g .
```

项目没有运行时 npm 依赖，发布包不包含 `node_modules`。

## 认证

```bash
feishu-kb-sync auth login
feishu-kb-sync auth status
feishu-kb-sync auth logout
```

认证信息由同步器保存并自动刷新。首次登录或刷新令牌失效时重新执行 `auth login`。

## 配置知识库

先设置本地缓存根目录：

```bash
feishu-kb-sync config set-root <缓存根目录>
```

添加知识库：

```bash
feishu-kb-sync config add <本地名称> <知识库链接或 space_id>
```

查看或移除配置：

```bash
feishu-kb-sync config list
feishu-kb-sync config remove <本地名称>
```

同一个飞书知识库以 `space_id` 作为稳定身份。修改本地名称时，同步器会尝试迁移已有缓存目录；目标目录存在冲突时会停止并提示处理。

## 同步与状态

同步单个知识库：

```bash
feishu-kb-sync sync <本地名称>
```

同步全部知识库：

```bash
feishu-kb-sync sync --all
```

后台同步并返回机器可读结果：

```bash
feishu-kb-sync sync <本地名称> --background --json
```

查看同步状态：

```bash
feishu-kb-sync status <本地名称> --json
```

缓存目录通常包含：

```text
<缓存根目录>/<本地名称>/
├── tree.json
├── manifest.json
├── docs/
└── text/
```

`tree.json` 保存远端目录快照，`manifest.json` 保存文档同步状态，`text/` 用于查询侧的文本检索，`docs/` 保存可用的原始文件。

## 周期调度

Windows 下注册每天 10:00 的用户级同步任务：

```bash
feishu-kb-sync schedule install
```

指定时间、查看状态和卸载：

```bash
feishu-kb-sync schedule install --time 23:30
feishu-kb-sync schedule status --json
feishu-kb-sync schedule uninstall
```

调度任务同步所有已配置知识库。任务在用户权限下运行，不需要管理员权限；同步日志和运行状态保存在同步器应用目录中。

## 开发与测试

```bash
npm test
node bin/feishu-kb-sync.js --help
```

## 发布

Release 由 GitHub Actions 自动完成。修改 `package.json` 的版本后，推送同版本 Tag：

```bash
git push origin main
git tag -a v0.1.0 -m "feishu-kb-sync v0.1.0"
git push origin v0.1.0
```

Tag 去掉 `v` 后必须与 `package.json` 的 `version` 完全一致。Workflow 会运行测试，生成运行时 ZIP 和 SHA-256 校验文件，并创建 GitHub Release。

