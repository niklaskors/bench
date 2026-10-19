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

/** The branch the remote's HEAD points at, e.g. main. */
export async function defaultBase(repo: Repo): Promise<string> {
  const head = await git(repo.path, "symbolic-ref", "--quiet", "--short", `refs/remotes/${repo.remote}/HEAD`)
    .catch(() => "");
  return head ? head.slice(repo.remote.length + 1) : "main";
}

/** A branch to start a bench from: local, on the remote, or both. */
export interface Branch {
  name: string;
  local: boolean;
  remote: boolean;
  /** Of its newest commit, local or remote. */
  date: string;
  /** Whether a bench (not the main checkout) has it checked out. */
  bench: boolean;
}

/** The repo's local branches and those of its remote, by name, the most recently committed to first. */
export async function branches(repo: Repo): Promise<Branch[]> {
  const [out, trees] = await Promise.all([
    git(repo.path, "for-each-ref", "--format=%(refname)%09%(committerdate:iso-strict)", "refs/heads", `refs/remotes/${repo.remote}`),
    worktrees(repo),
  ]);
  const benched = new Set(trees.filter((w) => !w.main).map((w) => w.branch));
  const byName = new Map<string, Branch>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [ref, date] = line.split("\t");
    const remote = ref.startsWith("refs/remotes/");
    const name = ref.slice(remote ? `refs/remotes/${repo.remote}/`.length : "refs/heads/".length);
    if (remote && name === "HEAD") continue;
    const branch = byName.get(name) ?? { name, local: false, remote: false, date, bench: benched.has(name) };
    if (remote) branch.remote = true;
    else branch.local = true;
    if (Date.parse(date) > Date.parse(branch.date)) branch.date = date;
    byName.set(name, branch);
  }
  return [...byName.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

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
