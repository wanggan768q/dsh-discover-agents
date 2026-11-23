# 工作区 Agent 发现

把已有 Claude/Codex 角色指令复用为 DSH 子 agent。无需复制角色文件，也无需启动外部 CLI。

当前版本：`1.2.0`。新增输入框 `/` 菜单的 `local-agents` 分类，逐个显示工作区角色的文件名与描述。指定角色默认创建标准模式 subagent；显式 `--main` 才交给当前 agent。保留 `/workspace-agents` 和 `/workspace-agent` 作为诊断及兼容入口。

## 安装到 DSH

仓库：[wanggan768q/dsh-discover-agents](https://github.com/wanggan768q/dsh-discover-agents)。本插件未发布到 npm，不要只输入 `dsh-discover-agents` 作为下载地址。

已验证运行目标为 DSH `0.2.2-rc.5`；清单允许 `>=0.2.2-rc.5 <0.3.0`，其他版本未逐一验证。需要 DSH 的受管 profile、插件管理器和标准模式的 `spawn` 子 agent 后端。安装会在当前 profile 中运行插件代码，影响使用该 profile 的所有会话；请只安装你信任的代码。

### 方式一：直接从 GitHub 安装

适合不需要修改插件源码的用户。

1. 打开 DSH 桌面端或 Web GUI，在侧栏点击 **插件**。
2. 点击 **添加插件**。若从旁边的箭头打开菜单，选择 **安装第三方插件**。
3. 在安装地址输入框粘贴以下完整 Git 地址，不是填写 npm 包名：

   ```text
   git+https://github.com/wanggan768q/dsh-discover-agents.git#main
   ```

4. 点击 **安装**，等待仓库下载、依赖安装和插件检查完成。DSH 会调用自己的包管理器，不需要手动修改 DSH profile 的配置文件。
5. 安装完成后点击 **立即启用**。若直接关闭了对话框，在 **已安装插件** 中找到 **工作区 Agent 发现**，打开其开关。详情中的包名应为 `dsh-discover-agents`。
6. 若 DSH 提示需要重启，重启 DSH 进程后再使用。更新已有插件代码后，也建议重启并新建会话验证；刷新浏览器不等于重启 Host。

`#main` 安装远程 `main` 分支当前版本，不包含维护者尚未提交并 push 的本地改动。需要可重复安装时，将 `main` 替换成 GitHub 提交页显示的完整 40 位 commit SHA。

也可以在具备 `plugin_manager` 工具的 DSH 标准模式中发送：

> 请通过 plugin_manager 安装并启用 git+https://github.com/wanggan768q/dsh-discover-agents.git#main。

按 DSH 提示批准安装。若包管理器另行要求运行安装脚本，先查看脚本和包名，再决定是否批准；插件自身没有安装或构建脚本。

### 方式二：从 GitHub 克隆后按本地目录安装

适合开发、查看源码，或直接 Git 安装失败后的排查。先在你希望长期保留插件的目录中打开终端：

```sh
git clone https://github.com/wanggan768q/dsh-discover-agents.git
cd dsh-discover-agents
pnpm install --frozen-lockfile --ignore-scripts
```

此方式的终端需要可用的 Git、Node.js 和 pnpm。依赖安装命令只在克隆出来的插件目录中运行，不要在 DSH profile 目录中运行。

随后打开 DSH **插件 → 添加插件**，在同一安装地址输入框填写克隆目录的**绝对路径**。例如 Windows：

```text
E:\Git\dsh-discover-agents
```

macOS / Linux 的示例路径为 `/home/your-name/plugins/dsh-discover-agents`，请替换成实际路径。输入应指向包含 `package.json` 和 `cordis.patch.yml` 的仓库根目录，而不是某个源文件或 `.claude` / `.codex` 目录。点击 **安装**，完成后点击 **立即启用**。

本地目录安装使用链接：**不要删除或移动克隆目录**。插件源码可以放在一个固定目录；需要发现角色的项目是另一个工作区，两者不必相同。

### 安装后验证

1. 在目标项目中新建 **标准模式**会话，确认会话工作目录是该项目。
2. 发送「调用 `list_workspace_agents`，列出当前工作区的角色」。
3. 项目已有支持格式的角色时，应返回 `claude:...` / `codex:...` ID、用途和诊断。项目没有角色时，返回空列表属于正常结果。
4. 选择一个 ID，发送「用 `run_workspace_agent` 调用这个角色，执行一个不修改文件的任务」。应立即返回子 agent 名称，完成后收到自动通知。

本插件复用角色指令，不需要安装 Claude Code 或 Codex CLI，也不需要它们的登录凭据。任务推理使用 DSH 配置的模型和权限；正常执行子任务所需的模型配置及额度仍由 DSH 提供。

### 更新与故障排查

- **GitHub 安装更新：**`#main` 不会自动跟随远程新提交。对这种分支安装，先在 DSH 插件页卸载本插件，再使用同一 Git 地址重新安装、启用并重启。不要把「刷新插件列表」当作拉取 Git 更新。卸载操作请确认包名为 `dsh-discover-agents`。
- **DSH 的更新发现限制：**提高插件的 `package.json.version` 或发布 Git 标签，不会让 `#main` / 标签安装自动出现更新入口。当前 DSH 仅允许完整 40 位 commit SHA 固定的 Git 安装走 Git 更新流程，新版本信息需要插件市场索引提供；Git 仓库本身不提供 DSH 可读取的版本列表。本仓库未发布到 npm，也未接入插件市场索引，因此目前仍需按上一条手动重新安装。版本标签 `v1.1.0` 用于明确发布版本，不等于 DSH 自动更新源。
- **本地目录安装更新：**在插件克隆目录执行 `git pull --ff-only` 和 `pnpm install --frozen-lockfile --ignore-scripts`，然后重启 DSH。若有自己的未提交改动，先保存并处理冲突，不要直接覆盖。
- **无法访问 GitHub：**查看 **安装详情** 中的 Git / pnpm 报错，检查 DSH 所在机器的 GitHub 网络、代理和 Git 配置。npm 镜像只能帮助下载注册表依赖，不能代替 GitHub 仓库下载。也可从 GitHub **Code → Download ZIP** 下载解压，安装依赖后按方式二填写解压目录的绝对路径。
- **版本不兼容：**按 DSH 的诊断选择匹配版本，不要为了安装直接跳过兼容性检查。
- **已安装但未运行：**确认插件开关已启用，查看组件运行状态及错误信息，按提示重启；仅显示在列表中不代表激活成功。
- **没有发现角色：**确认当前会话目录、角色路径和格式，读取 `list_workspace_agents` 返回的诊断。插件不向上查找父目录，也不扫描用户主目录的全局定义。

## 使用

在目标项目中打开标准模式会话，直接说「列出当前工作区的 agents」或「让 reviewer 检查这次改动」。插件在每个模型步骤前读取当前工作目录中的定义，向模型提供最多 40 条简短角色描述。

模型用 `list_workspace_agents` 查看全部角色及诊断，用 `run_workspace_agent` 委派任务。完成后 DSH 自动通知；已有 `list_agents` / `send_message` 可查看和继续交流。

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

## 输入框 `/` 命令

插件启用并加载新版 Host 和 Client 代码后，在 DSH 输入框输入 `/`，菜单新增 **local-agents** 分类。每个角色直接显示文件名（不含扩展名）及对应描述。例如 `.claude/agents/review.md` 显示为 **review**，描述来自 YAML 的 `description`，不使用 `name` 替换文件名。

选择 **review** 后输入完整任务并发送，插件直接创建该角色的标准模式 subagent。选择菜单项只认领输入框，不立即执行。也可以直接输入：

```text
/review 检查本次 git diff
/review --main 由当前 agent 检查本次 git diff
```

菜单显示文件名，选择后输入框使用带来源的唯一 token，例如 `/local-agent:claude%3Areview`，以便保存草稿后仍准确恢复同一角色。无冲突且名称符合命令格式时，可以直接输入 `/review`；同名角色（包括 Claude/Codex 或嵌套目录重名）或与 DSH 命令重名时，没有短名入口，请从菜单选择。角色目录变动及会话工作目录变动，在下一次菜单查询时重新读取；提交时 Host 再次验证角色。仅在接收普通会话的输入框提供分类，不在远程子 agent 输入框混用主会话目录。

保留以下固定命令用于诊断和兼容：

- `/workspace-agents`：即时扫描当前会话的工作目录，显示 Claude/Codex 角色 ID、名称、用途、定义路径及加载诊断。无需先发送模型消息。
- `/workspace-agent <角色ID> <完整独立任务>`：直接创建指定角色的 DSH 标准模式 subagent，不由主 agent 判断是否委派。创建失败时报错，不自动回退到主 agent。
- `/workspace-agent --main <角色ID> <任务>`：用户显式要求当前 agent 执行。将角色指令和任务作为持久化 follow-up 提交给当前会话，不创建 subagent、不切换当前 preset，也不永久改变当前角色。

例如：

```text
/workspace-agents
/workspace-agent claude:reviewer 检查本次 git diff，重点检查逻辑错误和缺失测试，返回具体位置。
/workspace-agent --main claude:reviewer 由当前 agent 检查本次 git diff。
```

路由只认命令中的显式 `--main` 选项，不分析任务正文中的自然语言来自动改路由。即使任务正文包含“主 agent”等字样，不带 `--main` 时仍创建 subagent。`--main` 会要求当前模型直接执行；这是任务指令，不是禁用该会话全部子 agent 工具的权限规则。当前 agent 正在执行其他任务时，follow-up 在后续独立回合处理，不打断当前回合。

菜单角色和固定命令复用同一 Host 扫描及委派逻辑。不带 `--main` 的调用创建 subagent，失败会保留输入，不自动交给主 agent。列表及诊断是界面结果，不自动进入模型对话。子会话不继承当前对话，需要提供完整独立任务。目前不支持在角色命令中携带附件；请在任务正文中提供文件路径和必要信息。

旧版插件只有模型工具，没有 slash 命令；因此旧版在 `/` 菜单中看不到 agent 入口并不代表发现失败。更新插件后需重启 DSH 加载新版 Host 代码，单独刷新网页不保证重新加载插件。若仍无入口，请检查插件是否启用、是否更新到包含本节功能的版本、是否存在激活错误。

## 执行与边界

- 使用 DSH `spawn` 后端，在 `standard` preset 的新会话中执行；角色指令和任务作为持久化初始消息传入。不是在 Claude Code/Codex 本体里运行角色。
- 保留 DSH 的标准模式工具、审批、沙箱和子 agent 深度限制。Claude 的 `tools`、`disallowedTools`、`permissionMode`、`model`、`hooks`，以及 Codex 的模型、沙箱等运行时字段，不转换成 DSH 配置。相关字段仅用于诊断。
- 子 agent 不继承当前对话，请提供独立、完整任务。角色指令没有高于 DSH 系统规则的权限。
- 每次扫描最多读取 200 个文件，每文件最大 256 KiB；目录项检查共用 10000 条预算，逐项 `lstat` 顺序执行，预算耗尽后不再访问后续目录。DSH `listDir` 没有分页或数量限制，因此首次列出一个大型目录时，底层枚举及其元数据开销仍由文件系统提供方承担。扫描深度/目录数也受限。拒绝符号链接和越出工作区/`.codex` 的配置引用。
- 缺失或非目录的 `.claude` / `.codex` 视为该来源不可用，继续发现另一来源。单个文件解析失败不会阻止其他角色被发现。权限等目录访问错误仍在工具调用中报错，不会静默视为空列表。
- 链接检查防止普通配置路径越界，但 DSH 文件系统 API 不提供无竞态的 no-follow 读取保证。若其他进程同时恶意替换路径，检查与读取之间仍存在竞态；此检查不能替代 DSH 沙箱。
- 插件在 Host 注册全局工具，因此标准模式和其他未屏蔽全局工具的模式都可用。不会覆盖用户已有标准模式配置。最小/自定义模式可能限制工具。

## 开发

```sh
pnpm install --ignore-scripts
pnpm test
```

运行目标：DSH `0.2.2-rc.5`。格式依赖为 `yaml` 和 `smol-toml`，Host RPC 使用 DSH 的 `@deepseek-ai/dsh-typert-protocol` peer 依赖。Client 是可直接加载的 JavaScript artifact，无安装脚本或构建步骤。测试覆盖格式、扫描边界、权限错误、子 agent 委派、动态菜单、名称冲突、claim 生命周期及真实 Cordis 服务注册。

本地图标为原创 SVG；详情采用本 README，无额外预览图。
