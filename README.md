# 工作区 Agent 发现

把已有 Claude/Codex 角色指令复用为 DSH 子 agent。无需复制角色文件，也无需启动外部 CLI。

## 使用

1. 安装本目录：DSH「插件」→「添加插件」→选择本地目录。
2. 在目标项目中打开标准模式会话，直接说「列出当前工作区的 agents」或「让 reviewer 检查这次改动」。插件在每个模型步骤前读取当前工作目录中的定义，向模型提供最多 40 条简短角色描述。
3. 模型用 `list_workspace_agents` 查看全部角色及诊断，用 `run_workspace_agent` 委派任务。完成后 DSH 自动通知；已有 `list_agents` / `send_message` 可查看和继续交流。

调用示例：

```json
{"id":"claude:reviewer","prompt":"检查 src 下最近改动，只报告可确认的问题，不修改文件。","description":"检查最近改动"}
```

`list_workspace_agents` 的可选 `id` 返回该角色完整指令。

## 发现范围

- 工作目录下 `.claude/agents/**/*.md`：YAML frontmatter 的 `name`、`description`，以及 Markdown 正文。
- `.codex/config.toml` 中注册的 `[agents.<role>]`：描述和 `config_file` 所指 TOML 的 `developer_instructions`。
- `.codex/agents` 下的 TOML 角色文件：兼容常见独立角色约定。注册角色优先，具体诊断由发现工具返回。

不扫描整个仓库、不读取用户主目录的全局配置，不向上查找父目录。切换工作目录后，下个模型步骤及工具调用读取新目录。配置文件只读。

## 执行与边界

- 使用 DSH `spawn` 后端，在 `standard` preset 的新会话中执行；角色指令和任务作为持久化初始消息传入。不是在 Claude Code/Codex 本体里运行角色。
- 保留 DSH 的标准模式工具、审批、沙箱和子 agent 深度限制。Claude 的 `tools`、`disallowedTools`、`permissionMode`、`model`、`hooks`，以及 Codex 的模型、沙箱等运行时字段，不转换成 DSH 配置。相关字段仅用于诊断。
- 子 agent 不继承当前对话，请提供独立、完整任务。角色指令没有高于 DSH 系统规则的权限。
- 每次扫描最多读取 200 个文件，每文件最大 256 KiB；扫描深度/目录数受限。拒绝符号链接和越出工作区/`.codex` 的配置引用。
- 单个文件解析失败不会阻止其他角色被发现。目录访问失败在工具调用中报错，不会静默视为空列表。
- 链接检查防止普通配置路径越界，但 DSH 文件系统 API 不提供无竞态的 no-follow 读取保证。若其他进程同时恶意替换路径，检查与读取之间仍存在竞态；此检查不能替代 DSH 沙箱。
- 插件在 Host 注册全局工具，因此标准模式和其他未屏蔽全局工具的模式都可用。不会覆盖用户已有标准模式配置。最小/自定义模式可能限制工具。

## 开发

```sh
pnpm install --ignore-scripts
pnpm test
```

运行目标：DSH `0.2.2-rc.5`。依赖仅为 `yaml` 和 `smol-toml`，无安装脚本或构建步骤。测试包括格式、扫描边界、权限错误、子 agent 委派、生命周期清理及文件系统适配。

本地图标为原创 SVG；详情采用本 README，无额外预览图。
