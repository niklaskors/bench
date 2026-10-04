// Starting work in a bench: a command in this terminal, or a new terminal tab.

import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { OpenMode } from "./config.ts";
import { BenchError, shellQuote } from "./log.ts";

const execFileP = promisify(execFile);

const appleString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** AppleScript that types `line` into a new tab of the terminal bench runs in. */
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
      throw new BenchError(`--open tab works in iTerm2 and Terminal on macOS; use --open here (TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ""})`);
  }
}

/**
 * Start `command` (or a shell) in the bench. With `setupFirst`, `bench setup` runs before it,
 * so a new tab shows the install while the caller has already moved on.
 */
export async function openBench(path: string, mode: OpenMode, command: string | undefined, setupFirst = false): Promise<void> {
  if (mode === "tab") {
    const self = shellQuote(realpathSync(process.argv[1]));
    const line = [`cd ${shellQuote(path)}`, setupFirst && `${self} setup`, command].filter(Boolean).join(" && ");
    await execFileP("osascript", ["-e", newTabScript(line)]);
  } else if (mode === "here") {
    const shell = process.env.SHELL || "sh";
    const child = command ? spawn(command, { shell, cwd: path, stdio: "inherit" })
      : spawn(shell, { cwd: path, stdio: "inherit" });
    process.exitCode = await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
  }
}
