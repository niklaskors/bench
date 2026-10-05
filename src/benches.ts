// Benches: creating one for a branch, finding them, and removing them.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { knownRepos, settings, type Repo } from "./config.ts";
import { discard } from "./files.ts";
import { defaultBase, git, hasRef, worktrees, type Worktree } from "./git.ts";
import { readHistory, remember, updateHistory, type RemovedBench } from "./history.ts";
import { BenchError, progress, tilde } from "./log.ts";
import { mergeRequest, type MergeRequest } from "./mr.ts";
import { inPool, refreshInBackground, takeWarmBench } from "./pool.ts";

export interface NewBench {
  repo: string;
  branch: string;
  path: string;
  /** False when the branch already had a worktree, which is then reused. */
  created: boolean;
  /** Where the branch came from: the local branch, the remote one, or the base it was made from. */
  from?: string;
  /** Made from a warm bench of the pool. */
  warm?: boolean;
}

/** The directory name for a branch: feat/PROJ-1-x becomes feat-PROJ-1-x. */
const dirName = (branch: string) => branch.replace(/[^\w.-]+/g, "-");

/** Give `branch` a bench: reuse its worktree, else check out the local or remote branch, else branch off the base. */
export async function newBench(repo: Repo, branch: string, from?: string): Promise<NewBench> {
  await git(repo.path, "check-ref-format", "--branch", branch);
  const existing = (await worktrees(repo)).find((w) => w.branch === branch);
  if (existing) {
    progress(`${branch} already has a bench`);
    return { repo: repo.name, branch, path: existing.path, created: false };
  }
  const path = join(settings().root, repo.name, dirName(branch));
  if (existsSync(path)) throw new BenchError(`${tilde(path)} already exists but isn't a worktree of ${branch}`);

  const { remote } = repo;
  const base = from ?? repo.base ?? await defaultBase(repo);
  progress(`fetching ${base} from ${remote}`);
  // both are network round trips, so run them side by side
  const [, onRemote] = await Promise.all([
    git(repo.path, "fetch", "--quiet", remote, base)
      .catch((e: Error) => progress(`fetch failed, carrying on with what's here (${e.message})`)),
    git(repo.path, "ls-remote", "--heads", remote, `refs/heads/${branch}`).then((out) => out !== "", () => false),
  ]);

  await mkdir(dirname(path), { recursive: true });
  const local = await hasRef(repo.path, `refs/heads/${branch}`);
  let start, track;
  if (local) {
    start = branch;
  } else if (onRemote) {
    start = `${remote}/${branch}`;
    track = "--track";
    await git(repo.path, "fetch", "--quiet", remote, `refs/heads/${branch}:refs/remotes/${start}`);
  } else {
    start = await hasRef(repo.path, `refs/remotes/${remote}/${base}`) ? `${remote}/${base}` : base;
    track = "--no-track";
  }
  const doing = local ? `checking out the local ${branch}` : onRemote ? `checking out ${start}` : `creating ${branch} from ${start}`;

  const warm = repo.pool ? await takeWarmBench(repo) : undefined;
  if (warm) {
    progress(`${doing} in a warm bench, moved to ${tilde(path)}`);
    try {
      await git(warm.path, "switch", ...local ? [branch] : [track!, "-c", branch, start]);
      await git(repo.path, "worktree", "move", warm.path, path);
    } finally {
      await warm.done();
    }
  } else {
    progress(`${doing} in ${tilde(path)}${repo.pool ? " (no warm bench ready)" : ""}`);
    await git(repo.path, "worktree", "add", ...local ? [path, branch] : [track!, "-b", branch, path, start]);
  }
  if (repo.pool) refreshInBackground(repo);
  return { repo: repo.name, branch, path, created: true, from: start, warm: !!warm };
}

/** The benches (worktrees other than the main checkout) of the given repos, or of every known repo. */
export async function benches(repos?: Repo[]): Promise<Worktree[]> {
  const all = await Promise.all((repos ?? await knownRepos()).map(worktrees));
  return all.flat().filter((w) => !w.main && !inPool(w.repo, w.path));
}

/** A bench that was removed: its files are gone, but bench remembers its branch and merge request. */
export interface PastBench extends Worktree {
  branch: string;
  removed: string;
  entry: RemovedBench;
}

/** The removed benches of these repos, except branches that have a bench again. */
export function pastBenches(repos: Repo[], active: Worktree[]): PastBench[] {
  return readHistory().flatMap((entry) => {
    const repo = repos.find((r) => r.path === entry.repoPath);
    if (!repo || active.some((w) => w.repo.path === repo.path && w.branch === entry.branch)) return [];
    return [{ repo, path: entry.path, branch: entry.branch, main: false, removed: entry.removed, entry }];
  });
}

export const isPast = (bench: Worktree): bench is PastBench => "removed" in bench;

/**
 * The merge requests of these benches, looked up side by side. A removed bench's merged or closed merge request
 * is taken from the history, since it won't change; open ones are looked up again and stored.
 * A lookup that fails gives undefined, and `failed` gets its message.
 */
export async function mergeRequests(list: Worktree[], failed: (message: string) => void = () => {}):
  Promise<(MergeRequest | null | undefined)[]> {
  const updates: RemovedBench[] = [];
  const mrs = await Promise.all(list.map(async (bench) => {
    if (!bench.branch) return null;
    if (isPast(bench) && bench.entry.mr && bench.entry.mr.state !== "open") return bench.entry.mr;
    try {
      const mr = await mergeRequest(bench.repo, bench.branch);
      if (isPast(bench)) updates.push({ ...bench.entry, mr });
      return mr;
    } catch (e) {
      failed((e as Error).message);
      return isPast(bench) ? bench.entry.mr : undefined;
    }
  }));
  await updateHistory(updates);
  return mrs;
}

/** The one bench whose branch is `query`, or else contains it (ignoring case). */
export function pick(list: Worktree[], query: string): Worktree {
  const exact = list.filter((w) => w.branch === query);
  const q = query.toLowerCase();
  const hits = exact.length ? exact
    : list.filter((w) => (w.branch ?? basename(w.path)).toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new BenchError(`no bench matches "${query}"`);
  const lines = hits.map((w) => `  ${w.repo.name}  ${w.branch ?? "(detached)"}  ${tilde(w.path)}`);
  throw new BenchError(`"${query}" matches ${hits.length} benches:\n${lines.join("\n")}`);
}

/**
 * Remove a bench. Refuses uncommitted changes and commits that aren't on the remote unless forced.
 * The directory is moved aside and deleted in the background, since node_modules can take a while.
 */
export async function removeBench(bench: Worktree, { force = false, deleteBranch = false } = {}): Promise<void> {
  const { repo, path, branch } = bench;
  if (!force) {
    if (await git(path, "status", "--porcelain")) {
      throw new BenchError(`${tilde(path)} has uncommitted changes (use --force to remove anyway)`);
    }
    const unpushed = Number(await git(path, "rev-list", "--count", "HEAD", "--not", `--remotes=${repo.remote}`));
    if (unpushed) {
      throw new BenchError(`${tilde(path)} has ${unpushed} commit(s) that aren't on ${repo.remote} (use --force to remove anyway)`);
    }
  }
  // remembered, so its merge request can still be found once the files are gone
  const mr = branch ? await mergeRequest(repo, branch).catch(() => undefined) : undefined;
  await discard(path);
  await git(repo.path, "worktree", "prune");
  if (branch) await remember({ repo: repo.name, repoPath: repo.path, branch, path, removed: new Date().toISOString(), mr });
  if (deleteBranch && branch) await git(repo.path, "branch", "-D", branch);
  progress(`removed ${tilde(path)}${branch ? `; branch ${branch} ${deleteBranch ? "deleted" : "kept"}` : ""}`);
}
