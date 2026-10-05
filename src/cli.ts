// Command line: commands, options, help text and output.

import { parseArgs } from "node:util";
import { addRepo } from "./add.ts";
import { AGENT_LOG, agentInstalled, schedule, setAgent } from "./agent.ts";
import { benches, isPast, mergeRequests, newBench, pastBenches, pick, removeBench } from "./benches.ts";
import { CONFIG_PATH, OPEN_MODES, configuredRepos, knownRepos, resolveRepo, settings, type OpenMode, type Repo } from "./config.ts";
import { type Worktree } from "./git.ts";
import { BenchError, progress, tilde } from "./log.ts";
import { HISTORY_PATH } from "./history.ts";
import { describeMr, mrStatus } from "./mr.ts";
import { openBench, openUrl } from "./open.ts";
import { poolDir, refreshPool, warmBenches } from "./pool.ts";
import { setupBench } from "./setup.ts";

const USAGE = `Usage: bench <command> [options]

A git worktree per branch, ready to work in.

Commands:
  add <path|url>  set a repo up for benches (cloning a URL first): detects its packages and .env
                  files, keeps a pool of warm benches and refreshes them in the background
  new <branch>    give <branch> a bench and print its path. Reuses the bench the branch
                  already has; otherwise checks out the local branch, the remote one,
                  or makes it from the base branch, in a warm bench when one is ready
  go <query>      print the path of the bench whose branch matches <query>
  ls              list the benches of all repos; --all also lists removed ones, --mr adds
                  merge requests, --match REGEX keeps branches that match
  mr <query>      print the URL of the merge request (or GitHub pull request) of a bench's
                  branch, also of a removed bench; -w opens it in the browser.
                  Uses glab for GitLab and gh for GitHub
  rm <query>      remove a bench; refuses uncommitted or unpushed work. Its branch and merge
                  request are remembered (bench ls --all)
  setup [path]    copy files from the main checkout, install packages if the lockfile
                  changed and run the setup command (new does this itself)
  repos           list the configured repos
  pool            show the warm benches
  pool refresh    bring warm benches up to date and top the pools up (what runs in the background)
  pool auto on|off  refresh in the background ("refresh" in the config, default daily at 07:00)

Options:
  -r, --repo NAME|PATH  repo to work in (default: the one you're in, else "default" in the config)
      --from BRANCH     base for a new branch (default: the repo's "base", else the remote's HEAD)
  -o, --open MODE       new, go: none, here (run the command in this terminal) or tab (a new
                        terminal tab, where setup also runs). Default: "open" in the config, else none
  -c, --cmd COMMAND     command to start in the bench, e.g. nvim or claude (default: "command"
                        in the config, else a shell)
      --no-setup        new: skip copying, installing and the setup command
  -f, --force           rm: remove even with uncommitted or unpushed work
  -d, --delete-branch   rm: also delete the local branch
      --name NAME       add: name for the repo (default: its directory)
      --pool N          add: warm benches to keep (default: "pool" in the config, else 2)
      --default         add: make it the default repo
      --into DIR        add: where to clone a URL (default: ./<name>)
      --no-auto         add: don't turn on the background refresh
      --all             ls: also list removed benches
      --mr              ls: look up each bench's merge request
      --match REGEX     ls: only branches that match (ignoring case), e.g. "PROJ-1\\b|PROJ-7\\b"
  -w, --web             mr: open the merge request in the browser
      --json            new, go, ls, mr, repos, pool: print JSON
  -h, --help

Config: ${tilde(CONFIG_PATH)} (or $BENCH_CONFIG), and .bench.json in a repo; see the README.
Removed benches are remembered in ${tilde(HISTORY_PATH)}.
Tip: g() { cd "$(bench go "$@")"; } jumps to a bench.`;

const COMMANDS = ["add", "new", "go", "ls", "mr", "rm", "setup", "repos", "pool"];

/** The fields of a bench that callers get as JSON. */
const describe = (w: Worktree) => ({
  repo: w.repo.name, branch: w.branch ?? null, path: w.path, ...isPast(w) && { removed: w.removed },
});

/** Print rows as aligned columns. */
function table(rows: string[][]): void {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
  for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
}

const ago = (iso?: string) => {
  if (!iso) return "";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
};

async function showPool(repos: Repo[], json: boolean): Promise<void> {
  const pools = await Promise.all(repos.map(async (repo) => ({ repo, warm: await warmBenches(repo) })));
  if (json) {
    console.log(JSON.stringify(pools.map(({ repo, warm }) => ({
      repo: repo.name, size: repo.pool,
      warm: warm.map((w) => ({ path: w.path, state: w.busy ? "busy" : w.state?.state ?? "unknown", head: w.state?.head, updated: w.state?.updated })),
    })), null, 2));
    return;
  }
  const rows: string[][] = [];
  for (const { repo, warm } of pools) {
    const ready = warm.filter((w) => w.state?.state === "ready" && !w.busy).length;
    rows.push([repo.name, `${ready}/${repo.pool} ready`, "", "", tilde(poolDir(repo))]);
    for (const w of warm) {
      const state = w.busy ? (w.state?.state === "ready" ? "updating" : "warming") : w.state?.state ?? "unfinished";
      rows.push(["", state, w.state?.head?.slice(0, 10) ?? "", ago(w.state?.updated), w.id]);
    }
  }
  table(rows);
  console.log(`\nbackground refresh: ${agentInstalled() ? `${schedule()}, log in ${tilde(AGENT_LOG)}` : "off"}`);
}

async function main(): Promise<void> {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        repo: { type: "string", short: "r" },
        from: { type: "string" },
        open: { type: "string", short: "o" },
        cmd: { type: "string", short: "c" },
        "no-setup": { type: "boolean" },
        force: { type: "boolean", short: "f" },
        "delete-branch": { type: "boolean", short: "d" },
        name: { type: "string" },
        pool: { type: "string" },
        default: { type: "boolean" },
        into: { type: "string" },
        "no-auto": { type: "boolean" },
        all: { type: "boolean" },
        mr: { type: "boolean" },
        match: { type: "string" },
        web: { type: "boolean", short: "w" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    usageError((e as Error).message);
  }
  const [command, arg, ...extra] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (!COMMANDS.includes(command)) usageError(`unknown command "${command}"`);
  if (extra.length && !(command === "pool" && arg === "auto" && extra.length === 1)) {
    usageError(`unexpected argument "${extra.at(-1)}"`);
  }
  if (["add", "new", "go", "mr", "rm"].includes(command) && !arg) {
    usageError(`${command} needs a ${{ add: "path or URL", new: "branch" }[command] ?? "query"}`);
  }
  const pool = values.pool === undefined ? undefined : Number(values.pool);
  if (pool !== undefined && !(Number.isInteger(pool) && pool >= 0)) usageError("--pool must be a whole number");
  const open = (values.open ?? settings().open) as OpenMode;
  if (!OPEN_MODES.includes(open)) usageError(`--open must be one of ${OPEN_MODES.join(", ")}`);
  const cmd = values.cmd ?? settings().command;
  const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  /** --repo limits go, ls, rm and pool to that repo. */
  const scope = async () => values.repo ? [await resolveRepo(values.repo)] : undefined;

  switch (command) {
    case "add": {
      const name = await addRepo(arg, { name: values.name, pool, makeDefault: values.default, into: values.into });
      const repo = await resolveRepo(name);
      if (repo.pool) {
        progress(`warming ${repo.pool} bench${repo.pool > 1 ? "es" : ""}; this can take a while the first time`);
        await refreshPool(repo);
      }
      if (process.platform === "darwin" && !values["no-auto"] && !agentInstalled()) {
        await setAgent(true);
        progress(`warm benches now refresh in the background ${schedule()} ("bench pool auto off" stops that)`);
      }
      break;
    }
    case "new": {
      const result = await newBench(await resolveRepo(values.repo), arg, values.from);
      const setup = result.created && !values["no-setup"];
      // in a tab the setup runs where you can watch it, and the caller doesn't wait for it
      if (setup && open !== "tab") await setupBench(result.path);
      if (values.json) json(result);
      else console.log(result.path);
      await openBench(result.path, open, cmd, setup && open === "tab");
      break;
    }
    case "go": {
      const bench = pick(await benches(await scope()), arg);
      if (values.json) json(describe(bench));
      else console.log(bench.path);
      await openBench(bench.path, open, cmd);
      break;
    }
    case "ls": {
      const repos = await scope() ?? await knownRepos();
      const active = await benches(repos);
      let list: Worktree[] = values.all ? [...active, ...pastBenches(repos, active)] : active;
      if (values.match) {
        let re: RegExp;
        try {
          re = new RegExp(values.match, "i");
        } catch (e) {
          usageError(`--match: ${(e as Error).message}`);
        }
        list = list.filter((w) => re.test(w.branch ?? ""));
      }
      let failed = "";
      const mrs = values.mr ? await mergeRequests(list, (message) => (failed = message)) : undefined;
      if (failed) progress(`couldn't look up every merge request: ${failed}`);
      if (values.json) json(list.map((w, i) => ({ ...describe(w), ...mrs && { mr: mrs[i] ?? null } })));
      else {
        table(list.map((w, i) => {
          const mr = mrs?.[i];
          const where = isPast(w) ? `(removed ${ago(w.removed)})` : tilde(w.path);
          return [w.repo.name, w.branch ?? "(detached)", ...mrs ? [mr ? `${mr.id} ${mrStatus(mr)}` : "-"] : [], where];
        }));
      }
      break;
    }
    case "mr": {
      const repos = await scope() ?? await knownRepos();
      const active = await benches(repos);
      // a bench that exists wins; otherwise one that was removed
      let bench: Worktree;
      try {
        bench = pick(active, arg);
      } catch (e) {
        const past = pastBenches(repos, active);
        if (!past.some((w) => w.branch.toLowerCase().includes(arg.toLowerCase()))) throw e;
        bench = pick(past, arg);
      }
      if (!bench.branch) throw new BenchError(`${tilde(bench.path)} isn't on a branch`);
      const [mr] = await mergeRequests([bench], (message) => {
        throw new BenchError(message);
      });
      if (values.json) json({ ...describe(bench), mr: mr ?? null });
      else if (!mr) throw new BenchError(`no merge request for ${bench.branch}`);
      else {
        progress(describeMr(mr));
        console.log(mr.url);
      }
      if (mr && values.web) await openUrl(mr.url);
      break;
    }
    case "rm":
      await removeBench(pick(await benches(await scope()), arg), {
        force: values.force,
        deleteBranch: values["delete-branch"],
      });
      break;
    case "setup":
      await setupBench(arg ?? process.cwd());
      break;
    case "repos": {
      const repos = configuredRepos();
      const name = settings().default;
      if (values.json) {
        json({ default: name ?? null, repos: repos.map((r) => ({ name: r.name, path: r.path, pool: r.pool })) });
      } else {
        table(repos.map((r) => [r.name === name ? "*" : " ", r.name, tilde(r.path), r.pool ? `pool ${r.pool}` : ""]));
      }
      break;
    }
    case "pool": {
      const repos = await scope() ?? configuredRepos();
      if (!arg) await showPool(repos, !!values.json);
      else if (arg === "refresh") {
        for (const repo of repos) {
          progress(`${repo.name}: refreshing (${new Date().toISOString()})`);
          await refreshPool(repo).catch((e: Error) => progress(`${repo.name}: ${e.message}`));
        }
      } else if (arg === "auto" && ["on", "off"].includes(extra[0])) {
        await setAgent(extra[0] === "on");
        progress(`background refresh ${extra[0] === "on" ? `on, ${schedule()}` : "off"}`);
      } else usageError(`pool takes refresh or auto on|off`);
      break;
    }
  }
}

function usageError(message: string): never {
  console.error(`bench: ${message}\n\n${USAGE}`);
  process.exit(2);
}

/** Run bench; expected problems end it with a readable message instead of a stack trace. */
export function run(): void {
  main().catch((e: unknown) => {
    if (!(e instanceof BenchError)) throw e;
    console.error(`bench: ${e.message}`);
    process.exit(1);
  });
}
