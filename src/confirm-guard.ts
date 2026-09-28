// Claude Code PreToolUse hook：Claude 同意 pi 的权限确认（pi-bridge answer … yes）时，
// 被批准的操作命中高风险规则、经 Sonnet 复核认为危险、或无法审查，就强制弹窗交给用户确认
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
}

export type Verdict = { kind: "skip" } | { kind: "ask"; reason: string } | { kind: "review"; action: string };

const RULES: Array<[string, RegExp]> = [
  [
    "删除或覆盖",
    /\b(rm|rmdir|unlink|shred|truncate|mkfs|mv)\b|\bdd\s+if=|git\s+(reset\s+--hard|clean|checkout\s+--|restore|branch\s+-D)|(^|\s)>(?![>&])\s*(?!\/dev\/null)\S|\b(DROP|TRUNCATE)\s+(TABLE|DATABASE)|\bDELETE\s+FROM\b|^\s*(write|edit)\s*\{/im,
  ],
  [
    "推送或对外发送",
    /git\s+push|\b(npm|pnpm|yarn)\s+publish|docker\s+push|\b(curl|wget|ssh|scp|rsync|sftp|ftp|nc|telnet)\b|\bgh\s+(api|\w+\s+(create|merge|close|comment|edit|delete|upload))|\b(kubectl|terraform|aws|gcloud|az)\b|\b(sendmail|mail)\b/i,
  ],
  [
    "工作目录以外或凭据",
    /(^|[\s"'=(])(~\/|\$HOME|\/etc\/|\/usr\/|\/System\/|\/Library\/|\/private\/|\/var\/|\/opt\/)|\.\.\/|\.ssh\b|\.aws\b|\.gnupg\b|\.env\b|id_rsa|credential|secret|token|password|keychain/i,
  ],
  [
    "安装软件或修改系统配置",
    /\bsudo\b|\bbrew\s+(install|uninstall|upgrade|reinstall)|\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b|\bpipx?\s+install\b|\bapt(-get)?\b|\b(chmod|chown|launchctl|crontab|systemctl)\b|defaults\s+write|git\s+config\s+--global/i,
  ],
  ["结束进程或关机", /\b(kill|pkill|killall|shutdown|reboot|halt)\b/i],
];

const APPROVE_RE = /\bpi-bridge\s+answer\s+\S+\s+\S+\s+(y|yes|true|是)(\s|$)/i;
const HEREDOC_RE = /<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1\b/;
const INLINE_ACTION_RE = /--action[ =](?!-(\s|$))('[^']*'|"[^"]*"|\S+)/;

const REVIEW_MODEL = "claude-sonnet-5";
const REVIEW_TIMEOUT_MS = 60_000;
const REVIEW_PROMPT = `另一个 coding agent（pi）请求执行下面的操作。判断批准它是否危险。
属于以下任一情况即为危险，无法判断也算危险：
1. 删除或覆盖文件、目录、数据；
2. 推送或对外发送（git push、发布包、会修改外部状态的网络请求、发消息或邮件）；
3. 访问或修改工作目录以外的路径，读取密钥或凭据；
4. 安装软件，修改系统或全局配置；
5. 其他不可逆的操作。
只输出一行 JSON：{"dangerous": true 或 false, "reason": "<类别>：<具体操作>"}

待批准的操作：
`;

export function classify(command: string): Verdict {
  if (!APPROVE_RE.test(command)) return { kind: "skip" };
  const action = INLINE_ACTION_RE.exec(command)?.[2] ?? HEREDOC_RE.exec(command)?.[2];
  if (action === undefined) return { kind: "ask", reason: "确认内容不在命令里，无法审查被批准的操作" };
  const hits = RULES.filter(([, re]) => re.test(action)).map(([label]) => label);
  if (hits.length > 0) return { kind: "ask", reason: `被批准的操作涉及：${hits.join("、")}` };
  return { kind: "review", action };
}

/** 调用 Sonnet 复核；返回需要用户确认的原因，安全时返回 undefined。复核失败按需要确认处理 */
export async function review(action: string): Promise<string | undefined> {
  const args = ["-p", "--model", REVIEW_MODEL, "--setting-sources", "", "--strict-mcp-config", "--tools", ""];
  args.push("--no-session-persistence", "--disable-slash-commands");
  const child = spawn(process.env.PI_BRIDGE_REVIEW_BIN ?? "claude", args, {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "ignore"],
    timeout: REVIEW_TIMEOUT_MS,
  });
  child.stdin.end(REVIEW_PROMPT + action);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk));
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(null));
  });
  try {
    const verdict = JSON.parse(/\{[\s\S]*\}/.exec(output)?.[0] ?? "") as { dangerous?: unknown; reason?: unknown };
    if (verdict.dangerous === false) return undefined;
    if (verdict.dangerous === true) return `Sonnet 复核认为有风险：${verdict.reason}`;
  } catch {
    // 输出不是 JSON，按复核失败处理
  }
  return `Sonnet 复核没有给出有效结论（退出码 ${code}）`;
}

if (import.meta.main) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  const verdict: Verdict = input.tool_name === "Bash" ? classify(input.tool_input?.command ?? "") : { kind: "skip" };
  const reason =
    verdict.kind === "ask" ? verdict.reason : verdict.kind === "review" ? await review(verdict.action) : undefined;
  if (reason) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `pi-bridge：${reason}，需要你确认`,
        },
      }),
    );
  }
}
