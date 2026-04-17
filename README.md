<div align="center">

# 🧠 pi-tokensaver

**Give your AI coding agent a semantic memory for your codebase**

[![npm version](https://img.shields.io/npm/v/pi-tokensaver.svg)](https://www.npmjs.com/package/pi-tokensaver)
[![license](https://img.shields.io/npm/l/pi-tokensaver.svg)](https://github.com/xilnick/pi-tokensaver/blob/main/LICENSE)
[![pi-coding-agent](https://img.shields.io/badge/compatible-pi--coding--agent-blue)](https://github.com/mariozechner/pi-coding-agent)

*A [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension that bridges [tokensave](https://github.com/nicr9/tokensave) — a Rust-powered local semantic graph engine — directly into your AI pair-programming workflow.*

[Why?](#-why) • [How it works](#-how-it-works) • [Install](#-install) • [Usage](#-usage) • [Architecture](#-architecture) • [Configuration](#-configuration)

</div>

---

## 🤔 Why?

When you ask an AI agent to explore a codebase, it typically:
- 🔍 Runs `grep`, `glob`, `find` — scanning thousands of lines
- 📄 Reads entire files just to find one function
- 💸 **Burns through your token budget** on redundant file reads

**tokensave** fixes this by building a **local semantic graph** of your code — functions, types, call relationships, imports — and exposing it as an MCP server with query tools. `pi-tokensaver` bridges that server into the Pi agent, so your AI gets **precision code exploration** instead of brute-force file scanning.

**Result:** Dramatically fewer tokens consumed per codebase query. Your agent finds what it needs in one semantic lookup instead of reading 20 files.

---

## ⚡ How it works

```
┌──────────────────────┐         ┌──────────────────────┐
│                      │         │                      │
│   Pi Coding Agent    │  calls  │   pi-tokensaver      │
│   (LLM)              ├────────►│   (this extension)   │
│                      │         │                      │
└──────────────────────┘         └──────────┬───────────┘
                                            │ JSON-RPC over stdio
                                            ▼
                                 ┌──────────────────────┐
                                 │                      │
                                 │   tokensave serve    │
                                 │   (MCP server)       │
                                 │   queries semantic   │
                                 │   graph locally      │
                                 │                      │
                                 └──────────────────────┘
                                            │ reads
                                            ▼
                                 ┌──────────────────────┐
                                 │   .tokensave/        │
                                 │   (local graph DB)   │
                                 └──────────────────────┘
```

The extension manages the **full lifecycle** automatically:

| Phase | What happens |
|-------|-------------|
| **1. Init** | Runs `tokensave sync` to build/update the semantic graph. Ensures `.tokensave/` is gitignored. |
| **2. Registration** | Spawns `tokensave serve`, performs MCP handshake, discovers all available tools, and bridges each one as a Pi tool prefixed with `tokensave_`. |
| **3. Prompt Injection** | Injects a system prompt rule telling the LLM to prefer tokensave tools over raw grep/glob/read. |
| **4. Teardown** | Gracefully kills the `tokensave serve` process when the Pi session ends. |

---

## 📦 Install

### Prerequisites

1. **[Pi coding agent](https://github.com/mariozechner/pi-coding-agent)** — the AI agent framework.
2. **[tokensave](https://github.com/nicr9/tokensave)** — the Rust semantic graph engine:
   ```bash
   cargo install tokensave
   ```

### Install the extension

One command — installs globally, works across all your projects automatically:

```bash
pi install npm:pi-tokensaver
```

That's it. Pi auto-discovers the extension from the global install. No per-project config needed.

> **Uninstall:** `pi remove npm:pi-tokensaver`

---

## 🚀 Usage

Once installed, it Just Works™ — no manual setup required.

1. **Start a Pi session** in any project directory:
   ```bash
   pi
   ```

2. The extension automatically:
   - Detects and syncs the semantic graph for your project
   - Spawns the MCP server in the background
   - Registers semantic exploration tools (e.g. `tokensave_search`, `tokensave_related`)
   - Tells the LLM to prefer these tools over brute-force file reads

3. **Ask your agent anything** — it will use the semantic graph for efficient exploration:
   > *"Where is the authentication middleware applied?"*
   > *"Which functions call `processPayment`?"*
   > *"Show me the type hierarchy for `UserEvent`"*

### What if tokensave isn't installed?

The extension fails gracefully — you'll see a notification with install instructions, and the Pi session continues normally without tokensave tools.

---

## 🏗️ Architecture

### MCP Client

The extension implements a lightweight **JSON-RPC 2.0 client over stdio** that speaks the [Model Context Protocol](https://modelcontextprotocol.io/). It handles:

- Process lifecycle (spawn, heartbeat, graceful shutdown with SIGTERM→SIGKILL fallback)
- Message framing (newline-delimited JSON)
- Request/response correlation with pending promise tracking
- Clean error propagation from MCP server errors

### Tool Bridge

Each MCP tool discovered from `tokensave serve` is converted into a Pi custom tool:
- **Schema conversion:** MCP JSON Schema → TypeBox schema for Pi parameter validation
- **Call forwarding:** Pi tool calls are proxied to the MCP server via JSON-RPC
- **Result mapping:** MCP response content is flattened into Pi's text-based result format

### Type Safety

Written in strict TypeScript with full type coverage for:
- JSON-RPC message types
- MCP tool definitions and responses
- Pi `ExtensionAPI` surface
- TypeBox schema construction

---

## ⚙️ Configuration

No configuration needed — the extension auto-detects everything from your project root.

### Build from source

```bash
git clone https://github.com/xilnick/pi-tokensaver.git
cd pi-tokensaver
npm install
npm run build
```

---

## 📄 License

[MIT](LICENSE) © contributors

---

<div align="center">

**Made with 🧠 for [Pi](https://github.com/mariozechner/pi-coding-agent) + [tokensave](https://github.com/nicr9/tokensave)**

[Report a Bug](https://github.com/xilnick/pi-tokensaver/issues) · [Request a Feature](https://github.com/xilnick/pi-tokensaver/issues) · [Contribute](https://github.com/xilnick/pi-tokensaver/pulls)

</div>
