// Command line: commands, options, help text and output.

import { parseArgs } from "node:util";
import { benches, newBench, pick, removeBench } from "./benches.ts";
import { CONFIG_PATH, OPEN_MODES, configuredRepos, resolveRepo, settings, type OpenMode } from "./config.ts";
import { type Worktree } from "./git.ts";
import { BenchError, tilde } from "./log.ts";
import { openBench } from "./open.ts";
import { setupBench } from "./setup.ts";

const USAGE = `Usage: bench <command> [options]

A git worktree per branch, ready to work in.

Commands:
  new <branch>    give <branch> a bench and print its path. Reuses the bench the branch
                  already has; otherwise checks out the local branch, the remote one,
                  or makes it from the base branch. Then copies files and runs setup
  go <query>      print the path of the bench whose branch matches <query>
  ls              list the benches of all repos
  rm <query>      remove a bench; refuses uncommitted or unpushed work
  setup [path]    copy files from the main checkout and run the setup command
                  (new does this itself)
  repos           list the configured repos

Options:
  -r, --repo NAME|PATH  repo to work in (default: the one you're in, else "default" in the config)
      --from BRANCH     base for a new branch (default: the repo's "base", else the remote's HEAD)
  -o, --open MODE       new, go: none, here (run the command in this terminal) or tab (a new
                        iTerm2 tab, where setup also runs). Default: "open" in the config, else none
  -c, --cmd COMMAND     command to start in the bench, e.g. nvim or claude (default: "command"
                        in the config, else a shell)
      --no-setup        new: skip copying and the setup command
  -f, --force           rm: remove even with uncommitted or unpushed work
  -d, --delete-branch   rm: also delete the local branch
      --json            new, go, ls, repos: print JSON
  -h, --help

Config: ${tilde(CONFIG_PATH)} (or $BENCH_CONFIG), and .bench.json in a repo; see the README.
Tip: g() { cd "$(bench go "$@")"; } jumps to a bench.`;

const COMMANDS = ["new", "go", "ls", "rm", "setup", "repos"];

/** The fields of a bench that callers get as JSON. */
const describe = (w: Worktree) => ({ repo: w.repo.name, branch: w.branch ?? null, path: w.path });

/** Print rows as aligned columns. */
function table(rows: string[][]): void {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
  for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
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
  if (extra.length) usageError(`unexpected argument "${extra[0]}"`);
  if (["new", "go", "rm"].includes(command) && !arg) usageError(`${command} needs a ${command === "new" ? "branch" : "query"}`);
  const open = (values.open ?? settings().open) as OpenMode;
  if (!OPEN_MODES.includes(open)) usageError(`--open must be one of ${OPEN_MODES.join(", ")}`);
  const cmd = values.cmd ?? settings().command;
  const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  /** --repo limits go, ls and rm to that repo. */
  const scope = async () => values.repo ? [await resolveRepo(values.repo)] : undefined;

  switch (command) {
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
      if (values.json) json({ default: name ?? null, repos: repos.map((r) => ({ name: r.name, path: r.path })) });
      else table(repos.map((r) => [r.name === name ? "*" : " ", r.name, tilde(r.path)]));
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
