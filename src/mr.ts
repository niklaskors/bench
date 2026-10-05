// Merge requests (GitLab) and pull requests (GitHub) for a bench's branch, through the glab and gh command lines,
// which bring their own sign-in. Which one is used follows from the remote's host.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repo } from "./config.ts";
import { git } from "./git.ts";
import { BenchError } from "./log.ts";

const execFileP = promisify(execFile);

export interface MergeRequest {
  /** As the forge writes it: !123 on GitLab, #123 on GitHub. */
  id: string;
  title: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  url: string;
  updated: string;
}

/** GitHub for github.com remotes, GitLab (glab) for everything else, including self-hosted GitLab. */
async function forge(repo: Repo): Promise<"github" | "gitlab"> {
  const url = await git(repo.path, "remote", "get-url", repo.remote);
  return /github\.com[:/]/.test(url) ? "github" : "gitlab";
}

async function run(program: string, args: string[], cwd: string): Promise<unknown> {
  try {
    const { stdout } = await execFileP(program, args, { cwd, maxBuffer: 16 << 20 });
    return JSON.parse(stdout);
  } catch (e) {
    const { code, stderr, message } = e as NodeJS.ErrnoException & { stderr?: string };
    if (code === "ENOENT") throw new BenchError(`${program} isn't installed; bench uses it to find merge requests`);
    // glab puts "ERROR" on a line of its own, with the reason on the next
    const reason = (stderr || message).split("\n").map((l) => l.trim()).filter((l) => l && l !== "ERROR").join(" ");
    throw new BenchError(`${program}: ${reason.slice(0, 200)}`);
  }
}

const STATE_ORDER = { open: 0, merged: 1, closed: 2 };

/** The merge request of a branch: the open one, else the latest merged, else the latest closed; null if none. */
export async function mergeRequest(repo: Repo, branch: string): Promise<MergeRequest | null> {
  let found: MergeRequest[];
  if (await forge(repo) === "github") {
    const prs = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "20",
      "--json", "number,title,state,isDraft,url,updatedAt"], repo.path) as
      { number: number; title: string; state: string; isDraft: boolean; url: string; updatedAt: string }[];
    found = prs.map((p) => ({
      id: `#${p.number}`, title: p.title, state: p.state === "OPEN" ? "open" : p.state === "MERGED" ? "merged" : "closed",
      draft: p.isDraft, url: p.url, updated: p.updatedAt,
    }));
  } else {
    const mrs = await run("glab", ["mr", "list", "--source-branch", branch, "--all", "--per-page", "20", "-F", "json"],
      repo.path) as { iid: number; title: string; state: string; draft: boolean; web_url: string; updated_at: string }[];
    found = mrs.map((m) => ({
      id: `!${m.iid}`, title: m.title, state: m.state === "opened" ? "open" : m.state === "merged" ? "merged" : "closed",
      draft: m.draft, url: m.web_url, updated: m.updated_at,
    }));
  }
  found.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updated.localeCompare(a.updated));
  return found[0] ?? null;
}

/** open, draft, merged or closed. */
export const mrStatus = (mr: MergeRequest) => (mr.draft && mr.state === "open" ? "draft" : mr.state);

/** "!123 open: title" */
export const describeMr = (mr: MergeRequest) => `${mr.id} ${mrStatus(mr)}: ${mr.title}`;
