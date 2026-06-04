import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Message extraction
// ---------------------------------------------------------------------------

/** A nonempty assistant message with its 1-indexed assistant position. */
interface AssistantMessage {
  index: number; // 1-indexed over nonempty assistant messages
  text: string; // joined, trimmed markdown text
}

/**
 * Pull all nonempty assistant messages from the current branch, assigning
 * each a 1-indexed assistant position.
 */
function collectAssistantMessages(ctx: ExtensionContext): AssistantMessage[] {
  const result: AssistantMessage[] = [];
  let index = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if ((entry as { type?: string }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message as
      | { role?: string; content?: unknown }
      | undefined;
    if (!message || message.role !== "assistant") continue;

    const text = extractText(message.content);
    if (!text) continue; // skip empty assistant messages

    index += 1;
    result.push({ index, text });
  }

  return result;
}

/** Join all `{ type: "text" }` parts of a content array and trim. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("").trim();
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const RANGE_JOINER = "\n\n---\n\n";

/**
 * Select markdown text from assistant messages based on the command args.
 * Throws an Error (with a user-facing message) on bad input; returns null
 * when there are no assistant messages at all.
 */
function selectText(messages: AssistantMessage[], args: string): string | null {
  if (messages.length === 0) return null;

  const trimmed = args.trim();

  // empty => last assistant message
  if (trimmed === "") {
    return messages[messages.length - 1].text;
  }

  // range a:b => inclusive range
  if (trimmed.startsWith("range")) {
    const rest = trimmed.slice("range".length).trim();
    const match = /^(\d+):(\d+)$/.exec(rest);
    if (!match) {
      throw new Error("Usage: /cp range a:b");
    }
    const a = Number(match[1]);
    const b = Number(match[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    const selected = messages.filter((m) => m.index >= lo && m.index <= hi);
    if (selected.length === 0) {
      throw new Error(`No assistant messages in range ${a}:${b}`);
    }
    return selected.map((m) => m.text).join(RANGE_JOINER);
  }

  // number => nth assistant message, 1-indexed
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Message index must be positive integer");
  }
  const n = Number(trimmed);
  if (n < 1) {
    throw new Error("Message index must be positive integer");
  }
  const found = messages.find((m) => m.index === n);
  if (!found) {
    throw new Error(`Assistant message #${n} not found`);
  }
  return found.text;
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

/** Run a command with no stdin, capturing stderr. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
  });
}

/** Run a command, writing `input` to stdin, capturing stderr. */
function runWithInput(
  command: string,
  args: string[],
  input: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isTermux = Boolean(process.env.TERMUX_VERSION || process.env.PREFIX?.includes("com.termux"));
const isWayland = Boolean(process.env.WAYLAND_DISPLAY);

/** Copy markdown as rich HTML + plain text, with platform fallbacks. */
async function copyRich(markdown: string): Promise<void> {
  const html = renderHtmlDocument(markdown);

  if (isMac) {
    try {
      await macRichCopy(markdown, html);
      return;
    } catch {
      // fall back to plain copy below
    }
  }

  await copyPlain(markdown);
}

/** Plain-text clipboard copy across platforms, with an OSC52 final fallback. */
async function copyPlain(text: string): Promise<void> {
  if (isMac) {
    await runWithInput("pbcopy", [], text);
    return;
  }

  if (isTermux) {
    await runWithInput("termux-clipboard-set", [], text);
    return;
  }

  if (isLinux) {
    if (isWayland) {
      await runWithInput("wl-copy", [], text);
      return;
    }
    try {
      await runWithInput("xclip", ["-selection", "clipboard"], text);
      return;
    } catch {
      try {
        await runWithInput("xsel", ["--clipboard", "--input"], text);
        return;
      } catch {
        // fall through to OSC52
      }
    }
  }

  // Final fallback: OSC52 escape sequence.
  const base64 = Buffer.from(text, "utf8").toString("base64");
  if (base64.length <= 100_000) {
    process.stdout.write(`\u001b]52;c;${base64}\u0007`);
    return;
  }

  throw new Error("Failed to copy to clipboard");
}

/** macOS rich copy via osascript JavaScript: sets plain + HTML pasteboard types. */
async function macRichCopy(plain: string, html: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-cp-"));
  try {
    const plainPath = join(dir, "plain.txt");
    const htmlPath = join(dir, "content.html");
    await writeFile(plainPath, plain, "utf8");
    await writeFile(htmlPath, html, "utf8");

    const script = `
ObjC.import('AppKit');
ObjC.import('Foundation');
function run(argv) {
  var plainPath = argv[0];
  var htmlPath = argv[1];
  var plain = $.NSString.stringWithContentsOfFileEncodingError(plainPath, $.NSUTF8StringEncoding, null);
  var html = $.NSString.stringWithContentsOfFileEncodingError(htmlPath, $.NSUTF8StringEncoding, null);
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setStringForType(plain, $.NSPasteboardTypeString);
  pb.setStringForType(html, 'public.html');
  pb.setStringForType(html, 'text/html');
}
`.trim();

    await run("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      script,
      plainPath,
      htmlPath,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer (minimal, dependency-free)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Apply inline formatting to already-escaped text segments. */
function renderInline(text: string): string {
  // Protect inline code spans first.
  const codes: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    const escaped = escapeHtml(code);
    codes.push(`<code>${escaped}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // Escape the remaining text.
  out = escapeHtml(out);

  // Links: [text](https://...)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => `<a href="${url}">${label}</a>`,
  );

  // Bold then italic.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // Restore code spans.
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => codes[Number(i)]);

  return out;
}

/** Convert markdown to an HTML fragment (no wrapper). */
function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      const cls = lang ? ` class="language-${lang}"` : "";
      blocks.push(
        `<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Headings
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(
          `<li>${renderInline(lines[i].replace(/^\d+[.)]\s+/, ""))}</li>`,
        );
        i += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Preserve blank source lines. Rich-text paste targets such as Slack ignore
    // whitespace between HTML blocks, so emit an explicit break.
    if (line.trim() === "") {
      blocks.push("<br>");
      i += 1;
      continue;
    }

    // Paragraph (consume consecutive non-blank, non-special lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  return blocks.join("\n");
}

/** Wrap a rendered fragment in a full HTML document with Slack-ish CSS. */
function renderHtmlDocument(markdown: string): string {
  const body = renderMarkdown(markdown);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.46668;
    color: #1d1c1d;
  }
  p, ul, ol { margin: 0 0 8px; }
  h1, h2, h3 { margin: 12px 0 6px; font-weight: 700; }
  h1 { font-size: 22px; }
  h2 { font-size: 18px; }
  h3 { font-size: 16px; }
  ul, ol { padding-left: 22px; }
  li { margin: 2px 0; }
  code {
    font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
    font-size: 12px;
    background: #f6f8fa;
    border: 1px solid #d1d5da;
    border-radius: 3px;
    padding: 1px 4px;
  }
  pre {
    background: #f6f8fa;
    border: 1px solid #d1d5da;
    border-radius: 6px;
    padding: 12px;
    overflow: auto;
    margin: 0 0 8px;
  }
  pre code {
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
  }
  blockquote {
    margin: 0 0 8px;
    padding: 0 12px;
    border-left: 4px solid #dfe2e5;
    color: #6a737d;
  }
  a { color: #1264a3; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  /** Resolve selected text from args, notifying on the no-messages case. */
  function resolveSelection(
    ctx: ExtensionContext,
    args: string,
  ): string | null {
    const messages = collectAssistantMessages(ctx);
    const text = selectText(messages, args);
    if (text === null) {
      ctx.ui.notify("No assistant message found", "warning");
      return null;
    }
    return text;
  }

  pi.registerCommand("cp", {
    description:
      "Copy assistant response as rich text (no args=last, N=#N, range a:b)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const text = resolveSelection(ctx, args);
        if (text === null) return;
        await copyRich(text);
        ctx.ui.notify("Copied to clipboard", "info");
      } catch (err) {
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
      }
    },
  });

  pi.registerCommand("cp-interactive", {
    description: "Edit an assistant response before copying as rich text",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const text = resolveSelection(ctx, args);
        if (text === null) return;

        const edited = await ctx.ui.editor("Edit before copying:", text);
        if (!edited || edited.trim() === "") {
          ctx.ui.notify("Copy cancelled", "info");
          return;
        }
        await copyRich(edited);
        ctx.ui.notify("Copied to clipboard", "info");
      } catch (err) {
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
      }
    },
  });

  pi.registerShortcut("ctrl+shift+c", {
    description: "Copy last assistant response as rich text",
    handler: async (ctx: ExtensionContext) => {
      try {
        const text = resolveSelection(ctx, "");
        if (text === null) return;
        await copyRich(text);
        ctx.ui.notify("Copied to clipboard", "info");
      } catch (err) {
        ctx.ui.notify(
          err instanceof Error ? err.message : String(err),
          "error",
        );
      }
    },
  });
}
