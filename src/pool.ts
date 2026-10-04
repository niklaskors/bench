// The pool: warm benches on the base branch with packages installed, so a new bench only has to switch branches.
//
// A warm bench lives in <root>/<repo>/.pool/<id>, next to <id>.json (its state) and, while a process works on it,
// <id>.lock (that process's pid). Refreshing keeps the warm benches on the latest base with matching packages and
// tops the pool up; taking one moves it out of .pool, which is all it takes for refreshes to leave it alone.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { settings, type Repo } from "./config.ts";
import { discard } from "./files.ts";
import { defaultBase, git, hasRef } from "./git.ts";
import { progress, tilde } from "./log.ts";
import { prepareBench } from "./setup.ts";

interface State {
  state: "warming" | "ready";
  /** The commit the bench is on. */
  head?: string;
  /** When it was created or last brought up to date (ISO time). */
  updated: string;
}

export interface WarmBench {
  id: string;
  path: string;
  state?: State;
  /** Some process is working on it right now. */
  busy: boolean;
}

export const poolDir = (repo: Repo) => join(settings().root, repo.name, ".pool");

/** Whether a worktree is a warm bench rather than a bench in use. */
export const inPool = (repo: Repo, path: string) => path.startsWith(poolDir(repo) + sep);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const lockOwner = async (file: string) => Number(await readFile(file, "utf8").catch(() => "0"));

/** Take a lock file; a lock whose process is gone is taken over. */
async function lock(file: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const owner = await lockOwner(file);
    if (owner && alive(owner)) return false;
    await rm(file, { force: true });
  }
  return false;
}

const files = (repo: Repo, id: string) => {
  const base = join(poolDir(repo), id);
  return { path: base, state: `${base}.json`, lock: `${base}.lock` };
};

async function writeState(repo: Repo, id: string, state: State): Promise<void> {
  const file = files(repo, id).state;
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${file}.tmp`, file);
}

/** The warm benches of a repo. */
export async function warmBenches(repo: Repo): Promise<WarmBench[]> {
  const names = await readdir(poolDir(repo), { withFileTypes: true }).catch(() => []);
  return Promise.all(names.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map(async ({ name: id }) => {
    const f = files(repo, id);
    const state = await readFile(f.state, "utf8").then((s) => JSON.parse(s) as State, () => undefined);
    const owner = await lockOwner(f.lock);
    return { id, path: f.path, state, busy: !!owner && alive(owner) };
  }));
}

/** Delete a warm bench; the caller holds its lock. */
async function drop(repo: Repo, id: string): Promise<void> {
  const f = files(repo, id);
  if (existsSync(f.path)) await discard(f.path);
  await git(repo.path, "worktree", "prune");
  await rm(f.state, { force: true });
  await rm(f.lock, { force: true });
}

/**
 * Take a ready warm bench out of the pool for a new bench, or undefined when there is none.
 * The caller moves it away and then calls `done`; until then the bench's lock keeps refreshes off it.
 */
export async function takeWarmBench(repo: Repo): Promise<{ path: string; done(): Promise<void> } | undefined> {
  for (const bench of await warmBenches(repo)) {
    if (bench.state?.state !== "ready" || bench.busy || !await lock(files(repo, bench.id).lock)) continue;
    const f = files(repo, bench.id);
    return {
      path: f.path,
      done: async () => {
        await rm(f.state, { force: true });
        await rm(f.lock, { force: true });
      },
    };
  }
  return undefined;
}

/** Refresh the repo's pool in a background process, e.g. after taking a warm bench; it logs to .pool/refresh.log. */
export function refreshInBackground(repo: Repo): void {
  mkdirSync(poolDir(repo), { recursive: true });
  const log = openSync(join(poolDir(repo), "refresh.log"), "a");
  spawn(realpathSync(process.argv[1]), ["pool", "refresh", "--repo", repo.path], {
    stdio: ["ignore", log, log],
    detached: true,
  }).unref();
}

/** Bring a ready warm bench to `start` and install packages if its lockfile changed; one that fails is dropped. */
async function update(repo: Repo, bench: WarmBench, start: string, commit: string): Promise<void> {
  try {
    if (await git(bench.path, "rev-parse", "HEAD") !== commit) {
      progress(`${bench.id}: moving to ${start}`);
      await git(bench.path, "checkout", "--force", "--detach", commit);
    }
    await prepareBench(repo, bench.path, { setup: false });
    await writeState(repo, bench.id, { state: "ready", head: commit, updated: new Date().toISOString() });
  } catch (e) {
    progress(`${bench.id}: ${(e as Error).message}; dropping it`);
    await drop(repo, bench.id);
  }
}

/** Create a warm bench on `start`; throws when that fails, so a broken setup doesn't retry endlessly. */
async function warm(repo: Repo, start: string, commit: string): Promise<void> {
  const id = Date.now().toString(36);
  const f = files(repo, id);
  await lock(f.lock);
  await writeState(repo, id, { state: "warming", head: commit, updated: new Date().toISOString() });
  try {
    progress(`${id}: warming a bench on ${start} in ${tilde(f.path)}`);
    await git(repo.path, "worktree", "add", "--detach", f.path, commit);
    await prepareBench(repo, f.path, { setup: false });
    await writeState(repo, id, { state: "ready", head: commit, updated: new Date().toISOString() });
    await rm(f.lock, { force: true });
    progress(`${id}: ready`);
  } catch (e) {
    await drop(repo, id);
    throw e;
  }
}

/** Remove what interrupted refreshes left behind: warm benches that never got ready, state without a bench. */
async function cleanUp(repo: Repo): Promise<void> {
  for (const bench of await warmBenches(repo)) {
    if (bench.state?.state === "ready" || bench.busy) continue;
    progress(`${bench.id}: removing an unfinished warm bench`);
    await drop(repo, bench.id);
  }
  for (const name of await readdir(poolDir(repo))) {
    const id = name.replace(/\.(json|lock)$/, "");
    if (id !== name && id !== "refresh" && !existsSync(join(poolDir(repo), id))) await rm(join(poolDir(repo), name));
  }
}

/**
 * Bring the repo's warm benches up to date with the base branch and top the pool up to its size (or shrink it).
 * Only one refresh per repo runs at a time; others return at once, as the running one picks up their work.
 */
export async function refreshPool(repo: Repo): Promise<void> {
  const dir = poolDir(repo);
  if (!repo.pool && !existsSync(dir)) return;
  await mkdir(dir, { recursive: true });
  const repoLock = join(dir, "refresh.lock");
  if (!await lock(repoLock)) {
    progress(`${repo.name}: a refresh is already running`);
    return;
  }
  try {
    await cleanUp(repo);
    const base = repo.base ?? await defaultBase(repo);
    await git(repo.path, "fetch", "--quiet", repo.remote, base)
      .catch((e: Error) => progress(`fetch failed, carrying on with what's here (${e.message})`));
    const start = await hasRef(repo.path, `refs/remotes/${repo.remote}/${base}`) ? `${repo.remote}/${base}` : base;
    const commit = await git(repo.path, "rev-parse", start);

    for (const bench of await warmBenches(repo)) {
      if (bench.state?.state !== "ready" || bench.busy || !await lock(files(repo, bench.id).lock)) continue;
      if ((await warmBenches(repo)).length > repo.pool) {
        progress(`${bench.id}: removing, the pool is bigger than ${repo.pool}`);
        await drop(repo, bench.id);
        continue;
      }
      await update(repo, bench, start, commit);
      await rm(files(repo, bench.id).lock, { force: true });
    }
    // checked each round, since benches can be taken while this runs
    while ((await warmBenches(repo)).length < repo.pool) await warm(repo, start, commit);
  } finally {
    await rm(repoLock, { force: true });
  }
}
