// Copying and deleting big directories, and running shell commands.

import { execFile, spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { BenchError } from "./log.ts";

const execFileP = promisify(execFile);

/** Copy-on-write on APFS (macOS) and btrfs/XFS (Linux), so even node_modules takes no extra disk. */
const CLONE = process.platform === "darwin" ? ["-c", "-R"] : ["-R", "--reflink=auto"];

export async function clone(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await execFileP("cp", [...CLONE, from, to]);
  } catch {
    // e.g. the benches are on another volume, where cloning isn't possible
    await rm(to, { recursive: true, force: true });
    await execFileP("cp", ["-R", from, to]);
  }
}

/** Delete a directory without waiting: move it aside, then remove it in the background. */
export async function discard(path: string): Promise<void> {
  const trash = join(dirname(path), `.${basename(path)}.removing-${Date.now()}`);
  await rename(path, trash);
  spawn("rm", ["-rf", trash], { stdio: "ignore", detached: true }).unref();
}

/** Run a shell command; its output goes to stderr, keeping stdout for bench's result. */
export function runShell(command: string, cwd: string, env: Record<string, string> = {}): Promise<void> {
  return new Promise((done, fail) => {
    spawn(command, { shell: true, cwd, env: { ...process.env, ...env }, stdio: ["inherit", 2, 2] })
      .on("error", fail)
      .on("exit", (code) => code === 0 ? done() : fail(new BenchError(`failed (exit ${code}): ${command}`)));
  });
}
