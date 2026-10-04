// Refreshing the pools in the background with a launchd agent (macOS).

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { settings } from "./config.ts";
import { BenchError, shellQuote } from "./log.ts";

const execFileP = promisify(execFile);

const LABEL = "bench.pool-refresh";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const AGENT_LOG = join(homedir(), "Library", "Logs", "bench.log");

const domain = () => `gui/${process.getuid!()}`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const agentInstalled = () => existsSync(PLIST);

/** When the background refresh runs, in words. */
export const schedule = () => {
  const { refresh } = settings();
  return typeof refresh === "string" ? `daily at ${refresh}` : `every ${refresh} minutes`;
};

/** The plist keys for the schedule; launchd runs a missed daily refresh when the Mac wakes up. */
function scheduleKeys(): string {
  const { refresh } = settings();
  if (typeof refresh === "number") return `<key>StartInterval</key><integer>${Math.round(refresh * 60)}</integer>`;
  const [hour, minute] = refresh.split(":").map(Number);
  return `<key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
}

/** Turn the background refresh on or off. */
export async function setAgent(on: boolean): Promise<void> {
  if (process.platform !== "darwin") {
    throw new BenchError(`background refresh uses launchd, so it's macOS only; elsewhere run "bench pool refresh" from cron`);
  }
  await execFileP("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => {});
  if (!on) {
    await rm(PLIST, { force: true });
    return;
  }
  // through a login shell, so installs see the same PATH, Node version manager and registry tokens as in a terminal
  const shell = process.env.SHELL || "/bin/zsh";
  const command = [
    process.env.BENCH_CONFIG && `export BENCH_CONFIG=${shellQuote(process.env.BENCH_CONFIG)};`,
    `exec ${shellQuote(realpathSync(process.argv[1]))} pool refresh`,
  ].filter(Boolean).join(" ");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(shell)}</string><string>-lic</string><string>${xml(command)}</string></array>
  ${scheduleKeys()}
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardInPath</key><string>/dev/null</string>
  <key>StandardOutPath</key><string>${xml(AGENT_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(AGENT_LOG)}</string>
</dict>
</plist>
`;
  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(dirname(AGENT_LOG), { recursive: true });
  await writeFile(PLIST, plist);
  await execFileP("launchctl", ["bootstrap", domain(), PLIST]);
}
