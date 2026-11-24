# 工作区 Agent 发现

把已有 Claude/Codex 角色指令复用为 DSH 子 agent。无需复制角色文件，也无需启动外部 CLI。

当前版本：`1.3.0`。主入口为消息开头的 `@` 搜索菜单，按工作区角色文件名与描述搜索并选择角色。选择后使用 `@local-agent:<encoded ID>` 稳定 token；默认创建标准模式 subagent，显式 `--main` 才交给当前 agent。保留 `/workspace-agents` 和 `/workspace-agent` 作为固定诊断及兼容入口。

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

在目标项目中打开标准模式会话，在消息开头输入 `@`，按角色文件名或描述搜索，从菜单选择后补全独立任务并发送。菜单选择只认领输入框，不立即执行；发送时才按所选完整角色 ID 调用。

也可以直接说「列出当前工作区的 agents」或「让 reviewer 检查这次改动」，让模型通过工具选择是否委派。插件在每个模型步骤前读取当前工作目录中的定义，向模型提供最多 40 条简短角色描述。

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

## 输入框 `@` 搜索与调用

插件启用并加载新版 Host 和 Client 代码后，在普通接收会话的消息开头输入 `@`，菜单显示 **local-agents** 工作区角色候选。可按文件名或描述模糊搜索；例如 `.claude/agents/review.md` 显示为 **review**，描述来自 YAML 的 `description`，不使用 `name` 替换文件名。选择 **review** 只认领输入框；填写完整任务并发送后，才直接创建所选角色的标准模式 subagent。

选择后使用带来源及完整 ID 的稳定 token：`@local-agent:<encoded ID>`，其中 `<encoded ID>` 是完整角色 ID 的 URI 编码（`encodeURIComponent`），例如：

```text
@local-agent:claude%3Areview 检查本次 git diff
@local-agent:claude%3Areview --main 由当前 agent 检查本次 git diff
@local-agent:claude%3Areview%20team 检查本次 git diff
```

手动输入完整稳定 token 也支持直接派发，草稿恢复保留同一个精确角色 ID。所有角色，包括 Claude/Codex 同名、嵌套目录重名、中文名和含空白 ID，都从菜单按完整 ID 选择，不提供短名调用入口。裸 `@review` **仅用于搜索候选，不自动认领或派发**；不会因存在同名角色就抢占文件、目录或会话的 `@` 引用。保留命名空间 token 格式错误或解码失败时明确报错。

角色调用候选仅出现在**消息开头**，正文中的 `@` 和已 claim 任务的任务正文都不提供调用候选，不能通过任务正文中的 mention 切换角色。仅在普通接收会话提供角色候选，不在远程子 agent 输入框混用主会话目录。角色目录或会话工作目录变动，在下一次菜单查询时重新读取；提交时 Host 再次扫描并验证精确 ID。角色删除后报未找到，不改派同名角色、不回退主 agent。

动态 `/` 角色分类、`/review` 等旧短名和旧 `/local-agent:…` 草稿恢复已移除，不注册 `/` 兼容 source。旧动态角色草稿需重新通过 `@` 菜单选择角色后提交。

### 固定 `/workspace-*` 命令

保留以下固定命令用于诊断和兼容：

- `/workspace-agents`：即时扫描当前会话的工作目录，显示 Claude/Codex 角色 ID、名称、用途、定义路径及加载诊断。无需先发送模型消息。
- `/workspace-agent <角色ID> <完整独立任务>`：直接创建指定角色的 DSH 标准模式 subagent，不由主 agent 判断是否委派。创建失败时报错，不自动回退到主 agent。
- `/workspace-agent --main <角色ID> <任务>`：用户显式要求当前 agent 执行。将角色指令和任务作为持久化 follow-up 提交给当前会话，不创建 subagent、不切换当前 preset，也不永久改变当前角色。

例如：

```text
/workspace-agents
/workspace-agent claude:reviewer 检查本次 git diff，重点检查逻辑错误和缺失测试，返回具体位置。
/workspace-agent --main claude:reviewer 由当前 agent 检查本次 git diff。
/workspace-agent "claude:review team" 检查本次 git diff。
/workspace-agent --main "codex:review team" 由当前 agent 检查本次 git diff。
```

固定命令中的角色 ID 若含空白（包括空格），必须写成 **JSON 双引号字符串**，例如 `"claude:review team"`；引号和反斜杠按 JSON 规则转义（`\"`、`\\`），解码后使用完整原始 ID，不截断、修剪或猜测目录中最长的匹配。无空白 ID 可继续不加引号，也可使用 JSON 双引号形式；单引号不是 JSON 引号。畸形、未闭合的 JSON 字符串或缺少任务时返回用法错误，不创建子 agent，也不提交当前 agent 任务。

路由只认命令中的显式 `--main` 选项，不分析任务正文中的自然语言来自动改路由。即使任务正文包含“主 agent”等字样，不带 `--main` 时仍创建 subagent。`--main` 会要求当前模型直接执行；这是任务指令，不是禁用该会话全部子 agent 工具的权限规则。当前 agent 正在执行其他任务时，follow-up 在后续独立回合处理，不打断当前回合。

菜单角色和固定命令复用同一 Host 扫描及委派逻辑。不带 `--main` 的调用创建 subagent，失败会保留输入，不自动交给主 agent。列表及诊断是界面结果，不自动进入模型对话。子会话不继承当前对话，需要提供完整独立任务。目前不支持在角色命令中携带附件；请在任务正文中提供文件路径和必要信息。

角色入口现在位于 `@` 搜索菜单，`/` 菜单不再显示动态角色；固定 `/workspace-*` 命令仍可用。更新插件后需确认 Host 和 Client 均已重新加载，建议重启 DSH 并新建会话；单独刷新网页不保证加载新版 Host。若无入口，请检查插件启用状态、代码版本、当前会话工作目录及激活错误。

真实 GUI 验收需在重新加载后检查键盘/鼠标选择、稳定 token 草稿恢复、文件/目录/会话引用共存，以及一次只读角色任务；本次入口迁移未声称已完成真实 GUI 验证。

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

运行目标：DSH `0.2.2-rc.5`。格式依赖为 `yaml` 和 `smol-toml`，Host RPC 使用 DSH 的 `@deepseek-ai/dsh-typert-protocol` peer 依赖。Client 是可直接加载的 JavaScript artifact，无安装脚本或构建步骤。测试覆盖格式、扫描边界、权限错误、子 agent 委派、`@` 搜索及稳定 token、引用共存、claim 生命周期，以及无 commands 服务依赖的真实 Cordis catalog 注册、调用者传递、取消和卸载。

本地图标为原创 SVG；详情采用本 README，无额外预览图。
