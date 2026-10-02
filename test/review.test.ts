import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { gitIn, initRepo, piCalls, run, sessionIdOf, setup } from "./helpers.ts";

let home: string;
let work: string;

beforeEach(() => {
  ({ home, work } = setup());
  initRepo(work);
});

function messageOf(argv: string[]): string {
  return argv.at(-1)!;
}

test("review：走 advisor 路径，创建评审会话，消息含 diff 与未跟踪文件，回复末尾附追问方式", () => {
  writeFileSync(join(work, "a.txt"), "changed line\n");
  writeFileSync(join(work, "new.txt"), "brand new\n");
  const result = run(["review", "--model", "m1", "--thinking", "low", "--focus", "看并发问题"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^echo:你是代码评审者/);

  const [call] = piCalls();
  const argv = call!.argv;
  assert.equal(call!.cwd, work);
  assert.ok(argv.includes("-p"));
  const name = sessionIdOf(argv)!;
  assert.match(name, /^review-\d{8}T\d{6}-\d+$/);
  assert.ok(argv.includes("--name"));
  assert.ok(result.stdout.endsWith(`\n\n[pi-bridge] 评审会话：${name}，追问用 pi-bridge send ${name} <消息>\n`));
  assert.match(run(["list"]).stdout, new RegExp(`^${name}\\tidle\\t.*\\t${work}\\t${name}$`, "m"));
  assert.deepEqual(argv.slice(argv.indexOf("--no-extensions"), argv.indexOf("--no-extensions") + 3), [
    "--no-extensions",
    "--tools",
    "read,grep,find,ls",
  ]);
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "m1"]);
  assert.deepEqual(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2), ["--thinking", "low"]);

  const message = messageOf(argv);
  assert.match(message, /\+changed line/);
  assert.match(message, /未跟踪的新文件：new\.txt ===\nbrand new/);
  assert.match(message, /看并发问题/);
});

test("review：评审会话可以用 send 追问，在仓库根目录续接同一会话", () => {
  writeFileSync(join(work, "a.txt"), "changed line\n");
  mkdirSync(join(work, "sub"));
  assert.equal(run(["review"], { cwd: join(work, "sub") }).code, 0);
  const name = sessionIdOf(piCalls()[0]!.argv)!;

  const followUp = run(["send", name, "第 1 条展开说说"], { cwd: home });
  assert.equal(followUp.code, 0, followUp.stderr);
  const call = piCalls()[1]!;
  assert.equal(sessionIdOf(call.argv), name);
  assert.equal(call.cwd, work);
  assert.ok(call.argv.includes("--no-extensions"));
});

test("review --staged 不含未跟踪文件；--base 含分叉点以来的提交", () => {
  writeFileSync(join(work, "a.txt"), "staged line\n");
  gitIn(work, "add", "a.txt");
  writeFileSync(join(work, "u.txt"), "untracked\n");
  assert.equal(run(["review", "--staged"]).code, 0);
  assert.doesNotMatch(messageOf(piCalls()[0]!.argv), /u\.txt/);

  gitIn(work, "commit", "-q", "-m", "staged");
  gitIn(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "f.txt"), "feature line\n");
  gitIn(work, "add", "f.txt");
  gitIn(work, "commit", "-q", "-m", "f");
  assert.equal(run(["review", "--base", "main"]).code, 0);
  const message = messageOf(piCalls()[1]!.argv);
  assert.match(message, /\+feature line/);
  assert.doesNotMatch(message, /\+staged line/);
});

test("review：参数互斥、不接受透传参数、没有改动或不在仓库时报错且不调用 pi", () => {
  writeFileSync(join(work, "a.txt"), "x\n");
  assert.match(run(["review", "--staged", "--base", "main"]).stderr, /不能同时使用/);
  assert.equal(run(["review", "--", "--tools", "bash"]).code, 1);
  gitIn(work, "checkout", "--", "a.txt");
  assert.match(run(["review"]).stderr, /没有可评审的改动/);
  assert.match(run(["review", "--cwd", home]).stderr, /不在 git 仓库内/);
  assert.deepEqual(piCalls(), []);
  assert.equal(run(["list"]).stdout, "（没有会话）\n");
});

interface PatchSeen {
  mode: number;
  content: string;
}

function patchSeenByPi(): PatchSeen {
  return JSON.parse(readFileSync(join(home, "calls.jsonl.patch.json"), "utf8")) as PatchSeen;
}

function reviewFiles(): string[] {
  return existsSync(join(home, "reviews")) ? readdirSync(join(home, "reviews")) : [];
}

test("review：补丁不超过 200 KB 时内联在消息中，不写补丁文件", () => {
  writeFileSync(join(work, "a.txt"), "small change\n");
  assert.equal(run(["review"]).code, 0);
  assert.match(messageOf(piCalls()[0]!.argv), /```diff\n[\s\S]*\+small change/);
  assert.deepEqual(reviewFiles(), []);
});

test("review：补丁超过 200 KB 时写入仅本人可读的补丁文件，评审结束后删除", () => {
  const big = Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  writeFileSync(join(work, "a.txt"), `${big}\n`);
  assert.equal(run(["review"]).code, 0);
  const message = messageOf(piCalls()[0]!.argv);
  assert.match(message, /补丁超过 200 KB，完整内容在文件 \S+\.patch/);
  assert.doesNotMatch(message, /line 5999/);

  const seen = patchSeenByPi();
  assert.equal(seen.mode, 0o600);
  assert.match(seen.content, /\+line 5999/);
  assert.deepEqual(reviewFiles(), []);
});

test("review：补丁文件中的超长行被切成带续行标记的短行，拼回后与原文一致", () => {
  const longLine = Array.from({ length: 50000 }, (_, i) => `v${i}`).join(",");
  assert.ok(longLine.length > 250 * 1024);
  writeFileSync(join(work, "a.txt"), `${longLine}\n`);
  assert.equal(run(["review"]).code, 0);
  assert.match(messageOf(piCalls()[0]!.argv), /行尾的 ↩ 表示下一行与本行原本是同一行/);

  const { content } = patchSeenByPi();
  assert.ok(content.split("\n").every((line) => [...line].length <= 4001));
  assert.ok(content.replaceAll("↩\n", "").includes(`+${longLine}`));
});

test("review：8000 字节之后含 NUL 的文件不会让评审失败", () => {
  const tracked = Buffer.alloc(9000, "x");
  writeFileSync(join(work, "n.txt"), tracked);
  gitIn(work, "add", "n.txt");
  gitIn(work, "commit", "-q", "-m", "n");
  const changed = Buffer.alloc(9000, "y");
  changed[8500] = 0;
  writeFileSync(join(work, "n.txt"), changed);
  const untracked = Buffer.alloc(9000, "z");
  untracked[8900] = 0;
  writeFileSync(join(work, "u.bin"), untracked);

  const result = run(["review"]);
  assert.equal(result.code, 0, result.stderr);
  const message = messageOf(piCalls()[0]!.argv);
  assert.ok(!message.includes("\0"));
  assert.match(message, /␀/);
  assert.match(message, /补丁中的 ␀ 表示原文件中的 NUL 字节/);
  assert.match(message, /\?\? u\.bin（二进制，9000 字节，未内联）/);
});
