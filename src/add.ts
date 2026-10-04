// `bench add`: set a repo up for benches, cloning it first if given a URL.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { configuredRepos, expandHome, mainCheckout, saveRepo, settings } from "./config.ts";
import { git } from "./git.ts";
import { BenchError, progress, tilde } from "./log.ts";
import { detectPackages } from "./packages.ts";

export interface AddOptions {
  name?: string;
  /** Warm benches to keep (default: "pool" in the config). */
  pool?: number;
  makeDefault?: boolean;
  /** Where to clone a URL to (default: ./<name>). */
  into?: string;
}

const isUrl = (s: string) => /^[\w+.-]+:\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

function gitClone(url: string, path: string): Promise<void> {
  return new Promise((done, fail) => {
    spawn("git", ["clone", url, path], { stdio: ["inherit", 2, 2] })
      .on("error", fail)
      .on("exit", (code) => code === 0 ? done() : fail(new BenchError(`git clone ${url} failed`)));
  });
}

/** Untracked .env files in the main checkout, which benches need too. */
async function envFiles(path: string): Promise<string[]> {
  const ignored = await git(path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory");
  return ignored.split("\n").filter((p) => /(^|\/)\.env(\.[\w.-]+)?$/.test(p) && !p.includes("node_modules/"));
}

/** Configure the repo (name, path, files to copy, pool size), make it the default if asked or if it's the first. */
export async function addRepo(source: string, options: AddOptions): Promise<string> {
  let path;
  const local = resolve(expandHome(source));
  if (existsSync(local)) {
    path = await mainCheckout(local);
    if (!path) throw new BenchError(`${tilde(local)} isn't a git repository with a checkout`);
  } else if (isUrl(source)) {
    path = resolve(expandHome(options.into ?? basename(source).replace(/\.git$/, "")));
    if (existsSync(path)) throw new BenchError(`${tilde(path)} already exists; pass that path instead of the URL, or --into`);
    progress(`cloning ${source} into ${tilde(path)}`);
    await gitClone(source, path);
  } else {
    throw new BenchError(`"${source}" is neither a directory nor a git URL`);
  }

  const name = options.name ?? basename(path).toLowerCase();
  const clash = configuredRepos().find((r) => r.name === name && r.path !== path);
  if (clash) throw new BenchError(`"${name}" is already ${tilde(clash.path)}; pick another --name`);

  const packages = detectPackages(path);
  if (packages) {
    const kind = packages.typescript ? "TypeScript" : "JavaScript";
    progress(`${kind} with ${packages.manager}: warm benches keep packages installed with ${packages.command}`);
  } else {
    progress("no package.json with a lockfile, so no packages to keep installed");
  }
  const env = await envFiles(path);
  if (env.length) progress(`copying ${env.join(", ")} into each bench`);

  const existing = configuredRepos().find((r) => r.name === name);
  const makeDefault = !!options.makeDefault || !settings().default;
  saveRepo(name, {
    path: tilde(path),
    pool: options.pool ?? existing?.pool ?? settings().pool,
    ...env.length && { copy: [...new Set([...existing?.copy ?? [], ...env])] },
  }, makeDefault);
  progress(`added ${name}${makeDefault ? " as the default repo" : ""}`);
  return name;
}
