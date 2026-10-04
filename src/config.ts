// Settings: the personal config file, each repo's shared .bench.json, and which repo a command works in.

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { git } from "./git.ts";
import { BenchError, tilde } from "./log.ts";

export const OPEN_MODES = ["none", "here", "tab"] as const;
export type OpenMode = (typeof OPEN_MODES)[number];

/** What a repo can share with its team in a committed .bench.json (and override in the personal config). */
interface RepoSettings {
  /** Branch new branches start from (default: the remote's HEAD). */
  base?: string;
  remote?: string;
  /** Untracked paths or globs to copy from the main checkout, copy-on-write where the disk allows. */
  copy?: string[];
  /** Shell command run in a new bench after copying, e.g. a frozen-lockfile install. */
  setup?: string;
  /** Environment for the setup command. */
  env?: Record<string, string>;
}

interface ConfigFile {
  default?: string;
  root?: string;
  open?: OpenMode;
  command?: string;
  repos?: Record<string, RepoSettings & { path: string }>;
}

export interface Repo {
  name: string;
  /** The main checkout. */
  path: string;
  base?: string;
  remote: string;
  copy: string[];
  setup?: string;
  env: Record<string, string>;
}

export const expandHome = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

export const CONFIG_PATH = process.env.BENCH_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bench", "config.json");

function readJson<T>(path: string): T | undefined {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new BenchError(`${tilde(path)}: ${(e as Error).message}`);
  }
}

let loaded: ConfigFile | undefined;
const config = () => (loaded ??= readJson<ConfigFile>(CONFIG_PATH) ?? {});

export const settings = () => {
  const c = config();
  if (c.open && !OPEN_MODES.includes(c.open)) {
    throw new BenchError(`${tilde(CONFIG_PATH)}: "open" must be one of ${OPEN_MODES.join(", ")}`);
  }
  return {
    /** Benches live in <root>/<repo name>/<branch>. */
    root: expandHome(c.root ?? "~/benches"),
    open: c.open ?? "none",
    command: c.command,
    default: c.default,
  };
};

function makeRepo(name: string, path: string, own: RepoSettings = {}): Repo {
  const shared = readJson<RepoSettings>(join(path, ".bench.json")) ?? {};
  const s = { ...shared, ...own };
  const env = Object.fromEntries(Object.entries({ ...shared.env, ...own.env }).map(([k, v]) => [k, expandHome(v)]));
  return { name, path, base: s.base, remote: s.remote ?? "origin", copy: s.copy ?? [], setup: s.setup, env };
}

export function configuredRepos(): Repo[] {
  return Object.entries(config().repos ?? {}).map(([name, r]) => {
    let path;
    try {
      path = realpathSync(expandHome(r.path));
    } catch {
      throw new BenchError(`repo "${name}" in ${tilde(CONFIG_PATH)}: ${r.path} doesn't exist`);
    }
    return makeRepo(name, path, r);
  });
}

/** The main checkout of the repository around `dir` (also when `dir` is in one of its worktrees). */
async function mainCheckout(dir: string): Promise<string | undefined> {
  const common = await git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir").catch(() => "");
  // a bare repository has no checkout of its own
  return basename(common) === ".git" ? realpathSync(dirname(common)) : undefined;
}

/** The repo around `dir`: its configured entry, or an unconfigured one named after its directory. */
export async function repoAt(dir: string): Promise<Repo | undefined> {
  const main = await mainCheckout(dir);
  if (!main) return undefined;
  return configuredRepos().find((r) => r.path === main) ?? makeRepo(basename(main), main);
}

/** The repo to work in: --repo (a configured name or a path), else the one around the current directory, else the default. */
export async function resolveRepo(arg?: string): Promise<Repo> {
  const repos = configuredRepos();
  if (arg) {
    const named = repos.find((r) => r.name === arg) ?? await repoAt(resolve(expandHome(arg)));
    if (named) return named;
    const names = repos.length ? ` (configured: ${repos.map((r) => r.name).join(", ")})` : "";
    throw new BenchError(`unknown repo "${arg}": not a configured name${names} nor a git repository`);
  }
  const here = await repoAt(process.cwd());
  if (here) return here;
  const name = settings().default;
  if (name) {
    const repo = repos.find((r) => r.name === name);
    if (!repo) throw new BenchError(`default repo "${name}" isn't in "repos" in ${tilde(CONFIG_PATH)}`);
    return repo;
  }
  if (repos.length === 1) return repos[0];
  throw new BenchError(`which repo? Run bench inside one, pass --repo, or set "default" in ${tilde(CONFIG_PATH)}`);
}

/** Every repo bench knows: the configured ones plus the one around the current directory. */
export async function knownRepos(): Promise<Repo[]> {
  const repos = configuredRepos();
  const here = await repoAt(process.cwd());
  return here && !repos.some((r) => r.path === here.path) ? [...repos, here] : repos;
}
