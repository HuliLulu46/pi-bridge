import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

let home = "";
let work = "";
let extraEnv: NodeJS.ProcessEnv = {};

/** 每个测试前调用：新建隔离的 PI_BRIDGE_HOME 与工作目录 */
export function setup(env: NodeJS.ProcessEnv = {}): { home: string; work: string } {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-home-")));
  work = realpathSync(mkdtempSync(join(tmpdir(), "pi-bridge-work-")));
  extraEnv = env;
  return { home, work };
}

function env(): NodeJS.ProcessEnv {
  return { ...process.env, PI_BIN: FAKE_PI, PI_BRIDGE_HOME: home, FAKE_PI_CALLS: join(home, "calls.jsonl"), ...extraEnv };
}

export function run(args: string[], opts: { input?: string; cwd?: string } = {}): Result {
  const result = spawnSync("node", [CLI, ...args], { cwd: opts.cwd ?? work, env: env(), input: opts.input, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runAsync(args: string[]): Promise<Result> {
  const child = spawn("node", [CLI, ...args], { cwd: work, env: env() });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

export function piCalls(): Array<{ argv: string[]; cwd: string; subagent?: string }> {
  return readFileSync(join(home, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

export function sessionIdOf(argv: string[]): string | undefined {
  return argv[argv.indexOf("--session-id") + 1];
}
