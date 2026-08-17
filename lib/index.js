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

  // Answerer for the model-facing `ask_user_question` tool.
  let offQuestions = undefined;
  ctx.on("dispose", () => offQuestions?.());

  // Wait for the tree to settle before creating the agent and taking over the
  // terminal, so boot diagnostics cannot corrupt the UI.
  void (async () => {
    await ctx.get("loader")?.await();
    resolveOptionalServices();
    // the userQuestions provider must exist before the agent can ask
    offQuestions = ctx
      .get("userQuestions")
      ?.registerProvider({
        ask: async (request) => {
          if (controller.questionsHandler === null) {
            throw new Error("deepcode: no TUI answerer mounted yet");
          }
          return await controller.questionsHandler(request);
        },
      });
    await controller.start();
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
