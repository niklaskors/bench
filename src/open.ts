// Starting work in a bench: a command in this terminal, or a new terminal tab.

import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { settings, type OpenMode } from "./config.ts";
import { BenchError, shellQuote } from "./log.ts";

const execFileP = promisify(execFile);

const appleString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** The cmux command line tool: on the PATH in cmux's own terminals, else in the app. */
const CMUX_APP_CLI = "/Applications/cmux.app/Contents/Resources/bin/cmux";

/**
 * Types `line` into a new tab of the terminal bench runs in, innermost first: tmux (a new window), as it may run
 * inside the others; then cmux (a new workspace), which reports itself as Ghostty; then the macOS terminals.
 */
async function openTab(line: string, path: string, title?: string): Promise<void> {
  if (process.env.TMUX) {
    const { stdout } = await execFileP("tmux", ["new-window", "-P", "-F", "#{pane_id}", "-c", path,
      ...title ? ["-n", title] : []]);
    await execFileP("tmux", ["send-keys", "-t", stdout.trim(), "-l", line]);
    await execFileP("tmux", ["send-keys", "-t", stdout.trim(), "Enter"]);
  } else if (process.env.CMUX_WORKSPACE_ID) {
    const cli = existsSync(CMUX_APP_CLI) ? CMUX_APP_CLI : "cmux";
    await execFileP(cli, ["workspace", "create", "--cwd", path, "--command", line, "--focus", "true",
      ...title ? ["--name", title] : []], { env: { ...process.env, CMUX_QUIET: "1" } });
  } else {
    await execFileP("osascript", ["-e", newTabScript(line)]);
  }
}

/** AppleScript that types `line` into a new tab of the terminal bench runs in, for the macOS terminals bench knows. */
function newTabScript(line: string): string {
  switch (process.env.TERM_PROGRAM) {
    case "iTerm.app":
      return `tell application "iTerm"
        if (count of windows) = 0 then
          create window with default profile
        else
          tell current window to create tab with default profile
        end if
        tell current session of current window to write text ${appleString(line)}
      end tell`;
    case "Apple_Terminal":
      // Terminal can't open a tab without UI scripting, so this is a new window
      return `tell application "Terminal"
        activate
        do script ${appleString(line)}
      end tell`;
    default:
      throw new BenchError(`--open tab knows cmux, tmux, iTerm2 and Terminal; for others set "tab" in the config (TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""})`);
  }
}

/** Open a URL in the default browser. */
export async function openUrl(url: string): Promise<void> {
  await execFileP(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

/** The escape sequence that sets the terminal's tab and window title; control characters are left out. */
const titleSequence = (title: string) => `\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, " ")}\x07`;

/**
 * Shell code that gives the tab `title` and keeps it: oh-my-zsh sets the title at every prompt unless
 * DISABLE_AUTO_TITLE is true, which is only a variable to other shells.
 */
const setTitle = (title: string) =>
  // the line is typed into the tab, so it spells the escape characters out for printf
  `DISABLE_AUTO_TITLE=true; printf '\\033]0;%s\\007' ${shellQuote(title.replace(/[\x00-\x1f\x7f]/g, " "))}`;

/**
 * Start `command` (or a shell) in the bench. With `setupFirst`, `bench setup` runs before it,
 * so a new tab shows the install while the caller has already moved on. `title` names the tab; `assistant`
 * goes to a custom "tab" command as $BENCH_ASSISTANT.
 */
export async function openBench(path: string, mode: OpenMode, command: string | undefined, setupFirst = false,
  title?: string, assistant?: string): Promise<void> {
  if (mode === "tab") {
    const self = shellQuote(realpathSync(process.argv[1]));
    const run = [`cd ${shellQuote(path)}`, setupFirst && `${self} setup`, command].filter(Boolean).join(" && ");
    const line = title ? `${setTitle(title)}; ${run}` : run;
    const custom = settings().tab;
    if (!custom) await openTab(line, path, title);
    else {
      const env = { ...process.env, BENCH_PATH: path, BENCH_RUN: line, ...title && { BENCH_TITLE: title },
        ...assistant && { BENCH_ASSISTANT: assistant } };
      await execFileP(process.env.SHELL || "sh", ["-c", custom], { env });
    }
  } else if (mode === "here") {
    if (title && process.stdout.isTTY) process.stdout.write(titleSequence(title));
    const shell = process.env.SHELL || "sh";
    const child = command ? spawn(command, { shell, cwd: path, stdio: "inherit" })
      : spawn(shell, { cwd: path, stdio: "inherit" });
    process.exitCode = await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
  }
}
