#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// bench: a git worktree per branch, ready to work in.
// Node >= 22.18 runs this TypeScript directly; see the README.

import { run } from "../src/cli.ts";

run();
