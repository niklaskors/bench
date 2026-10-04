# bench

A git worktree per branch, ready to work in.

`bench new feat/PROJ-123-login` gives the branch its own checkout (a *bench*) next to your main one,
copies what git doesn't track (`.env`, `node_modules`, …) from the main checkout, runs your setup command,
and prints the path. Run it again and you get the same bench back.

- **One command, any starting point**: reuses the branch's bench if it has one, else checks out the local branch,
  else the remote one (a teammate's), else makes the branch from the base branch
- **Several repos, one default**: name your repos once; bench uses the repo you're in, `--repo`, or the default
- **Made to be called by other tools**: progress on stderr, the path or `--json` on stdout, so a tool like
  [jboard](https://github.com/niklaskors/jboard) can open a bench for an issue
- **No build, no dependencies**: TypeScript that Node runs directly

## Requirements

- **Node.js 22.18 or newer** (runs TypeScript directly)
- **git 2.31 or newer**
- `--open tab` needs iTerm2 or Terminal on macOS

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

## Usage

```sh
bench new feat/PROJ-123-login             # bench for the branch in the repo you're in (or the default)
bench new fix/PROJ-9 -r api --from develop
bench new feat/PROJ-123-login -o tab -c claude   # set up and start claude in a new iTerm tab
bench go PROJ-123                         # path of the bench whose branch contains PROJ-123
bench ls                                  # benches of all repos
bench rm PROJ-123 -d                      # remove the bench and its local branch
bench setup                               # redo the copying and setup in the bench you're in
bench repos                               # configured repos, * is the default
bench -h                                  # all options
```

`bench rm` refuses a bench with uncommitted changes or commits that aren't on the remote, unless you pass `--force`.
It moves the directory aside and deletes it in the background, so it returns at once.

### Opening a bench

`--open` (or `"open"` in the config) says what happens after `new` or `go`:

| Mode | What happens |
|---|---|
| `none` | Only print the path (the default) |
| `here` | Run `--cmd` (or a shell) in the bench, in this terminal |
| `tab` | Open a new iTerm2 tab (a window in Terminal) in the bench and run `--cmd` there. A new bench is set up in that tab too, so you watch the install there and bench returns at once |

## Configuration

Your repos go in `~/.config/bench/config.json` (or `$BENCH_CONFIG`):

```json
{
  "default": "frontend",
  "root": "~/benches",
  "open": "tab",
  "command": "nvim",
  "repos": {
    "frontend": { "path": "~/Developer/Frontend" },
    "api": { "path": "~/Developer/api", "base": "develop" }
  }
}
```

| Key | Meaning |
|---|---|
| `default` | Repo used outside a repo when there's no `--repo` |
| `root` | Where benches go, as `<root>/<repo>/<branch>` (default `~/benches`) |
| `open`, `command` | Defaults for `--open` and `--cmd` |
| `repos` | Name → `path` of the main checkout, plus any of the repo settings below |

Repos you haven't configured work too, from inside them: they're named after their directory.

### Repo settings

These describe how to set up a bench of a repo, so they can be shared with your team in a committed `.bench.json`
at the repo's root. The same keys in your config override them.

```json
{
  "copy": [".env", "node_modules", "apps/*/node_modules"],
  "setup": "pnpm install --offline --frozen-lockfile",
  "env": { "NX_CACHE_DIRECTORY": "~/.cache/nx/my-repo" }
}
```

| Key | Meaning |
|---|---|
| `copy` | Paths or globs, relative to the repo, copied from the main checkout when the bench doesn't have them |
| `setup` | Shell command run in a new bench after copying |
| `env` | Environment for `setup`, e.g. one nx cache for all benches |
| `base` | Branch new branches start from (default: the remote's HEAD) |
| `remote` | Remote to fetch from (default `origin`) |

Copies are copy-on-write on APFS (and btrfs/XFS with GNU cp), so they take no extra disk space.
They're still not instant for a big `node_modules`: the time goes into the number of files, not their size.
Run with `-o tab` to keep working while it copies, or skip `copy` and let a package manager with a shared store
(pnpm) link the packages in `setup`.

## Output for other tools

With `--json`, `new` prints `{ "repo", "branch", "path", "created", "from" }`, `go` prints `{ "repo", "branch", "path" }`,
`ls` a list of those, and `repos` `{ "default", "repos": [{ "name", "path" }] }`.
Progress always goes to stderr. Exit codes: 0 done, 1 failed (with a message), 2 wrong usage.

## Development

```sh
npm install      # TypeScript and Node types, only needed for type checking
npm run check    # strict type check
```

Node only strips types, so bench can only use erasable TypeScript syntax and imports must name the `.ts` file;
`tsconfig.json` enforces both.

### Project layout

```
bin/bench.ts      entry point
src/cli.ts        commands, options, help text, output
src/config.ts     the config file, .bench.json, and which repo a command works in
src/git.ts        running git, listing worktrees
src/benches.ts    new, finding benches, rm
src/setup.ts      copying from the main checkout, the setup command
src/open.ts       starting a command here or in a new terminal tab
src/log.ts        messages and errors
```

## License

[MIT](LICENSE)
