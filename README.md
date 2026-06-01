# pi-cp

Slack-ready rich clipboard commands for [pi](https://github.com/earendil-works/pi-coding-agent) assistant responses.

Copies assistant messages as **rich HTML + plain text** so they paste with formatting into Slack, docs, email, and other rich-text targets — while still degrading to plain text everywhere else.

## Install

```bash
pi install git:github.com/tianrendong/pi-cp
```

Or add it to your `settings.json` `packages`/`extensions`.

## Commands

| Command | Behavior |
| --- | --- |
| `/cp` | Copy the **last** assistant response. |
| `/cp 2` | Copy assistant message **#2** (1-indexed over assistant messages). |
| `/cp range 2:4` | Copy assistant messages **2–4** inclusive, joined with `\n\n---\n\n`. |
| `/cp-interactive` | Open an editor pre-filled with the selection so you can trim it, then copy. |

## Shortcuts

| Shortcut | Behavior |
| --- | --- |
| `ctrl+shift+c` | Copy the last assistant response. |

## How copy works

The markdown of the selected message(s) is converted to HTML with Slack-ish styling and placed on the clipboard as both rich HTML and plain text.

Platform clipboard backends, in order:

- **macOS** — rich copy via `osascript` (HTML + plain), falling back to `pbcopy`.
- **Termux** — `termux-clipboard-set`.
- **Linux (Wayland)** — `wl-copy`.
- **Linux (X11)** — `xclip`, falling back to `xsel`.
- **Final fallback** — OSC 52 terminal escape (when the base64 payload is ≤ 100k).

If nothing succeeds, the command reports a copy failure.

## Markdown support

A tiny dependency-free renderer handles:

- Fenced code blocks (```lang```), headings (`#`/`##`/`###`), blockquotes (`>`)
- Unordered (`-`/`*`) and ordered (`1.`/`1)`) lists, paragraphs
- Inline: `` `code` ``, `[links](https://…)`, `**bold**`, `*italic*`

HTML is escaped before inline formatting is applied.
