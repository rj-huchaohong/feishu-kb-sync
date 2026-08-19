# `feishu-kb-sync` GitHub Release 自动化设计

- 日期：2026-08-19
- 状态：已实现（待远程 Tag 触发验证）
- 范围：公开 GitHub Release 的 Tag 触发、版本校验、运行时发布包构建和资产上传

## 1. 目标

将当前手工的 Release 流程自动化：维护者推送一个与 `package.json` 版本一致的 `v*` Tag 后，GitHub Actions 自动完成测试、生成运行时 ZIP、生成 SHA-256 校验文件、创建 GitHub Release 并上传发布资产。

发布资产供 `feishu-kb-query` 通过公开 HTTPS 地址下载。消费者不需要 GitHub 账号；创建 Release 仍需要仓库维护者具备仓库写权限。

## 2. 非目标

- 不发布 npm 包。
- 不改变 `feishu-kb-sync` 的 CLI 命令、配置文件或调度行为。
- 不让普通 `main` 分支提交自动创建 Release。
- 不把工作区的 `.git`、临时目录、`node_modules`、设计文档或其他开发资料放入运行时发布包。
- 不复用当前 `package-skill` 作为 Release 的唯一打包入口；该命令保留原有用途，Release Workflow 使用独立且明确的运行时文件白名单。

## 3. 触发与权限

Workflow 仅监听推送到仓库的 `v*` Tag，例如 `v0.1.0`。普通分支提交不触发发布。

Workflow 使用仓库内容写权限创建 Release 和上传资产。发布步骤使用当前 Tag 作为 Release 的唯一身份；同一 Tag 已存在 Release 时，Workflow 失败而不覆盖已有资产。

## 4. 版本契约

Tag 去掉前缀 `v` 后必须与 `package.json` 的 `version` 完全一致：

```text
Tag:            v0.1.0
package.json:   0.1.0
```

版本不一致时，Workflow 在打包和 Release 创建前失败。版本号由仓库维护者在 `package.json` 中维护，Tag 只是对该版本的发布声明，不反向修改源码版本。

## 5. 自动化流程

```text
push v*
    ↓
检出 Tag 对应源码
    ↓
读取并校验 package.json version
    ↓
安装 Node.js 运行环境并执行现有测试
    ↓
按运行时白名单生成 ZIP
    ↓
生成 ZIP 的 SHA-256 校验文件
    ↓
创建 GitHub Release 并上传 ZIP 与校验文件
```

### 5.1 环境与测试

Workflow 使用项目声明支持范围内的 Node.js 版本。打包前运行仓库现有测试命令；测试失败时不进入发布阶段。

项目当前为零运行时依赖，因此不要求通过 npm 发布依赖，也不需要将 `node_modules` 放入资产。若未来增加依赖，应先更新安装和测试流程，再决定是否将依赖作为发布包的一部分。

### 5.2 运行时发布包

ZIP 名称固定为：

```text
feishu-kb-sync-v<version>.zip
```

当前运行时白名单为：

```text
bin/
lib/
scripts/
diag-export.js
package.json
```

ZIP 内保持上述相对路径，使解压后的目录可以直接作为同步器安装源。`lib/extract.py` 会随 `lib/` 一起进入发布包。

### 5.3 完整性校验

为 ZIP 生成同名校验文件：

```text
feishu-kb-sync-v<version>.zip.sha256
```

校验文件记录 ZIP 的 SHA-256 摘要和资产文件名。后续 `feishu-kb-query` 下载工具时可以先校验摘要，再执行安装或替换。

### 5.4 Release 资产

Release 使用 Tag 作为版本标识，标题包含版本号，并自动生成变更说明。上传两个资产：

1. `feishu-kb-sync-v<version>.zip`
2. `feishu-kb-sync-v<version>.zip.sha256`

发布后的公开下载地址遵循 GitHub Release 资产 URL 规则：

```text
https://github.com/rj-huchaohong/feishu-kb-sync/releases/download/v<version>/feishu-kb-sync-v<version>.zip
```

## 6. 失败与安全行为

- Tag 格式不是 `v*`：不进入有效发布流程。
- Tag 与 `package.json` 版本不一致：立即失败，不生成 Release。
- 测试失败：不创建 Release。
- 运行时白名单中的文件缺失：打包失败，不上传不完整资产。
- Release 已存在：失败并保留已有 Release，不覆盖。
- ZIP 或校验文件生成失败：不创建或不完成 Release。
- 仓库为私有时，资产下载需要授权；要支持未登录下载，仓库及 Release 必须公开。

## 7. 与 `feishu-kb-query` 的对接

`feishu-kb-query` 不依赖 `main` 分支或源码目录，而是按版本下载公开 Release 资产。安装器应：

1. 选择明确版本或读取项目约定的版本入口；
2. 下载 ZIP 和 SHA-256 文件；
3. 校验通过后解压到同步器安装目录；
4. 注册或更新可被系统周期任务找到的 `feishu-kb-sync` 启动入口；
5. 失败时保留旧版本，避免破坏已有同步任务。

本设计只负责提供稳定的发布资产，不实现 `feishu-kb-query` 的安装器。

## 8. 计划变更与验收

计划新增一个 GitHub Actions Workflow 文件，不改变现有同步器生产逻辑。验收至少覆盖：

1. 推送符合版本的 Tag 能成功生成 Release。
2. Release 包只包含运行时白名单内容。
3. ZIP 内的 `bin/`、`lib/`、`scripts/` 和 `package.json` 相对路径保持不变。
4. 版本不一致时 Workflow 失败且不创建 Release。
5. 测试失败时 Workflow 失败且不创建 Release。
6. ZIP 的 SHA-256 校验文件能够验证 ZIP。
7. 已有 Release 不会被同名 Tag 的重复运行覆盖。
8. 公开仓库的 Release 资产可通过 HTTPS 直接下载。
