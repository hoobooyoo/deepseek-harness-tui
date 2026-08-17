#!/usr/bin/env node
/**
 * deepcode — thin launcher for the deepcode TUI profile.
 *
 * Boots the harness launcher (`dsh`) against the `deepcode` profile, which
 * composes `@deepseek-ai/dsh-base` + this bundle. On first run it writes the
 * profile manifest and symlinks this bundle into the profile resolution path,
 * so no separate `dsh plugin` step is required.
 *
 * Terminal takeover: the launcher clears the screen, sets the window title to
 * `deepcode` and hides the cursor before dsh boots, so the bash prompt and the
 * typed command never appear on screen. On exit it restores the saved title,
 * shows the cursor again and clears the screen, handing control back to the
 * bash prompt.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function resolveDshBin() {
  try {
    const pkgPath = require.resolve("@deepseek-ai/dsh/package.json");
    const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
    const rel =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
    if (rel) return join(dirname(pkgPath), rel);
  } catch {
    /* fall through */
  }
  return "dsh";
}

function resolveDshHome() {
  return process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
}

/** Write the profile manifest and symlink this bundle into the fallback path. */
function ensureProfile() {
  const home = resolveDshHome();
  const profileDir = join(home, "profiles", "deepcode");
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    mkdirSync(profileDir, { recursive: true });
    const manifest = {
      name: "dsh-profile-deepcode",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "deepcode"] } },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, void 0, 2) + "\n");
  }

  const fallbackDir = join(home, "profiles", "node_modules");
  mkdirSync(fallbackDir, { recursive: true });
  const link = join(fallbackDir, "deepcode");
  if (!existsSync(link)) {
    try {
      symlinkSync(PACKAGE_ROOT, link, "dir");
    } catch {
      /* a concurrent first run may have created it */
    }
  }

  // Ship the agent presets the deployment uses (standard / code / minimal):
  // copy the harness checkout's `config/agent-presets` into the profile so the
  // preset roster resolves `agent-presets.default` (and any settings override
  // like `code`) exactly like the web app.
  const presetsDir = join(profileDir, "presets");
  if (!existsSync(join(presetsDir, "standard"))) {
    const shipped = findShippedPresets();
    if (shipped !== undefined) {
      try {
        mkdirSync(presetsDir, { recursive: true });
        cpSync(shipped, presetsDir, { recursive: true });
      } catch (err) {
        process.stderr.write(`deepcode: warning: could not copy agent presets: ${err.message}\n`);
      }
    }
  }
}

/** Locate the deployment's shipped agent-presets directory (best effort). */
function findShippedPresets() {
  const candidates = [
    // harness checkout layout (apps/cli/config/agent-presets)
    join(dirname(dirname(PACKAGE_ROOT)), "deepseek-harness", "apps", "cli", "config", "agent-presets"),
    // npm-installed layout beside the dsh app
    join(dirname(resolveDshBin()), "..", "config", "agent-presets"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "standard"))) return candidate;
  }
  return undefined;
}

// ── terminal takeover ───────────────────────────────────────────────────────

const TTY = process.stdout.isTTY === true;

/** Save the window title, then set it to `deepcode` and blank the screen. */
function takeOverTerminal() {
  if (!TTY) return;
  process.stdout.write("\u001b[?1049h"); // alternate screen: no window scrollbar
  process.stdout.write("\u001b[22;0t"); // save window title (xterm)
  process.stdout.write("\u001b]0;deepcode\u0007"); // title: deepcode
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H"); // clear screen + scrollback
  process.stdout.write("\u001b[?25l"); // hide cursor
}

/** Restore the saved title and hand the screen back to bash. */
function restoreTerminal() {
  if (!TTY) return;
  process.stdout.write("\u001b[0m"); // reset attributes
  process.stdout.write("\u001b[?25h"); // show cursor
  process.stdout.write("\u001b[23;0t"); // restore saved window title
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H"); // clear screen + scrollback
  process.stdout.write("\u001b[?1049l"); // leave alternate screen → shell buffer
}

const dshBin = resolveDshBin();
ensureProfile();
takeOverTerminal();

const args = ["--profile", "deepcode", ...process.argv.slice(2)];
const child =
  dshBin === "dsh"
    ? spawn("dsh", args, { stdio: "inherit" })
    : spawn(process.execPath, [dshBin, ...args], { stdio: "inherit" });

child.on("error", (err) => {
  restoreTerminal();
  process.stderr.write(`deepcode: failed to launch dsh: ${err.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  restoreTerminal();
  process.exitCode = code ?? (signal ? 1 : 0);
});
