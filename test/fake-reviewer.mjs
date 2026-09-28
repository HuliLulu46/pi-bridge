#!/usr/bin/env node
// 模拟 `claude -p` 复核：待批准内容含 DANGER 判危险，含 BROKEN 输出非 JSON，其余判安全
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  if (input.includes("BROKEN")) process.stdout.write("抱歉，我无法判断\n");
  else if (input.includes("DANGER")) process.stdout.write('{"dangerous": true, "reason": "删除：DANGER"}\n');
  else process.stdout.write('{"dangerous": false, "reason": ""}\n');
});
