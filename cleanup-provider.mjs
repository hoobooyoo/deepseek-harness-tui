// remove the test provider written during verification
import { boot, loadProfile, loadOptionalPatches } from "@deepseek-ai/dsh-app-boot";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const appPkg = require.resolve("@deepseek-ai/dsh/package.json");
const home = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
const profile = loadProfile("cleanup", "deepcode", appPkg, home);
const patches = [...profile.layers.flatMap((l) => l.patches), ...(loadOptionalPatches("cleanup", profile.patchPath) ?? [])];
const ctx = await boot("cleanup", join(profile.dir, "cordis.yml"), patches);
await ctx.get("loader")?.await();
const settings = ctx.get("settings");
const credentials = ctx.get("credentials");
const { settingsNamespace } = await import("@deepseek-ai/dsh-settings");
const { credentialRef } = await import("@deepseek-ai/dsh-credentials");
const ns = settingsNamespace("llm-pi-ai");
const providers = settings.get(ns)?.providers ?? {};
if (providers.mygate !== undefined) {
  const next = { ...providers };
  delete next.mygate;
  await settings.replace(ns, { providers: next });
  console.error("removed mygate from settings");
}
try { await credentials.unset(credentialRef("MYGATE_API_KEY")); console.error("removed MYGATE_API_KEY credential"); } catch (e) { console.error("cred unset:", String(e)); }
await ctx.root.fiber.dispose();
process.exit(0);
