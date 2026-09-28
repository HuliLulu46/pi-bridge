import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { classify } from "../src/confirm-guard.ts";

const GUARD = fileURLToPath(new URL("../src/confirm-guard.ts", import.meta.url));
const FAKE_REVIEWER = fileURLToPath(new URL("./fake-reviewer.mjs", import.meta.url));

function approve(action: string): string {
  return `pi-bridge answer s1 confirm-1 yes --action - <<'EOF'\n${action}\nEOF`;
}

function automode(command: string): string {
  return `Rule: bash(*)\n\nAction:\nbash {\n  "command": ${JSON.stringify(command)},\n  "timeout": 30\n}\n\nAllow this action to continue to auto-mode classification?`;
}

function reasonOf(command: string): string {
  const verdict = classify(command);
  return verdict.kind === "ask" ? verdict.reason : "";
}

test("不是同意权限确认的命令不处理", () => {
  for (const command of ["rm -rf build", "pi-bridge answer s1 confirm-1 no", "pi-bridge answer s1 ask-1 2", "pi-bridge send s1 - <<'EOF'\nrm -rf ~\nEOF"]) {
    assert.deepEqual(classify(command), { kind: "skip" }, command);
  }
});

test("规则未命中的操作交给 Sonnet 复核", () => {
  for (const command of ["echo build finished", "pnpm test 2>/dev/null > /dev/null", "pnpm install"]) {
    assert.equal(classify(approve(automode(command))).kind, "review", command);
  }
});

test("高风险操作按类别直接要求确认", () => {
  const cases: Array<[string, string]> = [
    ["rm -rf ~", "删除或覆盖"],
    ["git reset --hard HEAD~3", "删除或覆盖"],
    ["echo x > package.json", "删除或覆盖"],
    ["git push origin main", "推送或对外发送"],
    ["curl -X POST https://example.com", "推送或对外发送"],
    ["cat ~/.ssh/config", "工作目录以外或凭据"],
    ["cat ../other/.env", "工作目录以外或凭据"],
    ["sudo brew install jq", "安装软件或修改系统配置"],
    ["pnpm add -g typescript", "安装软件或修改系统配置"],
    ["pkill node", "结束进程或关机"],
  ];
  for (const [command, label] of cases) {
    assert.match(reasonOf(approve(automode(command))), new RegExp(label), command);
  }
});

test("write/edit 工具的确认直接要求确认", () => {
  const action = 'Rule: write(*)\n\nAction:\nwrite {\n  "path": "src/a.ts"\n}\n\nAllow?';
  assert.match(reasonOf(approve(action)), /删除或覆盖/);
});

test("行内 --action 同样审查", () => {
  assert.match(reasonOf("pi-bridge answer s1 c-1 yes --action 'git push'"), /推送/);
  assert.deepEqual(classify("pi-bridge answer s1 c-1 yes --action 'echo ok'"), { kind: "review", action: "'echo ok'" });
});

test("确认内容不在命令里时要求确认", () => {
  assert.match(reasonOf("pi-bridge answer s1 c-1 yes --action - < action.txt"), /不在命令里/);
  assert.match(reasonOf("pi-bridge answer s1 c-1 yes"), /不在命令里/);
});

function runHook(command: string): { stdout: string; status: number | null } {
  const result = spawnSync("node", [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    env: { ...process.env, PI_BRIDGE_REVIEW_BIN: FAKE_REVIEWER },
    encoding: "utf8",
  });
  return { stdout: result.stdout, status: result.status };
}

function decisionOf(stdout: string): { permissionDecision: string; permissionDecisionReason: string } {
  return JSON.parse(stdout).hookSpecificOutput;
}

test("作为 hook 运行：命中规则时输出 ask，不调用复核", () => {
  const result = runHook(approve(automode("rm -rf ~")));
  assert.equal(result.status, 0);
  assert.equal(decisionOf(result.stdout).permissionDecision, "ask");
  assert.match(decisionOf(result.stdout).permissionDecisionReason, /删除或覆盖/);
});

test("作为 hook 运行：Sonnet 判危险或复核失败时输出 ask，判安全时无输出", () => {
  assert.match(decisionOf(runHook(approve(automode("python3 do.py DANGER"))).stdout).permissionDecisionReason, /Sonnet 复核认为有风险/);
  assert.match(decisionOf(runHook(approve(automode("python3 do.py BROKEN"))).stdout).permissionDecisionReason, /没有给出有效结论/);
  assert.equal(runHook(approve(automode("echo ok"))).stdout, "");
});

test("作为 hook 运行：其他命令无输出", () => {
  assert.equal(runHook("ls -la").stdout, "");
});
