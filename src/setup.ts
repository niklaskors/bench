// Making a fresh bench ready: copy untracked files from the main checkout, then run the repo's setup command.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { glob, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { repoAt, type Repo } from "./config.ts";
import { git } from "./git.ts";
import { BenchError, progress, tilde } from "./log.ts";

const execFileP = promisify(execFile);

/** Copy-on-write on APFS (macOS) and btrfs/XFS (Linux), so even node_modules copies in seconds without using disk. */
const CLONE = process.platform === "darwin" ? ["-c", "-R"] : ["-R", "--reflink=auto"];

async function copy(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await execFileP("cp", [...CLONE, from, to]);
  } catch {
    // e.g. the benches are on another volume, where cloning isn't possible
    await rm(to, { recursive: true, force: true });
    await execFileP("cp", ["-R", from, to]);
  }
}

/** Copy the repo's `copy` paths from the main checkout into the bench where the bench doesn't have them. */
async function copyFromMain(repo: Repo, bench: string): Promise<void> {
  const found = new Set<string>();
  for (const pattern of repo.copy) {
    for await (const path of glob(pattern, { cwd: repo.path })) found.add(path);
  }
  // a path inside another one is copied with it
  const paths = [...found].filter((p, _, all) => !all.some((q) => p.startsWith(q + sep)))
    .filter((p) => !existsSync(join(bench, p)));
  if (!paths.length) return;
  progress(`copying ${paths.length > 4 ? `${paths.length} paths` : paths.join(", ")} from ${tilde(repo.path)}`);
  // copying is bound by per-file work, not data, so big directories go entry by entry, several at a time
  const jobs: [string, string][] = [];
  for (const p of paths) {
    const [from, to] = [join(repo.path, p), join(bench, p)];
    if (!(await stat(from)).isDirectory()) jobs.push([from, to]);
    else {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from)) jobs.push([join(from, entry), join(to, entry)]);
    }
  }
  const next = jobs.values();
  const worker = async () => {
    for (const [from, to] of next) await copy(from, to);
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

function runSetup(repo: Repo, bench: string): Promise<void> {
  progress(`running ${repo.setup}`);
  return new Promise((done, fail) => {
    // the command's output goes to stderr too, keeping stdout for bench's result
    spawn(repo.setup!, { shell: true, cwd: bench, env: { ...process.env, ...repo.env }, stdio: ["inherit", 2, 2] })
      .on("error", fail)
      .on("exit", (code) => code === 0 ? done() : fail(new BenchError(`setup failed (exit ${code}): ${repo.setup}`)));
  });
}

/** Set up the bench at `dir`. */
export async function setupBench(dir: string): Promise<void> {
  const repo = await repoAt(dir);
  if (!repo) throw new BenchError(`${tilde(dir)} isn't in a git repository`);
  const bench = await git(dir, "rev-parse", "--show-toplevel");
  if (bench === repo.path) throw new BenchError(`${tilde(bench)} is the main checkout, not a bench`);
  await copyFromMain(repo, bench);
  if (repo.setup) await runSetup(repo, bench);
}
