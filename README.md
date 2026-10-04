# bench

A git worktree per branch, ready to work in.

`bench new feat/PROJ-123-login` gives the branch its own checkout (a *bench*) next to your main one, with packages
installed and your `.env` files in place, and prints its path. Run it again and you get the same bench back.
With a pool of warm benches, that takes about a second, even in a big monorepo.

- **Set a repo up once**: `bench add <path or URL>` detects its package manager and `.env` files, warms a pool of
  benches and keeps them up to date in the background
- **One command, any starting point**: reuses the branch's bench if it has one, else checks out the local branch,
  else the remote one (a teammate's), else makes the branch from the base branch
- **Several repos, one default**: bench uses `--repo`, else the repo you're in, else your default
- **Made to be called by other tools**: progress on stderr, the path or `--json` on stdout, so a tool like
  [jboard](https://github.com/niklaskors/jboard) can open a bench for an issue
- **No build, no dependencies**: TypeScript that Node runs directly

## Requirements

- **Node.js 22.18 or newer** (runs TypeScript directly)
- **git 2.31 or newer**
- The background refresh uses launchd, so it's macOS only; elsewhere run `bench pool refresh` from cron
- `--open tab` knows iTerm2 and Terminal on macOS; other terminals take a command in the config

## Install

```sh
git clone https://github.com/niklaskors/bench.git
ln -s "$PWD/bench/bin/bench.ts" ~/.local/bin/bench   # any directory on your PATH
```

The link must point at `bin/bench.ts` inside the clone (not a copy of it): it loads the rest of the code from `src/`.

To jump to a bench, add a shell function, for example in `~/.zshrc`:

```sh
g() { cd "$(bench go "$@")"; }    # g PROJ-123
```

## Getting started

```sh
bench add ~/code/shop --default                # a repo you have, made the default
bench add git@github.com:you/api.git --pool 1  # or clone one first
bench new feat/PROJ-123-login -o tab -c claude # take a warm bench and start claude in it in a new tab
```

`bench add`:

1. clones the repo if you give it a URL (into `./<name>`, or `--into DIR`)
2. detects the packages: a `package.json` with a pnpm, yarn or npm lockfile, using the version of the package manager
   pinned in `packageManager` (through corepack) and the Node version in `.nvmrc` or `.node-version` (through fnm),
   when you have those tools
3. finds untracked `.env` files to copy into each bench
4. saves the repo in your config, as the default if you ask or if it's your first
5. warms the pool (`--pool N` benches, default 2), which takes as long as a fresh install the first time
6. turns on the background refresh (unless `--no-auto`)

## Usage

```sh
bench new feat/PROJ-123-login             # bench for the branch in the default repo (or the one you're in)
bench new fix/PROJ-9 -r api --from develop
bench go PROJ-123                         # path of the bench whose branch contains PROJ-123
bench ls                                  # benches of all repos
bench rm PROJ-123 -d                      # remove the bench and its local branch
bench setup                               # redo copying, installing and setup in the bench you're in
bench repos                               # configured repos, * is the default
bench pool                                # the warm benches and the background refresh
bench pool refresh                        # bring warm benches up to date now
bench -h                                  # all options
```

`bench rm` refuses a bench with uncommitted changes or commits that aren't on the remote, unless you pass `--force`.
It moves the directory aside and deletes it in the background, so it returns at once.

### The pool

A warm bench is a worktree on the latest base branch with packages installed, waiting in `<root>/<repo>/.pool`.
`bench new` takes one, switches it to your branch and moves it into place; packages only install again when the
branch's lockfile differs. Then a new warm bench is made in the background (logged to `.pool/refresh.log`).

The refresh (`bench pool refresh`, which the background job runs daily at 07:00 by default) moves each warm bench to
the latest base branch, installs packages when the lockfile changed, cleans up after interrupted runs and tops the
pool up to its size. A bench you took is no longer in the pool, so the refresh leaves it alone.
Only one refresh per repo runs at a time.

A new warm bench starts with a copy of the main checkout's `node_modules` (copy-on-write on APFS, so it takes no
extra disk) and installs from there, which is usually much faster than installing from nothing.

### Opening a bench

`--open` (or `"open"` in the config) says what happens after `new` or `go`:

| Mode | What happens |
|---|---|
| `none` | Only print the path (the default) |
| `here` | Run `--cmd` (or a shell) in the bench, in this terminal |
| `tab` | Open a new terminal tab in the bench and run `--cmd` there. A new bench is set up in that tab too, so you watch any install there and bench returns at once |

## Configuration

Everything lives in `~/.config/bench/config.json` (or `$BENCH_CONFIG`); `bench add` writes the repos for you.

```json
{
  "default": "shop",
  "root": "~/benches",
  "open": "tab",
  "command": "nvim",
  "pool": 2,
  "refresh": "07:00",
  "repos": {
    "shop": { "path": "~/code/shop", "pool": 2, "copy": [".env"] },
    "api": { "path": "~/code/api", "base": "develop" }
  }
}
```

| Key | Meaning |
|---|---|
| `default` | Repo used outside a repo when there's no `--repo` |
| `root` | Where benches go, as `<root>/<repo>/<branch>` (default `~/benches`) |
| `open`, `command` | Defaults for `--open` and `--cmd` |
| `tab` | Shell command that opens a tab, for terminals bench doesn't know; it gets `$BENCH_PATH` and `$BENCH_RUN` (the command line to run there). For example `wezterm cli spawn --cwd "$BENCH_PATH" -- $SHELL -lic "$BENCH_RUN; exec $SHELL"` |
| `pool` | Pool size `bench add` gives a repo when you don't pass `--pool` (default 2) |
| `refresh` | When the background refresh runs: daily at a time (default `"07:00"`; if the Mac sleeps then, it runs when it wakes) or every so many minutes (a number). Run `bench pool auto on` again after changing it |
| `repos` | Name → `path` of the main checkout, plus any of the repo settings below |

Repos you haven't configured work too, from inside them: they're named after their directory.

### Repo settings

These describe how to set up a bench of a repo, so they can also be shared with your team in a committed
`.bench.json` at the repo's root. The same keys in your config override them.

```json
{
  "copy": [".env", "apps/*/.env"],
  "setup": "pnpm nx run-many -t codegen",
  "env": { "NX_CACHE_DIRECTORY": "~/.cache/nx/shop" }
}
```

| Key | Meaning |
|---|---|
| `pool` | Warm benches to keep ready (default 0, `bench add` sets it) |
| `copy` | Paths or globs, relative to the repo, copied from the main checkout when the bench doesn't have them |
| `install` | `false` to not install packages, or the install command to use instead of the detected one |
| `setup` | Shell command run in a new bench after installing, e.g. code generation |
| `env` | Environment for installing and `setup`, e.g. one nx cache for all benches |
| `base` | Branch new branches start from (default: the remote's HEAD) |
| `remote` | Remote to fetch from (default `origin`) |

## Output for other tools

With `--json`, `new` prints `{ "repo", "branch", "path", "created", "from", "warm" }`, `go` prints
`{ "repo", "branch", "path" }`, `ls` a list of those, `repos` `{ "default", "repos": [{ "name", "path", "pool" }] }`
and `pool` the warm benches per repo. Progress always goes to stderr.
Exit codes: 0 done, 1 failed (with a message), 2 wrong usage.

## Development

```sh
npm install      # TypeScript and Node types, only needed for type checking
npm run check    # strict type check
```

Node only strips types, so bench can only use erasable TypeScript syntax and imports must name the `.ts` file;
`tsconfig.json` enforces both.

### Project layout

```
bin/bench.ts       entry point
src/cli.ts         commands, options, help text, output
src/config.ts      the config file, .bench.json, and which repo a command works in
src/add.ts         bench add: cloning, detecting, saving the repo
src/git.ts         running git, listing worktrees
src/benches.ts     new, finding benches, rm
src/pool.ts        warm benches: taking one, refreshing, locking
src/agent.ts       the background refresh (launchd)
src/setup.ts       copying from the main checkout, installing, the setup command
src/packages.ts    detecting the package manager, installing when the lockfile changed
src/files.ts       copy-on-write copies, deleting in the background, running commands
src/open.ts        starting a command here or in a new terminal tab
src/log.ts         messages and errors
```

## License

[MIT](LICENSE)
