# DeepSeek Harness 进程内驱动 API 参考（TUI 客户端）

> 依据 `node_modules/@deepseek-ai/` 下各包 **0.1.0-rc.6** 的已发布产物（`lib/*.js` 运行时实现 + `lib/types/*.d.ts` 类型契约）整理。
> 每条结论都给出 `文件:行号` 出处；查不到的内容明确标注「未找到」。
> 包路径缩写：`dsh-agent` = `@deepseek-ai/dsh-agent`，其余同理。

## 最小可行启动序列（TUI MVP）

1. **boot 核心**：`const ctx = await boot("dsh-tui", configPath, patches, prepare, baseUrl)`（`dsh-app-boot/lib/index.js:1166`），或手工 `new Context()` + `ctx.plugin(Loader)` + `mountRootInclude(...)`（`dsh-app-boot/lib/index.js:1167-1176`）；`await ctx.get("loader")?.await()` 等待树就绪（`dsh-headless/lib/index.js:64`）。
2. **拿 services**：`ctx.get("agents")` / `ctx.agentDefaultModel` / `ctx.sessions` / `ctx.llm` / `ctx.sessionQuery`（`dsh-headless/lib/index.js:65-68`）；读默认模型 `defaultModel.currentSelection()`（`dsh-headless/lib/index.js:69`）。
3. **创建 Agent**：`const { agent } = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model }, setup })`（`dsh-headless/lib/index.js:70-83`；`dsh-agent/lib/index.js:543`）。
4. **订阅事件**：`agent.ctx.on("session/event", (session, event) => …)`（或根 `ctx.on(...)`）+ `agent.ctx.on("agent/status", …)`（见第 2 节）。
5. **followup**：`agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }))`（`dsh-headless/lib/index.js:86-92`），随后 `await agent.whenIdle()`。
6. **渲染**：消费 `session/event` 中的 `assistant/chunk` / `assistant/message` / `tool/call` / `tool/result`（见第 3 节）；需要落盘时 `await ctx.sessions.flush(agent.session)`（`dsh-headless/lib/index.js:94`）。
7. **应答审批**：根 `ctx.on("approval/request", (req, next) => …)` 返回 `'allowed-once' | 'rejected'`；`ctx.userQuestions.registerProvider({ ask })` 返回 `{ answers }`（见第 4 节）。
8. **退出**：`await handle.dispose()`（`AgentHandle.dispose`，`dsh-agent/lib/types/index.d.ts:155-158`），或 `ctx.fiber.dispose()`（`dsh-app-boot/lib/index.js:1181`）。

---

## 1. Agent 公开 API

### 1.1 `ctx.agents`（AgentRegistry 服务）

定义：`dsh-agent/lib/index.js:415`（`AgentRegistry extends Service`），d.ts：`dsh-agent/lib/types/index.d.ts:209`。

| 方法 | 签名 | 出处 |
|---|---|---|
| `create` | `create(options: CreateAgentOptions): Promise<AgentHandle>` | `dsh-agent/lib/index.js:543`；d.ts `:288` |
| `resume` | `resume(options: ResumeAgentOptions): Promise<AgentHandle>` | `dsh-agent/lib/index.js:556`；d.ts `:296` |
| `get` | `get(id: SessionId): Agent \| undefined` | `dsh-agent/lib/index.js:688` |
| `list` | `list(): Agent[]`（注册序） | `dsh-agent/lib/index.js:706` |
| `roots` | `roots(): Agent[]`（无运行时 owner 的顶层 agent） | `dsh-agent/lib/index.js:715` |
| `isOwnedBy` | `isOwnedBy(id, owner): boolean` | `dsh-agent/lib/index.js:699` |
| `currentInitiator` | `currentInitiator(): Agent \| undefined`（AsyncLocalStorage 因果链） | `dsh-agent/lib/index.js:460` |
| `withInitiator` | `withInitiator(agent, operation): T` | `dsh-agent/lib/index.js:490` |
| `register` / `enter` / `announce` | 高级生命周期原语（工厂内部用） | `dsh-agent/lib/index.js:580,601,660` |

### 1.2 `CreateAgentOptions` 完整入参形状

来源：`dsh-agent/lib/types/index.d.ts:65-118`（工厂消费点 `dsh-agent-loop/lib/index.js:1217-1225`）。

```ts
interface CreateAgentOptions {
  sessionId: SessionId;            // 必需；agent 注册表与 session 日志共享的同一身份
  meta?: {                         // 会话创建元数据 → SessionHeader
    cwd?: string;                  // 绝对路径
    parentSession?: SessionId;
    seedLength?: number;
    origin?: 'subagent';
    delegationDepth?: number;
    agentPreset?: string;          // 见第 7 节
  };
  seed?: readonly SessionEvent[];  // 可选 fork/回放历史，必须从 seq 0 连续
  agentOptions?: AgentOptions;     // { provider?, model?, maxTokens? }
  signal?: AbortSignal;            // 仅创建期取消
  setup?: AgentSetup;              // (agentCtx) => AgentSetupCommit | Promise<...> | void
}
interface AgentHandle { agent: Agent; dispose(): Promise<void>; }
interface AgentOptions { provider?: string; model?: string; maxTokens?: number; }
```

- `AgentOptions`：`dsh-agent/lib/types/runtime-types.d.ts:21-28`。
- `AgentSetup` / `AgentSetupCommit`：`dsh-agent/lib/types/index.d.ts:45-57`；setup 在 session/agent 发布 **之前** 执行（`dsh-agent-loop/lib/index.js:1227-1249`），返回的 handle 在 `dsh-agent-loop/lib/index.js:1154-1171` 组装：`publish()` 返回 `{ agent, dispose }`。
- 工厂层的同步便捷入口 `agentLoop.create(id, options?, meta?)`（返回裸 `Agent`）：`dsh-agent-loop/lib/index.js:1189`，d.ts `:134`。

### 1.3 `ResumeAgentOptions`

`dsh-agent/lib/types/index.d.ts:123-140`：

```ts
interface ResumeAgentOptions {
  resumeSessionId: SessionId;   // 持久化会话 id
  agentOptions?: AgentOptions;
  signal?: AbortSignal;
  setup?: AgentSetup;
}
```

`resume` 要求 `sessionPersistence` 已挂载，否则抛错（`dsh-agent-loop/lib/index.js:1257-1259`）。

### 1.4 Agent 实例（ReactLoopAgent）的公开方法与属性

实现：`dsh-agent-loop/lib/index.js:335-740`（类 `ReactLoopAgent`），d.ts：`dsh-agent-loop/lib/types/agent.d.ts:12-60`；接口契约：`dsh-agent/lib/types/runtime-types.d.ts:60-133`。

| 成员 | 签名 | 出处（实现） |
|---|---|---|
| `id` | `readonly id: SessionId` | `:337` |
| `options` | `readonly options: AgentOptions` | `:338` |
| `session` | `readonly session: Session` | `:339` |
| `inbox` | `readonly inbox: Inbox`（next-turn / next-step 待处理队列投影） | `:340`；Inbox 类 `dsh-agent/lib/index.js:12-171` |
| `status` | `get status(): 'idle' \| 'running'` | `:380-382`；类型 `dsh-agent/lib/types/runtime-types.d.ts:45` |
| `ctx` | `readonly ctx: Context`（agent 作用域上下文，`ctx.agent` 即本 agent） | `:377`（`this.ctx = this.scope.ctx.extend({ agent: this })`） |
| `send` | `send(message: UserMessage, target: 'next-turn'\|'next-step', wakeup: boolean): void` | `:390-395` |
| `followup` | `followup(input: UserMessage): void` — 入队下一轮并唤醒（等价 `send(input, 'next-turn', true)`） | `:396-398` |
| `steer` | `steer(input: UserMessage): void` — 提交到最近 step 边界并唤醒（`send(input,'next-step',true)`） | `:399-401` |
| `inject` | `inject(input: UserMessage): void` — 注入模型上下文，不唤醒（`send(input,'next-step',false)`） | `:402-404` |
| `cancel` | `cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void` | `:405-411`；`AgentCancelCause` = `{kind:'user'}\|{kind:'parent'}\|{kind:'hook',reason}\|{kind:'disposed'}`（`dsh-session/lib/types/types.d.ts:118-127`） |
| `runMaintenance` | `runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>` | `:412-435` |
| `whenIdle` | `whenIdle(): Promise<void>` — 等待整个 agent 活动（driver/维护任务）静默 | `:460-465` |
| `dispatch` | （私有）融合分发器 `agentEvents(loopCtx, this)` — 外部应通过 `agent.ctx.on(...)` 订阅，不直接用它 | `:356` |

- **`followup(message)` 的入参构造**：`UserMessage` 用 `createUserMessage` 生成，唯一受支持的用户消息来源是 `source: { kind: 'user' }`：
  ```js
  import { createUserMessage } from "@deepseek-ai/dsh-llm";
  agent.followup(createUserMessage({
    content: [{ type: "text", text: "你的问题" }],
    source: { kind: "user" },
  }));
  ```
  出处：`dsh-headless/lib/index.js:86-92`（官方最小驱动示例）；签名 `createUserMessage(input): UserMessage`（`dsh-llm/lib/types/message.d.ts:171-174`）。

### 1.5 `installModelSelection` 的导入与用法

- **导入**：`import { installModelSelection } from "@deepseek-ai/dsh-agent"`（`dsh-headless/lib/index.js:3`；`dsh-agent/lib/index.js:794` 导出）。
- **签名**：`installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void`（`dsh-agent/lib/types/model-selection.d.ts:35`）。
- **`ModelSelectionRef`**：`{ current: ModelSelection | undefined; assembled: ModelSelection | undefined }`，其中 `ModelSelection = { provider: string; model: string; reasoningEffort?: ReasoningEffortId }`（`dsh-agent/lib/types/model-selection.d.ts:8-22`）。
- **用法**：在 `agents.create` 的 `setup(agentCtx)` 里调用；它注册两个作用域监听器——`system-prompt/assemble`（把 selection 注入提示词变量 `provider`/`model`）和 `agent/request`（把 provider/model/effort 覆盖进请求配置），返回的 disposer 随 agent 作用域回收。官方示例：
  ```js
  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId, meta: { cwd }, 
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: void 0 }); },
  });
  ```
  出处：`dsh-headless/lib/index.js:69-83`；实现：`dsh-agent/lib/index.js:272-303`（dispose 闭包 `:299-302`）。

---

## 2. Session 实时事件订阅

### 2.1 机制：`session/event` 分发（不是轮询 `events`）

- `Session` 是纯类，**没有** `subscribe`/`on` 实例方法（`dsh-session/lib/index.js:1303-1564` 全文无此类成员；「未找到」实例级订阅 API）。
- 实时事件通过 Cordis 事件系统分发：`Session.append(type, data, opts?)`（`dsh-session/lib/index.js:1440`）在日志提交后，以 **`session/event`** 事件名、参数 **`(session, event)`** 同步通知观察者（`dsh-session/lib/index.js:1462-1472`；类型声明 `dsh-session/lib/types/index.d.ts:66`）。
- 分发的 carrier 在 `SessionStore.enter` 时捕获：`scopeTarget(session, scopeOf(this.ctx))`（`dsh-session/lib/index.js:1691`）。经 agent 作用域 `agent.ctx.sessions` 进入的 session，其 carrier key 即该 agent 的 scope key，因此：
  - **根上下文订阅**（推荐、最简单）：`ctx.on("session/event", (session, event) => { ... })` 收到**所有** session 的事件，用 `session.id === agent.session.id` 过滤（官方做法，`dsh-agent-loop/lib/index.js:48-49` 的 `RuntimeContextProjection` 即 `ctx.on("session/event", (subject, event) => { if (subject !== session) return; ... })`）。
  - **agent 作用域订阅**：`agent.ctx.on("session/event", (session, event) => ...)` 只收到该 agent 的 session 事件，且随 agent 释放自动卸载（scope 过滤语义：`dsh-scope/lib/index.js:327-349`，无标签上下文全局放行、带标签上下文按 carrier key 及其祖先链匹配）。
- 事件对象形状：`{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`（`dsh-session/lib/types/types.d.ts:420-452`）。

### 2.2 要订阅的事件清单与代码路径

| 事件 | 订阅位置 | 参数 | 出处 |
|---|---|---|---|
| `session/event`（**全部会话事件**，包括 `assistant/chunk`、`tool/call`、`tool/result`、`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`session/title`、`plan/mode`、`todo/write`、`goal/change`、`approval/asked`、`approval/decided`、`agent-preset/selected` 等） | `ctx.on("session/event", (session, event) => …)` 或 `agent.ctx.on(...)` | `(session, event)` | `dsh-session/lib/index.js:1465-1472` |
| `agent/status` | `ctx.on("agent/status", (payload) => …)` 或 `agent.ctx.on(...)` | `payload = { agent, status }` | `dsh-agent/lib/types/runtime-types.d.ts:169-172`；发射点 `dsh-agent-loop/lib/index.js:388` |
| `agent/error` | 同上 | `{ agent, turn, step, error }` | `dsh-agent/lib/types/runtime-types.d.ts:316-321`；`dsh-agent-loop/lib/index.js:470-474` |
| `agent/session-start` | 同上 | `{ agent, source: 'startup'\|'resume'\|'clear'\|'compact' }` | `dsh-agent/lib/types/runtime-types.d.ts:220-223`；`dsh-agent-loop/lib/index.js:1165` |
| `agent/inbox/inserted` / `claimed` / `discarded` | 同上 | `{ agent, message, turn? }` | `dsh-agent/lib/types/runtime-types.d.ts:180-209`；`dsh-agent-loop/lib/index.js:358-369` |
| `agent/created` / `agent/disposed` | `ctx.on(...)` | `{ agent }` | `dsh-agent/lib/types/runtime-types.d.ts:146-159` |
| `agent/request` / `agent/pre-step` / `agent/turn-stopping` / `agent/request-error` | **waterfall/serial** 拦截点（`ctx.waterfall`/`ctx.serial` 语义，非纯监听） | 见 `dsh-agent/lib/types/runtime-types.d.ts:235-305` | `dsh-agent-loop/lib/index.js:501,565,685,630` |

> agent 事件（`agent/status` 等）的发射：`agentEvents(ctx, agent).emit(name, payload)`，payload 自动注入 `agent` 字段（`dsh-agent/lib/index.js:335-366`）。订阅用 `ctx.on(name, (payload) => …)` 即可，事件参数即 payload 本身。

---

## 3. 事件 data 形状

`SessionEventMap` 权威定义：`dsh-session/lib/types/types.d.ts:223-354`；事件枚举全集：`KNOWN_SESSION_EVENT_TYPES`（`dsh-session/lib/index.js:1054-1099`）。

### 3.1 流式与消息类

**`assistant/chunk`**（`{ turn, step, chunk: StreamChunk }`，`dsh-session/lib/types/types.d.ts:264-268`；追加点 `dsh-agent-loop/lib/index.js:620-624`）
`StreamChunk`（`dsh-llm/lib/types/types.d.ts:267-297`）为判别联合：
```ts
{ type: 'block-start'; index: number; blockType: string }
| { type: 'text-delta';       index: number; text: string }        // 可见文本增量
| { type: 'reasoning-delta';  index: number; text: string }        // 思考增量
| { type: 'tool-call-delta';  index: number; id: CallId; name?: string; argumentsDelta: string }
| { type: 'block-end';        index: number; block: ContentBlock }
| { type: 'usage';            usage: TokenUsage }
| { type: 'finish';           reason: FinishReason; replayState?: unknown }
```
`TokenUsage = { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`（`dsh-llm/lib/types/types.d.ts:123-129`）。**注意**：`block-start`/`block-end`/`usage`/`finish` 也是 chunk 事件（逐 token 回放保真，`dsh-session/lib/index.js:730-745` 注释）。

**`assistant/message`**（`{ turn, step, message: AssistantMessage, usage?: TokenUsage }`，`dsh-session/lib/types/types.d.ts:275-280`；追加点 `dsh-agent-loop/lib/index.js:650-658`，携带 `surfaceOp:'append'` 与 `sourceEventSeqs`）
`AssistantMessage = { id, role:'assistant', content: ContentBlock[], source: { kind:'model', provider, model, replayState? } }`（`dsh-llm/lib/types/message.d.ts:135-138, 5-20`）。
`ContentBlock`（`dsh-llm/lib/types/types.d.ts:79-89`）：
```ts
TextBlock      = { type: 'text';      text: string }
ReasoningBlock = { type: 'reasoning'; text: string }
ImageBlock     = { type: 'image';     attachment: ImageAttachmentRef }
ToolCallBlock  = { type: 'tool-call'; id: CallId; name: string; arguments: string /* 原始 JSON 字符串 */ }
ToolResultBlock= { type: 'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean }
```
**`user/message`**（data 即 `UserMessage`，`dsh-session/lib/types/types.d.ts:262`；追加点 `dsh-agent-loop/lib/index.js:554`，携带 `surfaceOp:'append'`）：`{ id, role:'user', content, source }`；`source` 判别 `kind: 'user' | 'plugin' | 'model' | 'tool'`（`dsh-llm/lib/types/message.d.ts:94-104`；`tool` 源带 `callId`）。

### 3.2 工具调用

**`tool/call`**：`{ turn, step, callId: CallId, name: string, arguments: string /* 模型原始 JSON 串，未解析 */ }`（`dsh-session/lib/types/types.d.ts:286-292`；追加点 `dsh-agent-loop/lib/index.js:292-300`，返回事件 seq 供 result 引用）。

**`tool/result`**：`{ turn, step, message: ToolResultMessage, error?: { name: string; code: string }, meta?: JsonValue }`（`dsh-session/lib/types/types.d.ts:304-313`；追加点 `dsh-agent-loop/lib/index.js:302-318`，携带 `surfaceOp:'append'` 与 `sourceEventSeqs:[callSeq]`）。`ToolResultMessage = { id, role:'user', content:[ToolResultBlock], source:{ kind:'tool', callId } }`（`dsh-llm/lib/types/message.d.ts:140-144`）；`meta` 为工具私有展示负载，必须 JSON 可序列化。

### 3.3 边界与状态类

- **`turn/start`**：`{ turn: number }`（`dsh-session/lib/types/types.d.ts:230-232`；`dsh-agent-loop/lib/index.js:523`）
- **`turn/end`**：`{ turn: number, reason: TurnEndReason }`（`dsh-session/lib/types/types.d.ts:241-244`；`dsh-agent-loop/lib/index.js:592-595`）
  `TurnEndReason`（`dsh-session/lib/types/types.d.ts:135-169`）：
  ```ts
  { kind: 'completed' }
  | { kind: 'aborted'; reason: { kind:'user'|'parent'|'disposed' } | { kind:'hook'; reason:string } | { kind:'legacy' } }
  | { kind: 'blocked' }
  | { kind: 'error'; error: LlmFailure }   // LlmFailure = { message, code, status?, providerRetryAfterMs?, requestId? }
  | { kind: 'max-tokens' }
  | { kind: 'interrupted' }
  ```
- **`step/start`** / **`step/end`**：`{ turn, step }`（`dsh-session/lib/types/types.d.ts:246-254`；`dsh-agent-loop/lib/index.js:548,558`）
- **`todo/write`**：`{ todos: TodoItem[] }`，`TodoItem = { content: string; status: 'pending'|'in_progress'|'completed' }`（`dsh-session/lib/types/types.d.ts:180-185, 315-317`；追加点 `dsh-tool-todo/lib/index.js:172`）
- **`plan/mode`**：`{ active: boolean }`（`dsh-plan-mode/lib/index.js:353,368`）
- **`goal/change`**：`{ kind:'goal/change', version:1, operation: 'create'|'edit'|'pause'|'resume'|'complete'|'block', goal: GoalSnapshot, roundsStarted, createdAt, updatedAt }` 或 clear 墓碑 `{ kind:'goal/change', version:1, operation:'clear', cleared: GoalRef, clearedAt }`（`dsh-goal/lib/types/domain.d.ts:17-39`；`GoalSnapshot = { id, revision, objective, phase: 'active'|'paused'|'blocked'|'complete', blockedReason?: {code,message}, maxGoalRounds }`，`dsh-goal/lib/types/types.d.ts:46-53`）
- **`session/title`**：`{ title: string, messageSeqs: number[], source: { kind:'fallback' } | { kind:'provider'; provider; model? } | { kind:'user' } }`（追加点 `dsh-session-title/lib/index.js:238,402,542,564`；折叠 `foldSessionTitle` `:112-122` 返回 `{ title, messageSeqs, source, eventSeq, updatedAt }`）
- **`agent-preset/selected`**：`{ agentPreset: string }`（`dsh-host-apiproxy/lib/index.js:3348`；折叠 `resolveSessionPreset` `dsh-agent-presets/lib/index.js:762-768`）
- **`approval/asked`**：`{ id, toolName, callId?, reason? }`；**`approval/decided`**：`{ id, outcome }`（见第 4 节）
- **`request/header`**：`{ header: EpochHeader, reason: 'initial'|'resume'|'change' }`（`dsh-session/lib/types/types.d.ts:322-325`）；`EpochHeader = { config: LlmCallConfig, adapterDefaults?, system?, tools? }`（`:191-200`）；`LlmCallConfig = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`（`dsh-llm/lib/types/call-config.d.ts:16-23`）
- **`request/context`**：`{ provider, model, contextWindow? }`（`dsh-session/lib/types/types.d.ts:202-209`）

> 渲染提示：只处理 `surfaceOp === 'append'` 的 `assistant/message`/`user/message`/`tool/result` 得到"人可见"的完整转录；`assistant/chunk` 用于流式增量（`isAppendSurfaceEvent`，`dsh-session/lib/index.js:252-254`）。历史消息直接读 `agent.session.deriveMessages()`（`dsh-session/lib/index.js:1539-1554`）。

---

## 4. 审批 / ask-user 的应答方式

### 4.1 工具审批（sandbox 升级等）：`approval/request` waterfall

服务：`ctx.approval`（`ApprovalService`，`dsh-user-approval/lib/index.js:85-203`；d.ts `dsh-user-approval/lib/types/index.d.ts:141-193`）。

- **发起**：`ctx.approval.request(req)`（`dsh-user-approval/lib/index.js:144`）→ `Promise<ApprovalOutcome>`；`req: ApprovalRequest = { agent: Agent, toolName: string, callId?: CallId, reason?: string, signal?: AbortSignal }`（d.ts `:104-125`）。要求会话处于**打开的 turn** 内（`:146`）。
- **应答（注册 answerer）**：在根上下文注册 waterfall 监听：
  ```js
  ctx.on("approval/request", (req, next) => {
    // req.agent / req.toolName / req.callId / req.reason —— 只读
    const ok = await tuiConfirm(req);   // 你自己的 y/n 交互
    return ok ? "allowed-once" : "rejected";   // 直接返回即认领；调用 next() 则交给下一个 answerer
  });
  ```
  出处（web 宿主 apiproxy 的官方 answerer 模式）：`dsh-host-apiproxy/lib/index.js:1955-2007`；事件声明 `dsh-user-approval/lib/types/index.d.ts:24`；分发 `dsh-user-approval/lib/index.js:189`。
- **outcome 词汇**：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`dsh-user-approval/lib/types/types.d.ts:23`）；无 answerer 或监听器抛错时 fail-closed 为 `'unavailable'`（`dsh-user-approval/lib/index.js:189`）。
- **策略**：`ctx.approval.setPolicy(agent, 'ask'|'never')`（`:111-125`）；会话级覆盖存于 `approval/policy` 事件（`{ policy }`），`effectiveApprovalPolicy(events)` 折叠（`dsh-user-approval/lib/index.js:49-54`）。
- **审计事件**（session/event 里能收到）：`approval/asked` `{ id, toolName, callId?, reason? }` 与 `approval/decided` `{ id, outcome }`（`dsh-user-approval/lib/types/index.d.ts:37-51`；追加 `dsh-user-approval/lib/index.js:148-158`）。

### 4.2 模型提问工具（`ask_user_question`）：`ctx.userQuestions`

- 工具注册：`dsh-tool-ask-user/lib/index.js:15-113`，工具名 **`ask_user_question`**（`:16`），入参 `{ questions: [{ id, question, header?, options?: [{ label, description? }], multi_select? }] }`，输出 `{ answers: [{ id, selected: string[], custom? }] }`。
- 服务：`ctx.userQuestions`（`UserQuestionService`，`dsh-user-questions/lib/index.js:20-74`）。
- **注册 answerer（UI provider，单例）**：
  ```js
  const dispose = ctx.userQuestions.registerProvider({
    async ask(request) {           // request: AskUserQuestionRequest
      // request.questions: [{ id, question, detail?, header?, options?, multiSelect?, intent? }]
      // request.agent / request.signal
      const answers = await tuiCollect(request.questions);   // 你的终端交互
      return { answers };          // [{ id, selected: [...labels], custom? }]
    },
  });
  ```
  签名：`registerProvider(provider: { ask(request): Promise<AskUserQuestionAnswer> }): () => void`（`dsh-user-questions/lib/types/index.d.ts:29-31,46`；实现 `dsh-user-questions/lib/index.js:31-40`）。
- 请求/应答字段：`AskUserQuestionItem = { id, question, detail?, header?, options?: AskUserQuestionOption[], multiSelect?, intent? }`（`dsh-user-questions/lib/types/types.d.ts:32-47`）；`AskUserQuestionAnswer = { answers: [{ id, selected: string[], custom?: string }] }`（`:49-61`）。`intent: { kind:'plan-review', approve: string }` 为可选展示意图（`:21-30`）。
- 约束：`ask()` 校验 agent 必须是活着的 runtime root（子 agent 不可问人，`dsh-user-questions/lib/index.js:59-64`）；无 provider 抛 `NO_PROVIDER`（`:71`）。

---

## 5. 模型选择

服务：`ctx.agentDefaultModel`（`AgentDefaultModelConfig`，`dsh-agent-default-model/lib/index.js:32-72`；d.ts `dsh-agent-default-model/lib/types/index.d.ts`）。

| API | 签名 | 返回 | 出处 |
|---|---|---|---|
| `currentSelection()` | `(): ModelSelection` | `{ provider: string, model: string, reasoningEffort?: ReasoningEffortId }` | `dsh-agent-default-model/lib/index.js:56-58` |
| `saveSelection(next)` | `async (next: ModelSelection): Promise<void>` | 写 settings 后 resolve | `dsh-agent-default-model/lib/index.js:65-71` |

- **读取可用模型**（`ctx.llm`，`LlmRuntime`）：
  - `listProviders(): LlmProviderInfo[]`（`{ id, name }`，同步）— `dsh-llm/lib/types/index.d.ts:234`，实现 `dsh-llm/lib/index.js:1022`
  - `listModels(provider): Promise<LlmModelInfo[]>`（`{ provider, id, name, description?, inputModalities? }`）— d.ts `:284`，实现 `dsh-llm/lib/index.js:1154`
  - `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>`（含 `context.contextWindow`、`defaultMaxTokens`、`reasoning.efforts`/`defaultEffort`）— d.ts `:294`
  - `listConfigurableProviders(): LlmConfigurableProvider[]` — d.ts `:248`
  - `prepareCall(config: LlmCallConfig, signal?)` / `stream(options: GenerateOptions)` 为直接调用模型的一等 API — d.ts `:316,337`
- **切换模型**：没有"切换运行中 agent 模型的专用方法"（「未找到」`setModel(agent, …)` 之类）；实际机制是——
  1. 新会话：`agentOptions: { provider, model }` 在创建时传入（`dsh-headless/lib/index.js:73-76`）；
  2. 想对**未来 agent** 生效的持久默认：`agentDefaultModel.saveSelection({ provider, model, reasoningEffort })`，写入 settings 命名空间 **`agent-default-model`**（`dsh-agent-default-model/lib/index.js:12,66`）；
  3. 想对**运行中 agent** 的下一个 step 生效：通过 `agent/request` waterfall 拦截替换配置（`dsh-agent/lib/types/runtime-types.d.ts:254-259`；`installModelSelection` 即此机制，`dsh-agent/lib/index.js:287-298`），或维护 `ModelSelectionRef.current` 让 `installModelSelection` 应用它。
- **settings.yaml 位置与格式**：默认文档 `<harness home>/settings.yaml`（`dsh-settings-file/lib/index.js:31`，`DSH_HOME` 解析 `dsh-home-paths`）；`agent-default-model` 段的 schema 为 `{ provider: string(required), model: string(required), reasoningEffort?: string }`（`dsh-agent-default-model/lib/index.js:14-18`），即：
  ```yaml
  agent-default-model:
    provider: deepseek-official
    model: deepseek-v4-flash
    reasoningEffort: medium   # 可选
  ```
  写入 API：`ctx.settings.replace(namespace, section)`（`dsh-settings/lib/types/index.d.ts:105-110`）。`saveSelection` 内部即 `settings.replace(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, …)`（`dsh-agent-default-model/lib/index.js:66-70`）。

---

## 6. 会话枚举与恢复

### 6.1 列出历史会话

服务：`ctx.sessionQuery`（`SessionQueryEngine`，`dsh-session-query/lib/index.js:785-967`），live 优先、无持久化时静默降级（`dsh-session-query/lib/index.js:32-51`）。

| API | 签名 | 返回 | 出处 |
|---|---|---|---|
| `listSessions(signal?)` | `async (signal?): Promise<SessionRecord[]>` | `[{ header: SessionHeader, live: boolean, persisted: boolean }]`，**按 `header.createdAt` 新→旧**排序 | `dsh-session-query/lib/index.js:802-804`；记录构造 `:57-78` |
| `readTitleSnapshot(sessionId, signal?)` | `async (…)` | `{ session: SessionHeader, title?: { title, messageSeqs, source, eventSeq, updatedAt } }` | `:844-847` |
| `readTitleSnapshots(ids, signal?)` | `async (…)` | `[{ sessionId, status: 'fulfilled'\|'rejected', value \| reason }]`（保序） | `:858-866` |
| `readSession(sessionId)` | `async (…)` | `{ session: SessionHeader, events: SessionEvent[] }`（重放校验过的完整日志） | `:811-818` |
| `filterSessions(filters, signal?)` | `async (…)` | 支持 `id`/`cwd`/`created-at`/`parent`/`availability`(`live`\|`persisted`) 过滤 | `:825-828`；谓词 `:496-509` |
| `listEvents(sessionId)` / `filterEvents(sessionId, filters)` / `readSurface` / `readEvent` / `traceSession` / `traceEvent` | 事件级读取/追踪 | — | `:872,881,897,938,912,924` |

- `SessionHeader` 字段：`{ version, id, createdAt, cwd?, parentSession?, seedLength?, origin?, delegationDepth?, agentPreset? }`（`dsh-session/lib/types/types.d.ts:40-78`）。
- 底层持久化服务 `ctx.sessionPersistence`（`dsh-session-persistence`，base 已挂 jsonl 后端）：`list(signal?) → SessionHeader[]`（`dsh-session-persistence/lib/types/index.d.ts:176`）、`inspect(id, signal?)`（`:148`）、`prepare(id, signal?)`（`:118`）、`load(id)`（`:132`）、`readFrom(id, fromSeq, signal?)`（`:167`）。

### 6.2 恢复 / 继续一个持久化会话

完整流程（工厂实现 `dsh-agent-loop/lib/index.js:1256-1292`）：

```js
const { agent, dispose } = await ctx.agents.resume({
  resumeSessionId: sessionId,          // 持久化会话 id（来自 listSessions）
  agentOptions: { provider, model },   // 可选，模型路由
  setup: async (agentCtx) => {         // 可选，与 create 相同的组合钩子
    await agentPresets.mount(agentCtx, presetId);   // 如有 preset
    installModelSelection(agentCtx, selectionRef);
    // …注册 scoped 工具/提示词
  },
  signal,                              // 可选
});
```

- 要求：`sessionPersistence` 必须已挂载（`dsh-agent-loop/lib/index.js:1257-1258`），且该 id 当前不在 live 状态（`dsh-session-persistence/lib/index.js:852`）。
- 恢复时构造的 Session 通过 `Session.fromRestore` 冻结整个持久化日志（`dsh-session/lib/index.js:1367-1369`，经 `sessions.prepare(id, { seedSource:'persistence' })` `:1651`）；恢复**不会**重放 `session/event`（构造期种子事件不发布，`dsh-session/lib/index.js:1385-1387` + `firstLiveSeq` 文档 `:1326-1345`）——恢复后的初始 UI 状态应直接读 `agent.session.events` / `deriveMessages()`，之后增量靠 `session/event`。
- 恢复后首个请求会追加 `request/header`（reason `'resume'`，`dsh-agent-loop/lib/index.js:709-714`），并把日志尾部未闭合的崩溃 turn 用合成事件收口（`interruptedTurnClosers`，`dsh-session/lib/index.js:626-725`）。
- 退出/换会话时 `await dispose()`（`dsh-agent/lib/types/index.d.ts:155-158`）；需要立刻落盘可 `await ctx.sessions.flush(agent.session)`（`dsh-session/lib/index.js:1787-1804`）。

---

## 7. Agent preset

服务：`ctx.agentPresets`（`AgentPresets`，`dsh-agent-presets/lib/index.js:804-1152`；d.ts `dsh-agent-presets/lib/types/index.d.ts:55-289`）。

### 7.1 `agentPreset` 字段如何影响 Agent 创建

- 会话头 `SessionHeader.agentPreset`（`dsh-session/lib/types/types.d.ts:77`）来自创建时 `meta.agentPreset`（`dsh-session/lib/index.js:1663`；`CreateAgentOptions.meta.agentPreset` `dsh-agent/lib/types/index.d.ts:85`），并在切换时追加 `agent-preset/selected` 事件（`{ agentPreset }`，`dsh-host-apiproxy/lib/index.js:3348`）。
- **实际生效路径不在 header，而在 setup 钩子**：preset 是"每个会话的 cordis.yml 插件组合"，由 `setup(agentCtx)` 内调用 `agentPresets.mount(agentCtx, presetId)` 挂载（`dsh-agent-presets/lib/index.js:954-961`；唯一受支持调用点，注释 `:786-790`）。mount 把该 preset 的 standing 组合（工具、提示词 section、技能目录）通过 scope parent 链接入该 agent，随 agent 卸载自动回收（`dsh-agent-presets/lib/index.js:436-448, 698-735`）。
- 读取某会话实际运行的 preset：`resolveSessionPreset(session)`（最后的 `agent-preset/selected` 优先，其次 header，`dsh-agent-presets/lib/index.js:762-768`）；或 `agentPresets.composedPreset(agent.ctx)`（live scope 链，`dsh-agent-presets/lib/index.js:1005-1007`）。

### 7.2 默认 preset 解析（settings.yaml 的 `agent-presets.default`）

- `defaultId`：`this.settings?.get().default ?? this.config.default`（`dsh-agent-presets/lib/index.js:880-882`）——settings 用户层优先于插件 config。
- settings 命名空间 **`agent-presets`**，schema `{ default: string }`（`dsh-agent-presets/lib/index.js:794-796`），即 `$DSH_HOME/settings.yaml` 中：
  ```yaml
  agent-presets:
    default: standard      # 或 cordis / minimal / code / 自建 id
  ```
- 插件 config：`{ default: string(required), roots: [{ path, trust: 'system'|'user' }], includeUserRoot: boolean }`（`dsh-agent-presets/lib/index.js:808-815`）；user 根固定为 `<DSH_HOME>/.agent-presets`（`:851-854`）。
- **注意**：`dsh-base` 的核心组合**不包含** `agent-presets` 行（「未找到」于 `dsh-base/cordis.patch.yml`）；web 档在 `dsh-web-app/cordis.patch.yml:421-426` 添加 `agent-presets` 行（config `default: standard`），官方 preset 目录位于部署的 `config/agent-presets/`（`dsh` 包内 `dsh/config/agent-presets/{cordis,standard,minimal,code}/agent.cordis.yml`）。**TUI 需要在自己的组合里自行添加该行**才能使用 preset。
- 其他有用方法：`list()`（`dsh-agent-presets/lib/index.js:887`）、`resolve(id?)`（`:900`）、`read(id)`（`:1027`）、`copy/remove`（`:1045,1056`）、`composeFrom(agentCtx, parentCtx)`（子 agent 继承父组合，`:988`）、`recompose(agentCtx, id)`（仅限空白会话换 preset，`:1104`）、`serviceFor(agent, name)`（读 preset 内 isolate 服务，`:1080`）。

---

## 附：关键文件:行号索引

- Agent 注册表与 handle：`dsh-agent/lib/index.js:415-792`；类型 `dsh-agent/lib/types/index.d.ts:65-158,209-384`
- Agent 实例（ReactLoopAgent）：`dsh-agent-loop/lib/index.js:335-740`；类型 `dsh-agent-loop/lib/types/agent.d.ts:12-60`；接口 `dsh-agent/lib/types/runtime-types.d.ts:60-133`
- 工厂与 setup/publish：`dsh-agent-loop/lib/index.js:1088-1292`
- Session 类与 store：`dsh-session/lib/index.js:1303-1564,1580-1884`；事件表 `dsh-session/lib/types/types.d.ts:223-354`
- 消息/块/流块：`dsh-llm/lib/types/message.d.ts:94-205`、`dsh-llm/lib/types/types.d.ts:38-297`；构造器导出 `dsh-llm/lib/index.js`（末尾 export 行）
- LLM 服务：`dsh-llm/lib/types/index.d.ts:234,248,284,294,316,337`
- 审批：`dsh-user-approval/lib/index.js:85-203`；类型 `dsh-user-approval/lib/types/index.d.ts:24-125`
- 提问：`dsh-user-questions/lib/index.js:20-74`；`dsh-tool-ask-user/lib/index.js:15-113`
- 默认模型：`dsh-agent-default-model/lib/index.js:12-72`
- 会话查询：`dsh-session-query/lib/index.js:785-967`
- 持久化：`dsh-session-persistence/lib/types/index.d.ts:60-187`
- Preset：`dsh-agent-presets/lib/index.js:762-1152`；`dsh-web-app/cordis.patch.yml:421-426`
- 官方进程内驱动示例：`dsh-headless/lib/index.js:63-99`
- boot：`dsh-app-boot/lib/index.js:1166-1188`
