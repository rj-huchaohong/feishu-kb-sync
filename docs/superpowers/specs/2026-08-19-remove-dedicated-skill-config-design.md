# 移除知识库专属 Skill 配置能力

## 背景

`feishu-kb-sync` 当前同时包含知识库同步配置和知识库专属 Skill 的配置/生命周期逻辑。专属 Skill 实际由 `feishu-kb-query` 创建和维护，因此同步器继续保存 Skill 根目录、Skill 简称并在配置命令中展示这些信息，会造成职责重叠和路径配置误用。

## 目标

让 `feishu-kb-sync` 只负责知识库同步及其运行配置，不再提供任何知识库专属 Skill 的配置或生命周期能力。

## 范围

### 移除

- `config set-skills-root` 命令。
- `config add --skill-suffix <简称>` 参数。
- 配置模型中的 `skills_root` 和 `skill_suffixes` 字段。
- `config list` 中的 Skill 根目录、Skill 名称和 Skill 后续维护提示。
- `config remove` 中关于专属 Skill 的职责说明。
- 同步器内部的 `skill-manager` 模块及其专属测试。

### 保留

- `config set-root`：继续配置本地同步缓存根目录。
- `config add <名称> <链接|space_id>`：只保存知识库名称和 `space_id`。
- `config list`、`config remove` 的知识库配置能力。
- 同步器不再提供独立的本地发布打包命令；运行包由 GitHub Release Workflow 统一生成。
- 用户磁盘上已有的专属 Skill 文件：同步器不再读取、写入、迁移或删除这些文件。
- 已存在配置文件中的旧 `skills_root`、`skill_suffixes`：读取时忽略；下次由同步器保存配置时不再写回。

## 设计

### 配置边界

配置文件只保留同步器自身需要的三类信息：

- `root`：本地缓存根目录。
- `spaces`：本地知识库名称到飞书 `space_id` 的映射。
- 其他同步器已有的非 Skill 运行配置（如有）继续保持原行为。

知识库的 Skill 名称、Skill 文件位置和 Skill 内容不再进入同步器的数据流。同步器的配置命令只更新同步器配置，不再触碰外部 Skill 资产。

### 命令行为

- 用户调用已移除的 `config set-skills-root` 时，命令应按未知子命令处理并返回当前 `config` 用法。
- 用户继续传入 `config add --skill-suffix` 时，命令应按未知参数报错，避免静默接受已失效的配置意图。
- `config list` 只输出缓存根目录和知识库映射。
- `config remove` 只移除知识库映射，并说明本地缓存保留；不再提及 Skill。

### 模块关系

`config.js` 保留缓存路径和知识库映射相关职责，删除对 `skill-manager` 的依赖。由于没有其他生产模块需要同步器内的 Skill 管理能力，`skill-manager.js` 及其专属测试一并移除，避免形成不可达的旧入口。

### 兼容与数据安全

旧配置文件可以继续被读取。旧 Skill 字段被忽略，不主动删除或修改用户已有的 Skill 文件。只有在同步器保存该配置文件时，旧字段才会自然消失；这不会影响知识库缓存，也不会影响由其他工具维护的 Skill 目录。

## 测试策略

- CLI 帮助测试确认不再出现专属 Skill 配置入口。
- 配置参数测试确认 `config add` 不再接受 `--skill-suffix`。
- 配置集成测试确认新增和移除知识库只影响 `spaces`，不会创建、删除或访问 Skill 目录。
- 删除 `skill-manager` 专属测试。
- 运行完整测试套件，确保同步、调度、认证、事件和打包功能不受影响。

## 验收标准

1. 帮助信息中不存在 `set-skills-root`、`--skill-suffix` 和“专属 Skill 根目录”等同步器配置入口。
2. 已移除命令和参数都会明确失败，不会写入配置。
3. 配置文件不再生成或保存 `skills_root`、`skill_suffixes`。
4. 同步器不再依赖或调用 `skill-manager`。
5. 已有 Skill 文件不被删除或改写。
6. 全部自动化测试通过。
