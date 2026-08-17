# deepcode

`deepcode` 是一个 opencode 风格的 **DeepSeek Harness 全屏终端 UI**，按 harness 的 bundle 插件规范打包（镜像 `dsh-headless`）。输入 `deepcode` 即可在终端里与 harness 的 Agent 交互——流式对话、思考过程、工具调用卡片、审批与提问应答，不需要打开浏览器。

它复用 harness 的 `dsh` 启动器与 `dsh-base` 核心（Agent / Session / 全部工具 / 审批 / 模型 / preset），本仓库只提供终端 UI 这一层。

## 安装

需要 Node.js ≥ 20 与 npm。

```bash
cd /home/fongye/code/deepcode
npm install      # 安装 @deepseek-ai/dsh + ink + react
npm link         # 注册 `deepcode` 命令
```

之后任意目录直接运行：

```bash
deepcode
```

首次运行会自动写入 `$DSH_HOME/profiles/deepcode/` 的 profile 清单并把本 bundle 链接进解析路径，无需额外 `dsh plugin` 步骤。

## 用法

- 直接输入文字 + 回车发送；
- `Ctrl+C`：Agent 运行中 → 打断本轮；空闲 → 退出；
- `/quit` 或 `/exit` 退出。

## 结构（bundle 插件）

```text
cordis.patch.yml   bundle patch：插入 agent-presets + tui-runner 两行
lib/index.js       runner 插件（导出 { name, inject, apply }）
lib/controller.js  Agent 包装：创建/发送/打断 + 会话事件折叠成转录（流式）
lib/app.js         Ink UI：头部 / 消息列表 / 工具卡片 / 输入 / 审批与提问
lib/theme.js       opencode 风格配色
bin/deepcode.js    薄启动器：dsh --profile deepcode
```

`package.json` 通过 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明这是 bundle；`dsh --profile deepcode` 会组合 `@deepseek-ai/dsh-base` + 本 bundle。

## 无头冒烟测试

没有 TTY 时可用环境变量验证「bundle 解析 + Agent 创建 + preset 挂载 + 模型读取」整条链路：

```bash
DEEPCODE_SMOKE=1 deepcode
# deepcode: ready (deepseek-official/deepseek-v4-pro)
```

## 尚未实现 / 待办

- 模型切换 UI（`ctx.llm.listModels` + `agentDefaultModel.saveSelection`）
- 历史会话列表与恢复（`sessionQuery.listSessions` + `agents.resume`）
- 计划模式 / 目标 / 子代理等面板的可视化
- 交互式审批与提问的端到端验证（需真实 TTY）

API 契约参考见 [`docs/tui-api-reference.md`](docs/tui-api-reference.md)（依据 `@deepseek-ai/*` 0.1.0-rc.6 源码整理）。
