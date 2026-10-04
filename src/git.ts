// Running git and reading a repository's worktrees.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repo } from "./config.ts";
import { BenchError } from "./log.ts";

const execFileP = promisify(execFile);

/** Run git in `cwd` and return its trimmed output; failures become a BenchError with git's message. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], { maxBuffer: 64 << 20 });
    return stdout.trim();
  } catch (e) {
    const { stderr, message } = e as { stderr?: string; message: string };
    throw new BenchError(`git ${args[0]}: ${(stderr || message).trim().replace(/^(fatal|error): /, "")}`);
  }
}

/** Whether a ref exists, e.g. refs/heads/main. */
export const hasRef = (cwd: string, ref: string) =>
  git(cwd, "rev-parse", "--verify", "--quiet", ref).then(() => true, () => false);

export interface Worktree {
  repo: Repo;
  path: string;
  /** Missing when the worktree is on a detached HEAD. */
  branch?: string;
  /** The repository's own checkout rather than a bench. */
  main: boolean;
}

/** The worktrees of a repository, the main checkout first; ones whose directory is gone are left out. */
export async function worktrees(repo: Repo): Promise<Worktree[]> {
  const out = await git(repo.path, "worktree", "list", "--porcelain");
  return out.split(/\n\n+/).filter(Boolean).flatMap((block, i) => {
    const fields = new Map(block.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
    }));
    if (fields.has("prunable") || fields.has("bare")) return [];
    return [{
      repo,
      path: fields.get("worktree")!,
      branch: fields.get("branch")?.replace(/^refs\/heads\//, ""),
      main: i === 0,
    }];
  });
}
