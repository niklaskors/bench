// JavaScript/TypeScript packages: which package manager a checkout uses, and installing only when the lockfile changed.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { runShell } from "./files.ts";
import { git } from "./git.ts";
import { progress } from "./log.ts";

export interface Packages {
  manager: "pnpm" | "yarn" | "npm";
  lockfile: string;
  /** The frozen-lockfile install, run with the repo's Node version and package manager version where it pins them. */
  command: string;
  typescript: boolean;
}

const LOCKFILES = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", npm: "package-lock.json" } as const;

const onPath = (program: string) =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, program)));

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** The packages of the checkout at `dir`, if it has a package.json and a lockfile. */
export function detectPackages(dir: string): Packages | undefined {
  const pkg = readPackageJson(dir);
  if (!pkg) return undefined;
  // "packageManager": "yarn@4.1.0" is what corepack goes by; otherwise the lockfile says
  const pinned = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const manager = (Object.keys(LOCKFILES) as Packages["manager"][])
    .find((m) => pinned.startsWith(`${m}@`) || (!pinned && existsSync(join(dir, LOCKFILES[m]))));
  if (!manager || !existsSync(join(dir, LOCKFILES[manager]))) return undefined;

  const yarnBerry = existsSync(join(dir, ".yarnrc.yml")) || /^yarn@[2-9]/.test(pinned);
  let command = {
    pnpm: "pnpm install --frozen-lockfile --prefer-offline",
    yarn: yarnBerry ? "yarn install --immutable" : "yarn install --frozen-lockfile --prefer-offline",
    npm: "npm ci --prefer-offline --no-audit --no-fund",
  }[manager];
  if (pinned && onPath("corepack")) command = `corepack ${command}`;
  const nodeVersion = [".nvmrc", ".node-version"].find((f) => existsSync(join(dir, f)));
  if (nodeVersion && onPath("fnm")) command = `fnm exec --using=${nodeVersion} -- ${command}`;

  const deps = { ...pkg.dependencies as object, ...pkg.devDependencies as object };
  const typescript = "typescript" in deps || ["tsconfig.json", "tsconfig.base.json"].some((f) => existsSync(join(dir, f)));
  return { manager, lockfile: LOCKFILES[manager], command, typescript };
}

/** Where a worktree remembers what it last installed: in its own git directory, so it moves along with it. */
const markerPath = async (dir: string) =>
  join(await git(dir, "rev-parse", "--path-format=absolute", "--git-dir"), "bench-installed");

/** Install the packages unless node_modules already matches the lockfile; true when it installed. */
export async function installPackages(dir: string, packages: Packages, env: Record<string, string>): Promise<boolean> {
  const versions = [".nvmrc", ".node-version"].map((f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : "");
  const hash = createHash("sha256").update(packages.command).update(await readFile(join(dir, packages.lockfile)))
    .update(versions.join("\n")).digest("hex");
  const marker = await markerPath(dir);
  if (existsSync(join(dir, "node_modules")) && await readFile(marker, "utf8").catch(() => "") === hash) {
    progress(`packages are up to date with ${packages.lockfile}`);
    return false;
  }
  progress(`installing packages: ${packages.command}`);
  await runShell(packages.command, dir, env);
  await writeFile(marker, hash);
  return true;
}
