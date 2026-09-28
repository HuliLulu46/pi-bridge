// 假 pi 的文件操作：消息为 write:<文件> 时在当前目录写文件，commit:<文件> 时写文件并提交
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export function applyFileAction(message) {
  const [action, file] = message.split(":", 2);
  if ((action !== "write" && action !== "commit") || !file) return;
  writeFileSync(file, `${message}\n`);
  if (action === "commit") {
    execFileSync("git", ["add", file]);
    execFileSync("git", ["commit", "-q", "-m", message]);
  }
}
