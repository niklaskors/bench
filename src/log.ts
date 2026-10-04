// Messages: progress and errors go to stderr, so stdout stays a path or JSON that callers can use.

import { homedir } from "node:os";

/** A problem to report as a one-line message instead of a stack trace. */
export class BenchError extends Error {}

export const progress = (message: string) => process.stderr.write(`bench: ${message}\n`);

/** A path for display, with the home directory as ~. */
export const tilde = (path: string) => {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
};

/** Quote for a POSIX shell. */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
