// Command line: commands, options, help text and output.

import { parseArgs } from "node:util";
import { addRepo } from "./add.ts";
import { AGENT_LOG, agentInstalled, schedule, setAgent } from "./agent.ts";
import { benches, newBench, pick, removeBench } from "./benches.ts";
import { CONFIG_PATH, OPEN_MODES, configuredRepos, resolveRepo, settings, type OpenMode, type Repo } from "./config.ts";
import { type Worktree } from "./git.ts";
import { BenchError, progress, tilde } from "./log.ts";
import { openBench } from "./open.ts";
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
  ls              list the benches of all repos
  rm <query>      remove a bench; refuses uncommitted or unpushed work
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
      --json            new, go, ls, repos, pool: print JSON
  -h, --help

Config: ${tilde(CONFIG_PATH)} (or $BENCH_CONFIG), and .bench.json in a repo; see the README.
Tip: g() { cd "$(bench go "$@")"; } jumps to a bench.`;

const COMMANDS = ["add", "new", "go", "ls", "rm", "setup", "repos", "pool"];

/** The fields of a bench that callers get as JSON. */
const describe = (w: Worktree) => ({ repo: w.repo.name, branch: w.branch ?? null, path: w.path });

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
  if (["add", "new", "go", "rm"].includes(command) && !arg) {
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
      const list = await benches(await scope());
      if (values.json) json(list.map(describe));
      else table(list.map((w) => [w.repo.name, w.branch ?? "(detached)", tilde(w.path)]));
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
