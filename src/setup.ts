// Making a bench ready: copy untracked files from the main checkout, install packages, run the setup command.

import { existsSync } from "node:fs";
import { glob, mkdir, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { repoAt, type Repo } from "./config.ts";
import { clone, runShell } from "./files.ts";
import { git } from "./git.ts";
import { BenchError, progress, tilde } from "./log.ts";
import { detectPackages, installPackages } from "./packages.ts";

/** Copy these paths (or globs) from the main checkout where the bench doesn't have them. */
async function copyFromMain(repo: Repo, bench: string, patterns: string[]): Promise<void> {
  const found = new Set<string>();
  for (const pattern of patterns) {
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
    for (const [from, to] of next) await clone(from, to);
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}

/**
 * Make the checkout at `bench` ready to work in. Packages install only when the lockfile changed since the last install,
 * and a missing node_modules starts as a copy of the main checkout's, so the install has little left to do.
 * `setup: false` leaves out the repo's setup command (for warm benches, which don't have their branch yet).
 */
export async function prepareBench(repo: Repo, bench: string, { setup = true } = {}): Promise<void> {
  const detected = repo.install === false ? undefined : detectPackages(bench);
  // a command in "install" replaces the detected one (e.g. for another Node version manager)
  const custom = typeof repo.install === "string" ? repo.install : undefined;
  const packages = detected && custom ? { ...detected, command: custom } : detected;
  // npm ci starts by deleting node_modules, so there's no point copying it
  const seed = packages && packages.manager !== "npm" ? ["node_modules"] : [];
  await copyFromMain(repo, bench, [...repo.copy, ...seed]);
  if (packages) await installPackages(bench, packages, repo.env);
  else if (custom) {
    // without a lockfile there's no telling whether anything changed, so it runs every time
    progress(`installing packages: ${custom}`);
    await runShell(custom, bench, repo.env);
  }
  if (setup && repo.setup) {
    progress(`running ${repo.setup}`);
    await runShell(repo.setup, bench, repo.env);
  }
}

/** `bench setup`: prepare the bench at `dir`. */
export async function setupBench(dir: string): Promise<void> {
  const repo = await repoAt(dir);
  if (!repo) throw new BenchError(`${tilde(dir)} isn't in a git repository`);
  const bench = await git(dir, "rev-parse", "--show-toplevel");
  if (bench === repo.path) throw new BenchError(`${tilde(bench)} is the main checkout, not a bench`);
  await prepareBench(repo, bench);
}
