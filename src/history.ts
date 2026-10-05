// Removed benches: their files are gone, but which branch they had and its merge request are kept,
// so `bench ls --all` and `bench mr` still know them.

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BenchError, tilde } from "./log.ts";
import type { MergeRequest } from "./mr.ts";

export interface RemovedBench {
  /** The repo's name and main checkout when the bench was removed. */
  repo: string;
  repoPath: string;
  branch: string;
  /** Where the bench was. */
  path: string;
  /** When it was removed (ISO time). */
  removed: string;
  /** The branch's merge request when last looked up; null for none, missing when it couldn't be looked up. */
  mr?: MergeRequest | null;
}

export const HISTORY_PATH = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "bench", "history.json");

export function readHistory(): RemovedBench[] {
  let text;
  try {
    text = readFileSync(HISTORY_PATH, "utf8");
  } catch {
    return [];
  }
  try {
    return JSON.parse(text) as RemovedBench[];
  } catch (e) {
    throw new BenchError(`${tilde(HISTORY_PATH)}: ${(e as Error).message}`);
  }
}

async function writeHistory(history: RemovedBench[]): Promise<void> {
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(`${HISTORY_PATH}.tmp`, JSON.stringify(history, null, 2) + "\n");
  await rename(`${HISTORY_PATH}.tmp`, HISTORY_PATH);
}

const same = (a: RemovedBench, b: RemovedBench) => a.repoPath === b.repoPath && a.branch === b.branch;

/** Remember a removed bench, replacing what was known about the same branch. */
export async function remember(entry: RemovedBench): Promise<void> {
  await writeHistory([...readHistory().filter((e) => !same(e, entry)), entry]);
}

/** Store fresher merge requests of removed benches. */
export async function updateHistory(entries: RemovedBench[]): Promise<void> {
  if (!entries.length) return;
  await writeHistory(readHistory().map((e) => entries.find((u) => same(u, e)) ?? e));
}
