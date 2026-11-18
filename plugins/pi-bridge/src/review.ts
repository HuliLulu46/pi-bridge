import { rmSync, writeFileSync } from "node:fs";
import { collectReview, NUL_MARKER, type ReviewPatch, type ReviewScope } from "./git.ts";
import { reviewPatchPath } from "./store.ts";

interface ReviewOptions {
  cwd: string;
  scope: ReviewScope;
  focus?: string;
}

const INLINE_LIMIT = 200 * 1024;
/** pi 的 read 工具单次最多返回 50 KB，读不了超过该大小的单行；4000 个码点最多 16 KB */
const WRAP_WIDTH = 4000;
const CONTINUATION = "↩";

function scopeText(scope: ReviewScope): string {
  switch (scope.kind) {
    case "head":
      return "工作区相对 HEAD 的全部改动（含未提交、未跟踪的文件）";
    case "staged":
      return "已暂存的改动";
    case "base":
      return `相对分支 ${scope.ref} 分叉点的全部改动（含未提交、未跟踪的文件）`;
  }
}

/** 按码点把超长的行切成多行，非末段的行尾加续行标记 */
function wrapLongLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= WRAP_WIDTH) return line;
      const chars = [...line];
      const parts: string[] = [];
      for (let i = 0; i < chars.length; i += WRAP_WIDTH) parts.push(chars.slice(i, i + WRAP_WIDTH).join(""));
      return parts.join(`${CONTINUATION}\n`);
    })
    .join("\n");
}

function buildMessage(review: ReviewPatch, patchFile: string | undefined, opts: ReviewOptions): string {
  const changes = patchFile
    ? [
        `补丁超过 ${INLINE_LIMIT / 1024} KB，完整内容在文件 ${patchFile}，请用 read 工具分段读完再下结论。` +
          `文件中超过 ${WRAP_WIDTH} 个字符的行已被拆成多行，行尾的 ${CONTINUATION} 表示下一行与本行原本是同一行。`,
        `改动统计：\n${review.stat}`,
      ].join("\n\n")
    : `\`\`\`diff\n${review.patch}\n\`\`\``;
  const untracked = review.untracked.length > 0 ? `\n\n未跟踪的新文件：\n${review.untracked.join("\n")}` : "";
  const nul = review.patch.includes(NUL_MARKER) ? `\n\n补丁中的 ${NUL_MARKER} 表示原文件中的 NUL 字节。` : "";
  const focus = opts.focus ? `\n\n## 额外关注点\n${opts.focus}` : "";

  return `你是代码评审者，只找问题，不修改任何文件（你只有只读工具）。

## 评审范围
${scopeText(opts.scope)}。当前目录是仓库根目录。${focus}

## 改动
${changes}${untracked}${nul}

## 要求
- 需要上下文时，用 read、grep、find、ls 阅读仓库中的相关代码。
- 重点找：正确性错误、边界情况与失败路径、与现有代码的冲突、安全问题、测试缺口。
- 不提风格或措辞类意见，不提与本次改动无关的问题。

## 输出格式
## 结论：通过 / 有问题
1. [高|中|低] <文件>:<行号> — <问题> — <建议>
（按严重程度从高到低排列；没有问题就只写结论）`;
}

/** 补丁只供本次评审读取：独占创建、仅本人可读，评审结束后删除 */
function writePatchFile(patch: string): string {
  const file = reviewPatchPath();
  writeFileSync(file, wrapLongLines(patch), { flag: "wx", mode: 0o600 });
  return file;
}

interface PreparedReview {
  /** 仓库根目录，评审会话在此运行 */
  root: string;
  message: string;
  /** 删除补丁文件；评审运行结束后调用 */
  cleanup: () => void;
}

export function prepareReview(opts: ReviewOptions): PreparedReview {
  const review = collectReview(opts.cwd, opts.scope);
  if (!review) throw new Error("没有可评审的改动");
  const patchFile = Buffer.byteLength(review.patch) > INLINE_LIMIT ? writePatchFile(review.patch) : undefined;
  return {
    root: review.root,
    message: buildMessage(review, patchFile, opts),
    cleanup: () => {
      if (patchFile) rmSync(patchFile, { force: true });
    },
  };
}
