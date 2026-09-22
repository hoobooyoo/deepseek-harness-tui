/**
 * deepcode TUI runner — a Cordis bundle plugin that drives one live Agent
 * through the core registry and renders an opencode-style terminal UI.
 *
 * Mounted by `cordis.patch.yml` under the `tui-runner` row.
 *
 * @module deepcode
 */

import { AgentController } from "./controller.js";
import { renderTui } from "./app.js";

export const name = "deepcode-tui-runner";
export const inject = ["agents", "agentDefaultModel", "sessions"];

export function apply(ctx) {
  const controller = new AgentController({
    agents: ctx.agents,
    agentDefaultModel: ctx.agentDefaultModel,
    sessions: ctx.sessions,
  });

  // Optional host-plane services are resolved lazily: at apply time sibling
  // plugins may not have mounted yet, so `ctx.get` could return undefined.
  // Re-read them after the loader settles (everything is mounted then).
  const resolveOptionalServices = () => {
    controller.setServices({
      agentPresets: ctx.get("agentPresets"),
      userQuestions: ctx.get("userQuestions"),
      llm: ctx.get("llm"),
      sessionQuery: ctx.get("sessionQuery"),
      sessionProjections: ctx.get("sessionProjections"),
      sessionTitle: ctx.get("sessionTitle"),
      tools: ctx.get("tools"),
      atFile: ctx.get("atFile"),
      workspaceRegistry: ctx.get("workspaceRegistry"),
      settings: ctx.get("settings"),
      credentials: ctx.get("credentials"),
      permissionPresets: ctx.get("permissionPresets"),
      approval: ctx.get("approval"),
      commands: ctx.get("commands"),
    });
  };

  // Answerer for tool approvals (sandbox escalation, etc.), registered on the
  // root so it sees events emitted by the approval row (a sibling subtree).
  ctx.root.on("approval/request", (req, next) => {
    if (controller.approvalHandler === null) return next();
    return controller
      .approvalHandler(req)
      .then((ok) => (ok ? "allowed-once" : "rejected"));
  });

  // Answerer for the model-facing `ask_user_question` tool. The harness
  // dispatches a scoped `user-questions/request` waterfall (the earlier
  // `userQuestions.registerProvider` seam is gone in rc.5+), so the TUI
  // claims every request by answering it; registered on the root so
  // agent-scoped requests reach this single TUI answerer.
  ctx.root.on("user-questions/request", (request, next) => {
    if (controller.questionsHandler === null) return next();
    return controller.questionsHandler(request);
  });

  // Wait for the tree to settle before creating the agent and taking over the
  // terminal, so boot diagnostics cannot corrupt the UI.
  void (async () => {
    await ctx.get("loader")?.await();
    resolveOptionalServices();
    await controller.start();
    // Sessions created before this profile composed the workspace row were
    // never attached to their workspace, so the web sidebar lists them under
    // "未分组". Claim them once per process (idempotent, best-effort).
    void controller.backfillWorkspaceMembership();
    if (process.env.DEEPCODE_SMOKE === "1") {
      // Headless smoke check: prove boot + agent creation + preset mount work
      // without needing a TTY. The real UI is skipped.
      process.stderr.write(`deepcode: ready (${controller.modelLabel})\n`);
      process.exit(0);
    }
    renderTui(controller, async () => {
      controller.dispose();
      await ctx.root.fiber.dispose();
      process.exit(0);
    });
  })();
}
