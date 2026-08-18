/**
 * deepcode TUI controller — wraps a live Agent (create / send / interrupt /
 * model switch), folds session events into a transcript + usage stats, and
 * publishes reactive snapshots to the UI.
 *
 * @module deepcode/lib/controller
 */

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { CallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

/** User-settings namespace the pi-ai multi-provider adapter reads (web Models page parity). */
const PI_AI_NS = settingsNamespace("llm-pi-ai");

const POLL_MS = 33;
/** Session titles rarely change after the first prompt; cache them briefly. */
const TITLE_CACHE_TTL = 60_000;

/** A fresh usage/timing accumulator block (opencode status bar mirror). */
function freshStats() {
  return {
    llmMs: 0,
    toolMs: 0,
    firstTokenMsSum: 0,
    firstTokenCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
  };
}

function blocksText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b != null && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function blocksReasoning(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b != null && b.type === "reasoning")
    .map((b) => (typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : ""))
    .join("");
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b?.type === "tool-result") return toolResultText(b.content);
        return b?.text ?? b?.content ?? "";
      })
      .join("");
  }
  return "";
}

/**
 * Normalize a tool call name to the short display form the web app shows
 * (read / write / edit / bash / glob / grep / think / …). Handles both the
 * canonical `tool:*` names and legacy aliases.
 */
const TOOL_NAME_ALIASES = {
  "tool:read": "read",
  "tool:write": "write",
  "tool:edit": "edit",
  "str_replace_editor": "edit",
  "tool:bash": "bash",
  "tool:glob": "glob",
  "tool:grep": "grep",
  "tool:web_search": "web_search",
  "tool:web_fetch": "web_fetch",
  "todo_write": "todo_write",
  "read_image": "read_image",
  "ask_user_question": "question",
  "tool:skill": "skill",
  "tool:jobs": "job",
  "job_list": "job_list",
  "job_output": "job_output",
  "tool:todo": "todo_write",
  "tool:subagent": "subagent",
  "tool:workflow": "workflow",
  "tool:ralph": "ralph",
};

function normalizeToolName(name) {
  const key = String(name ?? "");
  if (TOOL_NAME_ALIASES[key] !== undefined) return TOOL_NAME_ALIASES[key];
  // strip any remaining "tool:" / namespace prefixes
  const stripped = key.replace(/^[a-z-]+:/, "");
  return stripped === "" ? "tool" : stripped;
}

/** Drive one live Agent and publish transcript snapshots to subscribers. */
export class AgentController {
  #services;
  #subscribers = new Set();
  #timer = null;
  #lastSeq = 0;
  #lastEmittedStatus = null;
  #transcript = [];
  #streaming = null;
  #toolIndex = new Map();
  #disposeAgent = undefined;
  #selectionRef = undefined;

  // Session stats mirror — fed by the host `sessionProjections` units
  // (sessionStats / tokenUsage / contextPressure), never folded by hand.
  #stats = freshStats();
  #lastEventTime = 0;
  #skipToolCards = new Set();
  /** Monotonic transcript item id (never reset — UI state keys on it). */
  #itemSeq = 0;
  /** Per-session title cache (id → { title, at }) — avoids re-loading logs. */
  #titleCache = new Map();

  agent = null;
  modelLabel = "";
  effortLabel = "";
  permissionLabel = "workspace-write";
  /** The session workspace directory (shown in the footer). */
  cwd = "";
  /** Auto-summarized session title (folded from `session/title` events). */
  sessionTitle = "";

  // Answerer slots, assigned by the UI layer:
  approvalHandler = null; // async (req) => boolean
  questionsHandler = null; // async (request) => { answers }

  constructor(services) {
    this.#services = services;
  }

  /**
   * Merge additional (optional, lazily resolved) services into the controller.
   * Called by the runner after the loader settles, so sibling plugins that
   * mount after this one are available (e.g. permissionPresets, commands).
   */
  setServices(extra) {
    Object.assign(this.#services, extra);
  }

  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  #emit() {
    const snapshot = {
      items: this.view(),
      status: this.status,
      stats: { ...this.#stats },
      queue: this.#queueRows(),
    };
    for (const fn of this.#subscribers) fn(snapshot);
  }

  /**
   * The agent's pending inbox as display rows — next-step input first, then
   * queued next-turn prompts (the web client's `session/queue` surface, read
   * directly from the live agent). Completed commands are spliced out of the
   * inbox by the agent loop, so a finished message simply drops off the list.
   * @returns `{ id, text, placement }` rows, text-only.
   */
  #queueRows() {
    if (this.agent === null) return [];
    const inbox = this.agent.inbox;
    if (inbox === undefined) return [];
    const rows = [];
    for (const target of ["next-step", "next-turn"]) {
      const list = target === "next-step" ? inbox.nextStep : inbox.nextTurn;
      for (const message of list) {
        const text = blocksText(message?.content).trim();
        if (text === "") continue;
        rows.push({ id: String(message.id ?? ""), text, placement: target });
      }
    }
    return rows;
  }

  /** Create the agent with the default model + preset, then start polling. */
  async start() {
    const { agents, agentDefaultModel, agentPresets } = this.#services;
    const selection = agentDefaultModel.currentSelection();
    this.modelLabel = selection.model ?? selection.provider;
    this.effortLabel = selection.reasoningEffort ?? "low";
    this.#selectionRef = { current: selection, assembled: void 0 };
    this.cwd = process.cwd();
    // every (re)start begins with a blank stats block — /new resets the
    // right-side panel to zeroes
    this.#stats = freshStats();

    const { agent, dispose } = await agents.create({
      sessionId: SessionId(`deepcode-${randomUUID()}`),
      meta: { cwd: this.cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        if (agentPresets !== undefined) await agentPresets.mount(agentCtx);
        installModelSelection(agentCtx, this.#selectionRef);
      },
    });
    this.agent = agent;
    this.#disposeAgent = dispose;
    this.#lastSeq = agent.session.events.length;
    const presets = this.#services.permissionPresets;
    if (presets !== undefined) {
      this.permissionLabel = presets.current(agent.session.events) ?? "workspace-write";
    }

    // Best-effort context-window read so the bar is populated before the first
    // request (the `request/context` event refines it later).
    const llm = this.#services.llm;
    if (llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(selection.provider, selection.model);
        if (typeof info?.context?.contextWindow === "number" && info.context.contextWindow > 0) {
          this.#stats.contextWindow = info.context.contextWindow;
        }
      } catch {
        /* keep the request/context fallback */
      }
    }

    this.#timer = setInterval(() => this.#poll(), POLL_MS);
    this.#timer.unref?.();
    this.#emit();
  }

  /**
   * Start a brand-new session: tear down the current agent (loop + poll
   * timer), wipe the transcript and tool bookkeeping, then create a fresh
   * agent exactly like a cold boot — the UI falls back to the empty logo
   * home state and the right-side panel resets to zeroes.
   */
  async newSession() {
    this.#stopAgent();
    this.#transcript = [];
    this.#streaming = null;
    this.#toolIndex.clear();
    this.#skipToolCards.clear();
    this.sessionTitle = "";
    await this.start();
  }

  /**
   * List the current workspace's sessions, newest first — CHEAP: only the
   * corpus listing (first-line reads), no per-session log loads. Titles are
   * empty here; call `enrichTitles` to fill them (expensive, cached).
   * The persistence corpus spans EVERY workspace under the dsh session root,
   * so records are filtered by the session's recorded cwd.
   * @returns `{ id, createdAt, cwd, live, title: "" }` records.
   */
  async listSessions() {
    const query = this.#services.sessionQuery;
    if (query === undefined) return [];
    try {
      const [records, root] = await Promise.all([query.listSessions(), this.#workspaceRoot()]);
      // workspace membership exactly like the web's workspace registry: a
      // session belongs to this workspace iff its cwd realpaths to the current
      // workspace root (the web canonicalizes cwd via fs.realpath before
      // grouping; sessions whose cwd is missing or does not resolve are the
      // web's "un组"/ungrouped ones and are excluded here the same way).
      const out = [];
      for (const r of records) {
        const cwd = r.header.cwd;
        if (cwd === undefined) continue;
        let canonical;
        try {
          canonical = await realpath(cwd);
        } catch {
          continue; // cwd does not resolve → ungrouped on the web → exclude
        }
        if (canonical !== root) continue; // not this workspace
        out.push({
          id: String(r.header.id),
          createdAt: r.header.createdAt ?? 0,
          cwd,
          live: r.live === true,
          title: "",
          blank: undefined, // filled lazily by enrichTitles (cheap log read)
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * The canonical (realpath) of the current workspace directory. Mirrors the
   * web's `fs.realpath` normalization so symlinked/aliased launch paths still
   * match the recorded session cwds. Falls back to the raw path when the
   * directory no longer resolves.
   */
  async #workspaceRoot() {
    const cwd = this.cwd || process.cwd();
    try {
      return await realpath(cwd);
    } catch {
      return cwd;
    }
  }

  /**
   * Synchronous title lookup from the warm cache only (no I/O) — for the
   * immediate search-results render. Returns `undefined` on miss/expiry.
   * @param id - session id.
   * @returns the cached autosummary title, or undefined.
   */
  titleFor(id) {
    const hit = this.#titleCache.get(String(id));
    if (hit === undefined || Date.now() - hit.at >= TITLE_CACHE_TTL) return undefined;
    return hit.title;
  }

  /**
   * Enrich session records with auto-summarized titles (web session-title
   * projection), falling back to the first user message for untitled
   * sessions. Also flags `blank` stubs — sessions whose log never started a
   * turn (no conversation content) — so the picker can hide them. Results are
   * cached per session id for TITLE_CACHE_TTL, so only sessions never seen
   * before pay the log-load cost. Callers show the cheap list first and
   * refresh when this settles.
   * @param records - records from {@link listSessions}.
   * @param signal - optional cancellation shared with the underlying reads so
   * a superseded search aborts its title pass instead of queueing.
   * @returns the same records with `title` filled and `blank` known.
   */
  async enrichTitles(records, signal) {
    const query = this.#services.sessionQuery;
    if (query === undefined || records.length === 0) return records;
    const now = Date.now();
    const missing = records.filter((r) => {
      const hit = this.#titleCache.get(r.id);
      return hit === undefined || now - hit.at >= TITLE_CACHE_TTL;
    });
    if (missing.length > 0) {
      const titles = new Map();
      const blanks = new Map(); // id → boolean; true = never started a turn
      const ids = missing.map((r) => r.id);
      if (query.readTitleSnapshots !== undefined) {
        try {
          const snaps = await query.readTitleSnapshots(ids, signal);
          snaps.forEach((snap, i) => {
            if (snap.status !== "fulfilled") return;
            // the snapshot carries the title under its own `title` field
            // (foldSessionTitle returns { title, messageSeqs, source, … })
            const held = snap.value?.title;
            const text = typeof held === "string" ? held : held?.title;
            if (typeof text === "string" && text !== "") {
              titles.set(ids[i], text);
              // a resolved title projection implies real conversation content
              blanks.set(ids[i], false);
            }
          });
        } catch {
          /* titles are best-effort */
        }
      }
      // untitled sessions fall back to their first user message (parallel);
      // blank detection rides the same log read (no turn ⇒ conversation stub)
      await Promise.all(
        missing.map(async (r) => {
          if (signal?.aborted === true) return;
          try {
            const loaded = await query.load(r.id, signal);
            const hasConversation = loaded.events.some(
              (e) => e.type === "turn/start" || e.type === "user/message" || e.type === "assistant/message",
            );
            if (!blanks.has(r.id)) blanks.set(r.id, !hasConversation);
            if (!titles.has(r.id)) {
              const firstUser = loaded.events.find((e) => e.type === "user/message");
              const text = firstUser?.data?.content
                ?.filter((b) => b?.type === "text" && typeof b.text === "string")
                .map((b) => b.text)
                .join("") ?? "";
              titles.set(r.id, text.trim().slice(0, 60) || r.id.slice(0, 20));
            }
          } catch {
            if (!blanks.has(r.id)) blanks.set(r.id, true); // unreadable → stub
            if (!titles.has(r.id)) titles.set(r.id, r.id.slice(0, 20));
          }
        }),
      );
      for (const r of missing) {
        this.#titleCache.set(r.id, {
          title: titles.get(r.id) ?? r.id.slice(0, 20),
          at: now,
          blank: blanks.get(r.id),
        });
      }
    }
    return records.map((r) => {
      const hit = this.#titleCache.get(r.id);
      return {
        ...r,
        title: hit?.title ?? r.id.slice(0, 20),
        blank: hit?.blank ?? (r.blank === true),
      };
    });
  }

  /**
   * Switch to an existing session: dispose the current agent, resume the
   * persisted session with a fresh agent, and fold its full history into the
   * transcript. The session must exist in persistence or the live store.
   * Any session of the current workspace is resumable — including sessions the
   * web app created (`session-*`) or harness subagents — the same way the web's
   * session-open path resumes `ctx.agents.resume({ resumeSessionId, ... })`.
   * @param sessionId - the session id to resume.
   * @returns true on success, false if the session could not be resumed.
   */
  async switchSession(sessionId) {
    const { agents, agentDefaultModel, agentPresets } = this.#services;
    if (agents === undefined || agentDefaultModel === undefined) return false;
    const selection = agentDefaultModel.currentSelection();
    this.modelLabel = selection.model ?? selection.provider;
    this.effortLabel = selection.reasoningEffort ?? "low";
    this.#selectionRef = { current: selection, assembled: void 0 };

    // tear down the current agent (loop, poll timer) before resuming
    this.#stopAgent();
    try {
      const { agent, dispose } = await agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          if (agentPresets !== undefined) await agentPresets.mount(agentCtx);
          installModelSelection(agentCtx, this.#selectionRef);
        },
      });
      this.agent = agent;
      this.#disposeAgent = dispose;
      // fold the full restored history into the transcript; the session
      // projections are read fresh for the resumed session
      this.#transcript = [];
      this.#streaming = null;
      this.#toolIndex.clear();
      this.#skipToolCards.clear();
      this.#stats = freshStats();
      this.sessionTitle = "";
      this.#lastSeq = 0;
      this.#fold(agent.session.events);
      this.#lastSeq = agent.session.events.length;
      this.#refreshProjections();
      this.cwd = agent.session.header?.cwd ?? this.cwd;
      const presets = this.#services.permissionPresets;
      if (presets !== undefined) {
        this.permissionLabel = presets.current(agent.session.events) ?? "workspace-write";
      }
      this.#timer = setInterval(() => this.#poll(), POLL_MS);
      this.#timer.unref?.();
      this.#emit();
      return true;
    } catch (error) {
      // resume failed: report and keep the session list usable
      this.addSystem(`Failed to resume session: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Full-text session search — the COMPOSED host surface the web calls
   * (`apiProxy.sessions.search`, the api-gateway over the SQLite FTS corpus):
   * visibility filtering, hit normalization, and paging are all handled by
   * the plugins; nothing is hand-rolled.
   * @param query - search text.
   * @param signal - optional cancellation shared with the sqlite engine, so a
   * superseded keystroke search aborts instead of queueing behind earlier ones
   * (web parity: the api surface passes the AbortController of the latest
   * query through `searchSessions`).
   * @returns `{ items: [{ sessionId, snippet }], hasMore }`.
   */
  async searchSessions(query, signal) {
    const queryService = this.#services.sessionQuery;
    if (queryService === undefined || typeof queryService.searchSessions !== "function") {
      return { items: [], hasMore: false };
    }
    // workspace filter: realpath-canonicalized like the web's workspace
    // registry, so a symlinked/aliased launch path still matches the recorded
    // cwd spellings stored in the index
    const cwd = this.cwd || process.cwd();
    const root = await this.#workspaceRoot();
    const spellings = [`${cwd}`, `${root}`].filter((v, i, a) => v !== "" && a.indexOf(v) === i);
    try {
      const result = await queryService.searchSessions(
        {
          query: String(query ?? ""),
          sessionFilters: [{ kind: "cwd", values: spellings }],
          eventFilters: [
            { kind: "type", values: ["user/message", "assistant/message"] },
            { kind: "surface", values: ["current"] },
          ],
          limit: 20,
        },
        { signal },
      );
      const items = Array.isArray(result?.items) ? result.items : [];
      return {
        items: items.map((hit) => ({
          sessionId: String(hit?.bestMatch?.sessionId ?? hit?.header?.id ?? ""),
          snippet: hit?.bestMatch?.snippet ?? "",
        })),
        hasMore: result?.nextCursor !== undefined,
      };
    } catch {
      return { items: [], hasMore: false };
    }
  }

  /**
   * Fuzzy project-file search for the @ mention — composes the `glob` tool
   * plugin (`dsh-tool-fs-search`, preset-mounted) through the tools registry:
   * the pattern matches basenames containing the query at any depth.
   * @param query - the mention query after `@`.
   * @returns `{ files }` — workspace-relative file paths.
   */
  async searchFiles(query) {
    const tools = this.#services.tools;
    if (tools === undefined || this.agent === null) return { files: [] };
    const q = String(query ?? "").trim();
    try {
      const result = await tools.execute({
        callId: CallId(`tui:glob:${randomUUID()}`),
        name: "glob",
        agent: this.agent,
        signal: new AbortController().signal,
        arguments: {
          // no "/" → basenames at any depth (the glob tool's documented rule)
          pattern: q === "" ? "*" : `*${q.replace(/[\\*?[\]{}()!]/g, "\\$&")}*`,
          path: this.cwd || process.cwd(),
        },
      });
      const paths = Array.isArray(result?.value?.paths) ? result.value.paths : [];
      return { files: paths.map((p) => String(p)) };
    } catch {
      return { files: [] };
    }
  }

  /** Stop the current agent and its poll timer (used when switching sessions). */
  #stopAgent() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#disposeAgent !== undefined) {
      try {
        this.#disposeAgent();
      } catch {
        /* the agent may already be gone */
      }
      this.#disposeAgent = undefined;
    }
    this.agent = null;
  }

  #poll() {
    if (this.agent === null) return;
    const events = this.agent.session.events;
    const changed = events.length !== this.#lastSeq;
    if (changed) {
      this.#fold(events);
      // stats + title come from the host session plugins (projections and
      // sessionTitle services) — refreshed only when the log grew
      this.#refreshProjections();
    }
    // Emit only on real changes (new events, streaming deltas, status flips).
    // Emitting unconditionally every tick would repaint the UI forever.
    if (changed || this.status !== this.#lastEmittedStatus) {
      this.#lastEmittedStatus = this.status;
      this.#emit();
    }
  }

  /**
   * Mirror the host session plugins into the panel stats + title — the same
   * `sessionProjections` units (sessionStats / tokenUsage / contextPressure)
   * and `sessionTitle` service the web composes. Nothing is folded by hand.
   */
  #refreshProjections() {
    if (this.agent === null) return;
    const session = this.agent.session;
    const projections = this.#services.sessionProjections;
    if (projections !== undefined) {
      try {
        const values = projections.snapshot(session).values;
        const usage = values.tokenUsage;
        if (usage !== undefined) {
          this.#stats.inputTokens = usage.uncachedInputTokens ?? 0;
          this.#stats.outputTokens = usage.outputTokens ?? 0;
          this.#stats.cacheReadTokens = usage.cacheReadTokens ?? 0;
          this.#stats.cacheWriteTokens = usage.cacheWriteTokens ?? 0;
        }
        const stats = values.sessionStats;
        if (stats !== undefined) {
          this.#stats.llmMs = stats.llmMs ?? 0;
          this.#stats.toolMs = stats.toolMs ?? 0;
          this.#stats.firstTokenMsSum = stats.ttftMs ?? 0;
          this.#stats.firstTokenCount = stats.ttftSteps ?? 0;
        }
        const pressure = values.contextPressure;
        if (pressure !== undefined) {
          const used = pressure.projectedTokens ?? pressure.pressureTokens;
          if (typeof used === "number") this.#stats.contextTokens = used;
          if (typeof pressure.contextWindow === "number" && pressure.contextWindow > 0) {
            this.#stats.contextWindow = pressure.contextWindow;
          }
        }
      } catch {
        /* projections are best-effort */
      }
    }
    const titles = this.#services.sessionTitle;
    if (titles !== undefined) {
      try {
        this.sessionTitle = titles.get(session)?.title ?? "";
      } catch {
        /* best-effort */
      }
    }
  }

  #fold(events) {
    for (let i = this.#lastSeq; i < events.length; i += 1) this.#foldEvent(events[i]);
    this.#lastSeq = events.length;
  }

  #foldEvent(event) {
    const data = event.data ?? {};
    const t = event.time ?? 0;

    switch (event.type) {
      case "user/message": {
        this.#flushStreaming();
        const text = blocksText(data.content);
        // source kind drives the display: "user" → right-aligned bubble;
        // plugin injections (runtime-context snapshot etc.) → collapsed
        // "context" disclosure row (web ContextInjectionRow parity)
        const sourceKind = data.source?.kind;
        if (text.trim() !== "") {
          this.#transcript.push({ kind: "user", text, sourceKind, id: ++this.#itemSeq });
        }
        break;
      }
      case "assistant/chunk": {
        // usage/timing are NOT folded here — the host sessionProjections
        // units (tokenUsage / sessionStats) own those numbers
        const chunk = data.chunk;
        if (chunk?.type === "text-delta") {
          this.#streaming ??= { text: "", reasoning: "" };
          this.#streaming.text += chunk.text;
        } else if (chunk?.type === "reasoning-delta") {
          this.#streaming ??= { text: "", reasoning: "" };
          this.#streaming.reasoning += chunk.text;
        }
        break;
      }
      case "assistant/message": {
        const message = data.message ?? data;
        const text = blocksText(message.content);
        const reasoning = blocksReasoning(message.content);
        if (this.#streaming !== null) {
          this.#flushStreaming();
        } else if (text.trim() !== "" || reasoning.trim() !== "") {
          this.#transcript.push({ kind: "assistant", text, reasoning, id: ++this.#itemSeq });
        }
        break;
      }
      case "turn/end": {
        const kind = data.reason?.kind;
        if (kind === "aborted") {
          // interrupted by the user: finalize any in-flight streaming text and
          // mark it stopped (web "message.stopped" parity), and settle tools
          // that never received a result as stopped
          if (this.#streaming !== null) {
            const s = this.#streaming;
            this.#streaming = null;
            if (s.text.trim() !== "" || s.reasoning.trim() !== "") {
              this.#transcript.push({
                kind: "assistant",
                text: s.text,
                reasoning: s.reasoning,
                interrupted: true,
                id: ++this.#itemSeq,
              });
            }
          }
          for (const item of this.#transcript) {
            if (item.kind === "tool" && item.status === "running") item.status = "stopped";
          }
        } else if (kind === "error") {
          this.#flushStreaming();
          const err = data.reason?.error;
          this.#transcript.push({
            kind: "turn-error",
            text: typeof err?.message === "string" ? err.message : "",
            id: ++this.#itemSeq,
          });
        } else if (kind === "max-tokens") {
          this.#flushStreaming();
          this.#transcript.push({ kind: "turn-max-tokens", id: ++this.#itemSeq });
        }
        break;
      }
      case "tool/call": {
        this.#flushStreaming();
        // match on the RAW name: normalizeToolName maps ask_user_question to
        // "question", so the pre-normalization check is what hides the card —
        // the interactive QuestionsPrompt renders the question instead of
        // dumping the tool's JSON arguments into the transcript
        const rawName = data.name ?? "tool";
        if (rawName === "ask_user_question") {
          this.#skipToolCards.add(data.callId);
          break;
        }
        const name = normalizeToolName(rawName);
        const item = {
          kind: "tool",
          callId: data.callId,
          name,
          arguments: data.arguments,
          status: "running",
          result: "",
          isError: false,
          id: ++this.#itemSeq,
        };
        this.#transcript.push(item);
        this.#toolIndex.set(data.callId, this.#transcript.length - 1);
        break;
      }
      case "tool/result": {
        // the result message carries the call id on source.callId (web parity)
        const callId = data.message?.source?.callId;
        if (this.#skipToolCards.has(callId)) break;
        // tool wall time is owned by the sessionStats projection — only the
        // card status is updated here
        const idx = this.#toolIndex.get(callId);
        if (idx !== undefined && this.#transcript[idx]?.kind === "tool") {
          this.#transcript[idx].status = data.isError ? "error" : "done";
          this.#transcript[idx].result = toolResultText(data.message?.content);
          this.#transcript[idx].isError = Boolean(data.isError);
        }
        break;
      }
      default:
        break;
    }

    this.#lastEventTime = t;
  }

  #flushStreaming() {
    if (this.#streaming !== null) {
      if (this.#streaming.text.trim() !== "" || this.#streaming.reasoning.trim() !== "") {
        this.#transcript.push({
          kind: "assistant",
          text: this.#streaming.text,
          reasoning: this.#streaming.reasoning,
          id: ++this.#itemSeq,
        });
      }
    }
    this.#streaming = null;
  }

  /** The visible transcript, including any in-flight streaming text. */
  view() {
    const items = [...this.#transcript];
    if (
      this.#streaming !== null &&
      (this.#streaming.text !== "" || this.#streaming.reasoning !== "")
    ) {
      items.push({
        kind: "assistant",
        text: this.#streaming.text,
        reasoning: this.#streaming.reasoning,
        streaming: true,
        // provisional id: the finalized item flushed next takes this id
        id: this.#itemSeq + 1,
      });
    }
    return items;
  }

  /**
   * Command feedback is intentionally silenced: the conversation area shows
   * only user messages and model messages, so system/command lines are
   * neither stored nor emitted.
   */
  addSystem() {
    /* no-op — command feedback is not shown in the TUI */
  }

  send(text) {
    if (this.agent === null || text.trim() === "") return;
    this.agent.followup(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }),
    );
  }

  interrupt() {
    this.agent?.cancel?.({ kind: "user" });
  }

  get status() {
    return this.agent?.status ?? "idle";
  }

  get stats() {
    return this.#stats;
  }

  currentModel() {
    return this.#selectionRef?.current ?? null;
  }

  /** List available models as `{ provider, model, name }`. */
  async listModels() {
    const llm = this.#services.llm;
    if (llm === undefined) return [];
    const providers = llm.listProviders() ?? [];
    const out = [];
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id);
        for (const m of models) {
          out.push({ provider: provider.id, model: m.id, name: m.name ?? m.id });
        }
      } catch {
        /* skip providers whose model list cannot be read */
      }
    }
    return out;
  }

  /** Switch the model for future requests and persist the default. */
  async switchModel(provider, model) {
    const { agentDefaultModel } = this.#services;
    const next = { provider, model };
    if (this.#selectionRef !== undefined) {
      this.#selectionRef.current = next;
      this.#selectionRef.assembled = next;
    }
    await agentDefaultModel.saveSelection(next);
    this.modelLabel = model;
    this.effortLabel = "low";
    return next;
  }

  /** List the current model's reasoning efforts as `{ id, name }`. */
  async listEfforts() {
    const llm = this.#services.llm;
    const cur = this.currentModel();
    if (llm === undefined || cur === null) return [];
    try {
      const info = await llm.resolveModelInfo(cur.provider, cur.model);
      return (info?.reasoning?.efforts ?? []).map((e) => ({ id: e.id, name: e.name ?? e.id }));
    } catch {
      return [];
    }
  }

  /** Switch the reasoning effort and persist the default. */
  async switchEffort(effortId) {
    const { agentDefaultModel } = this.#services;
    const cur = this.currentModel();
    if (cur === null) return;
    const next = { ...cur, reasoningEffort: effortId };
    if (this.#selectionRef !== undefined) {
      this.#selectionRef.current = next;
      this.#selectionRef.assembled = next;
    }
    await agentDefaultModel.saveSelection(next);
    this.effortLabel = effortId;
    return next;
  }

  /**
   * List configurable provider routes (web Models page parity): every
   * provider the `llm` plugin directory knows — installed catalog routes plus
   * routes declared by the `llm-pi-ai` settings section — each with its live
   * (registered adapter) vs dormant state.
   * @returns `{ route, displayName, live, declared, configured }` records.
   */
  listProviderOptions() {
    const llm = this.#services.llm;
    if (llm === undefined) return [];
    const configurable = Array.isArray(llm.listConfigurableProviders?.()) ? llm.listConfigurableProviders() : [];
    const live = new Set((Array.isArray(llm.listProviders?.()) ? llm.listProviders() : []).map((p) => p.id));
    const settings = this.#services.settings;
    let stored = {};
    if (settings !== undefined) {
      try {
        const section = settings.get(PI_AI_NS);
        stored = section?.providers ?? {};
      } catch {
        /* best-effort */
      }
    }
    return configurable.map((entry) => ({
      route: entry.provider,
      displayName: entry.displayName ?? entry.provider,
      live: live.has(entry.provider),
      declared: entry.declared === true,
      configured: Object.prototype.hasOwnProperty.call(stored, entry.provider),
    }));
  }

  /**
   * Read one provider's stored profile from the `llm-pi-ai` settings section
   * (the same section the web Models page writes).
   * @param route - provider route key.
   * @returns the detached stored profile, or undefined.
   */
  readProviderProfile(route) {
    const settings = this.#services.settings;
    if (settings === undefined) return undefined;
    try {
      const section = settings.get(PI_AI_NS);
      const profile = section?.providers?.[route];
      return profile === undefined ? undefined : structuredClone(profile);
    } catch {
      return undefined;
    }
  }

  /**
   * Configure (add or edit) a provider route through the pi-ai adapter's
   * user-settings section, exactly like the web Models page: the profile is
   * written into the `llm-pi-ai` settings section and the API key (when
   * supplied) is stored through the credentials service — never into the
   * settings document. The adapter plugin reacts to the committed section and
   * registers the route live, so the new model appears in `/model`.
   * @param input - `{ route, displayName?, api?, baseURL?, apiKeyEnv?, apiKey?, models? }`.
   * @returns the stored route key.
   */
  async saveProvider(input) {
    const { settings, credentials } = this.#services;
    if (settings === undefined) throw new Error("settings service unavailable");
    const route = String(input.route ?? "").trim();
    if (route === "") throw new Error("provider route must not be empty");
    const profile = {};
    if (input.displayName !== undefined && String(input.displayName).trim() !== "") profile.displayName = String(input.displayName).trim();
    if (input.api !== undefined && String(input.api).trim() !== "") profile.api = String(input.api).trim();
    if (input.baseURL !== undefined && String(input.baseURL).trim() !== "") profile.baseURL = String(input.baseURL).trim();
    if (input.apiKeyEnv !== undefined && String(input.apiKeyEnv).trim() !== "") profile.apiKeyEnv = String(input.apiKeyEnv).trim();
    const models = Array.isArray(input.models)
      ? input.models.map((m) => String(m).trim()).filter((m) => m !== "")
      : [];
    if (models.length > 0) profile.models = [...new Set(models)].map((id) => ({ id }));
    // merge into the existing section (web Models page writes the same shape)
    const current = this.readProviderProfile(route);
    await settings.update(PI_AI_NS, { providers: { [route]: { ...current, ...profile } } });
    const key = profile.apiKeyEnv ?? `${route.toUpperCase()}_API_KEY`;
    if (credentials !== undefined && input.apiKey !== undefined && String(input.apiKey).trim() !== "") {
      await credentials.set(credentialRef(key), String(input.apiKey).trim());
    }
    return route;
  }

  /** Remove a provider route from the `llm-pi-ai` settings section. */
  async removeProvider(route) {
    const settings = this.#services.settings;
    if (settings === undefined) throw new Error("settings service unavailable");
    const key = String(route);
    let providers;
    try {
      providers = settings.get(PI_AI_NS)?.providers ?? {};
    } catch {
      providers = {};
    }
    if (!Object.prototype.hasOwnProperty.call(providers, key)) return false;
    const next = { ...providers };
    delete next[key];
    await settings.replace(PI_AI_NS, { providers: next });
    return true;
  }

  /** List permission presets as `{ id, name, description, current }`. */
  listPermissions() {
    const presets = this.#services.permissionPresets;
    if (presets === undefined || this.agent === null) return [];
    const current = presets.current(this.agent.session.events);
    return presets.names.map((id) => {
      const opt = presets.optionOf(id);
      return {
        id,
        name: opt.name ?? id,
        description: opt.description ?? "",
        current: id === current,
      };
    });
  }

  /**
   * List the session's effective slash commands — the same host catalog the
   * web UI serves (`commands.list(agent)`), so the TUI's command set matches
   * the web app exactly.
   * @returns `{ name, description, hint? }` descriptors, name-sorted.
   */
  listCommands() {
    const commands = this.#services.commands;
    if (commands === undefined || this.agent === null) return [];
    try {
      return commands.list(this.agent).map((c) => ({
        name: c.name,
        description: c.description,
        hint: c.input?.hint,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Execute one slash-command line against the session's agent, exactly like
   * the web UI's `commands.execute`. Unknown/malformed lines log nothing and
   * return undefined (the UI reports admission failure).
   * @param line - complete slash-command line (leading `/` included).
   * @returns the settled command result text, or `undefined` on admission miss.
   */
  async executeCommand(line) {
    const commands = this.#services.commands;
    if (commands === undefined || this.agent === null) return undefined;
    const signal = new AbortController().signal;
    try {
      const execution = await commands.execute(this.agent, line, signal);
      if (execution === undefined) return undefined;
      const result = execution.result;
      return result.kind === "error"
        ? `command error: ${result.text ?? "unknown error"}`
        : result.text ?? `ok`;
    } catch (error) {
      return `command failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Switch the session's permission preset (sandbox mode + approval policy). */
  switchPermission(name) {
    const presets = this.#services.permissionPresets;
    const approval = this.#services.approval;
    if (presets === undefined || this.agent === null) return;
    presets.apply(this.agent.session, name, (policy) => {
      approval?.setPolicy(this.agent, policy);
    });
    this.permissionLabel = name;
    return name;
  }

  dispose() {
    // Only stop the poll timer here; the cordis tree owns agent/session
    // teardown and is disposed by the runner's exit handler.
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}
