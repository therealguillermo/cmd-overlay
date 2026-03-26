# cmd-overlay

A transparent, always-on-top terminal overlay for Windows with a built-in AI OS agent. Sits in the bottom-right corner of your screen, runs real shell sessions, and lets you control your computer with natural language using the `??` trigger.

## Setup

**Requirements:** Node.js, npm, an Anthropic API key.

```bash
npm install
```

Set your API key in your environment:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Or add it permanently via System Properties > Environment Variables.

```bash
npm start
```

**Keyboard shortcut:** `Ctrl+\`` toggles show/hide/focus from anywhere on your desktop.

---

## Terminal Usage

Standard multi-tab terminal overlay. Supports PowerShell, CMD, WSL, and Git Bash (auto-detected).

| Shortcut | Action |
|---|---|
| `Ctrl+\`` | Toggle overlay (global) |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Ctrl+1`–`9` | Jump to tab by number |

---

## AI Agent (`??` trigger)

Type `??` at any point in the terminal to enter agent mode. The input is intercepted before it reaches the shell — the PTY never sees it.

```
?? open chrome and go to github
?? what processes are using the most CPU right now
?? create a folder called projects on my desktop
?? find all .log files in my Documents folder larger than 1MB
```

Press **Enter** to submit. Press **Ctrl+C** to cancel before submitting.

The agent streams its response directly into the terminal. Tool calls are shown in yellow, results in gray. After the agent finishes, normal shell input resumes.

### How it works

The agent runs `claude-opus-4-6` in an agentic loop. Claude decides which tools to call, executes them, reads the results, and loops until the task is complete — all without you managing individual steps.

---

## Supported Capabilities

### Shell Commands (`run_command`)
Executes PowerShell commands and returns stdout/stderr. Claude can chain multiple commands across loop iterations.

- File and folder operations (create, read, move, delete, search)
- System information (CPU, memory, disk, network, running processes)
- Process management (start, stop, query)
- Environment variables
- Package managers (`winget`, `npm`, `pip`, `choco`, etc.)
- Git operations
- Registry queries (read)
- Any PowerShell-compatible command

### Browser (`open_url`)
Opens any URL in your default browser.

- Navigate to websites
- Open local files in the browser (`file:///...`)

### Launch Applications (`launch_app`)
Starts any installed application by name or executable path via `Start-Process`.

- `notepad`, `calc`, `mspaint`, `taskmgr`
- `chrome`, `firefox`, `code`, `spotify`
- Any `.exe` by name (if on PATH) or full path

### Multi-Step Tasks
Claude loops automatically — it can run a command, read the output, decide what to do next, and keep going until the goal is reached. You don't manage the steps.

---

## Not Yet Supported

| Capability | Notes |
|---|---|
| **Screen vision** | Claude cannot see what's on screen. It works blind — no screenshots, no reading window content. |
| **Mouse & keyboard control** | No clicking, dragging, or typing into other applications. Would require `robotjs` or a similar library. |
| **Long-running commands** | Hard 30-second timeout per command. Builds, large installs, or slow scripts will be cut off. |
| **Interactive programs** | Can't respond to mid-command prompts (e.g., `y/n` confirmations, password inputs). |
| **Conversation memory** | Each `??` prompt starts a fresh session. The agent has no memory of previous `??` prompts. |
| **File read/write tools** | No dedicated `read_file`/`write_file` tools — Claude has to use PowerShell (`Get-Content`, `Set-Content`) to do this, which works but is less reliable for binary files or large content. |
| **Clipboard access** | Can read/write clipboard via PowerShell (`Get-Clipboard`/`Set-Clipboard`), but only if Claude thinks to use it. |
| **Notifications** | No way to push a desktop notification when a long agent task completes. |

---

## Architecture

```
renderer.js         — xterm.js UI, tab management, ?? interception
  │
  │  IPC (Electron)
  │
main.js             — PTY management (node-pty), window controls, agent:run handler
  │
agent.js            — Claude API agentic loop (@anthropic-ai/sdk)
  │                   Tools: run_command, open_url, launch_app
agent-tools.js      — Lower-level tool implementations with path validation
```

The `??` trigger is intercepted entirely in the renderer — the shell process never sees it. Input is buffered locally, echoed manually to xterm, and sent to `agent:run` over IPC on Enter. Agent output streams back via `agent:output` events and is written directly into the active xterm instance.

---

## Dependencies

| Package | Purpose |
|---|---|
| `electron` | App shell, window management, IPC |
| `node-pty` | Real PTY processes for the terminal |
| `xterm` + `xterm-addon-fit` | Terminal renderer |
| `@anthropic-ai/sdk` | Claude API client for the agent loop |
