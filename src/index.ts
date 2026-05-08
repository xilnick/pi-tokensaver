/**
 * TokenSave Pi Extension
 *
 * Automatic lifecycle manager for the tokensave CLI tool.
 * Tokensave is a Rust-based local semantic graph engine that reduces token
 * usage during code exploration by exposing an MCP server with read-only
 * graph tools.
 *
 * Lifecycle phases:
 *   1. Initialization  – sync the semantic graph, ensure .gitignore hygiene
 *   2. MCP Registration – spawn tokensave serve, discover tools, bridge as Pi tools
 *   3. System Prompt    – inject a rule telling the agent to prefer tokensave tools
 *   4. Teardown         – kill the tokensave serve process on session end
 *
 * Placement (project-local):
 *   .pi/extensions/tokensave/index.ts
 *
 * Or globally:
 *   ~/.pi/agent/extensions/tokensave/index.ts
 *
 * Requires: Node.js 18+ (for ReadableStream / TextDecoderStream),
 *           tokensave binary on PATH (cargo install tokensave)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// JSON-RPC helpers (MCP runs over JSON-RPC 2.0 on stdio)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// MCP Client – communicates with tokensave over stdio JSON-RPC
// ---------------------------------------------------------------------------

export class McpClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";

  /**
   * Spawn the MCP server process and wire up stdio message framing.
   * The MCP spec uses newline-delimited JSON over stdout.
   */
  start(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolveStart, rejectStart) => {
      this.proc = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
      });

      this.proc.on("error", (err) => {
        // Reject any pending requests
        for (const [, p] of this.pending) {
          p.reject(new Error(`tokensave process error: ${err.message}`));
        }
        this.pending.clear();
        rejectStart(err);
      });

      this.proc.stdout!.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        // MCP messages are newline-delimited JSON
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop()!; // keep incomplete tail
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse;
            const id = msg.id;
            const entry = this.pending.get(id);
            if (entry) {
              this.pending.delete(id);
              if (msg.error) {
                entry.reject(
                  new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)
                );
              } else {
                entry.resolve(msg.result);
              }
            }
          } catch {
            // Non-JSON line (e.g. startup logs) – ignore
          }
        }
      });

      this.proc.on("close", (code) => {
        for (const [, p] of this.pending) {
          p.reject(new Error(`tokensave exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Mark as started once process is running
      if (this.proc.pid) {
        resolveStart();
      } else {
        this.proc.on("spawn", () => resolveStart());
      }
    });
  }

  /**
   * Send a JSON-RPC request and await the response.
   */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || !this.proc.stdin?.writable) {
      return Promise.reject(new Error("tokensave MCP server not running"));
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin?.writable) return;
    const msg = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Gracefully shut down the MCP server process.
   */
  async stop(): Promise<void> {
    if (!this.proc) return;
    // Try clean shutdown via MCP protocol first
    try {
      this.notify("shutdown");
      // Give it a moment to flush
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      // Best-effort
    }
    this.proc.kill("SIGTERM");

    // Force-kill after 3 seconds if still running
    const forceTimeout = setTimeout(() => {
      this.proc?.kill("SIGKILL");
    }, 3000);

    this.proc.on("close", () => clearTimeout(forceTimeout));
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// TokenSave Extension – main class
// ---------------------------------------------------------------------------

export class TokenSaveExtension {
  private pi: ExtensionAPI;
  private mcpClient: McpClient;
  private projectRoot: string;
  private initialized = false;
  private registeredToolNames: string[] = [];

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.mcpClient = new McpClient();
    this.projectRoot = ""; // resolved on session_start
  }

  // ---- Phase 1: Initialization ----

  /**
   * Detect project root, sync the semantic graph, and ensure .gitignore
   * includes the tokensave data directory.
   */
  async initialize(cwd: string): Promise<void> {
    this.projectRoot = cwd;

    // 1. Verify tokensave binary is available
    const binaryCheck = await this.execCommand("which", ["tokensave"]);
    if (binaryCheck.code !== 0) {
      throw new Error(
        "tokensave command not found.\n" +
        "Please install it with: cargo install tokensave\n" +
        "See https://github.com/nicr9/tokensave for more details."
      );
    }

    // 2. Run tokensave sync in the background to update the semantic graph
    const syncResult = await this.execCommand("tokensave", ["sync"], cwd);
    if (syncResult.code !== 0) {
      throw new Error(
        `tokensave sync failed (exit ${syncResult.code}):\n${syncResult.stderr}`
      );
    }

    // 3. Ensure .tokensave/ is in .gitignore
    await this.ensureGitignore();
    this.initialized = true;
  }

  /**
   * Append `.tokensave/` to .gitignore if git does not already ignore it.
   * Uses `git check-ignore` so global .gitignore files are respected.
   */
  private async ensureGitignore(): Promise<void> {
    const inRepo = await this.execCommand("git", ["rev-parse", "--is-inside-work-tree"]);
    if (inRepo.code !== 0) return;

    // git check-ignore: 0 = ignored, 1 = not ignored, 128 = error.
    // Only append when git definitively says "not ignored".
    const ignored = await this.execCommand("git", ["check-ignore", "-q", ".tokensave/"]);
    if (ignored.code !== 1) return;

    const gitignorePath = join(this.projectRoot, ".gitignore");
    const entry = "\n# TokenSave semantic graph data\n.tokensave/\n";
    await appendFile(gitignorePath, entry);
  }

  // ---- Phase 2: MCP Registration ----

  /**
   * Spawn tokensave serve, perform MCP handshake, discover tools,
   * and register each as a Pi custom tool.
   */
  async registerMcpTools(): Promise<void> {
    if (!this.initialized) {
      throw new Error("Cannot register MCP tools before initialization");
    }

    // Spawn the long-running MCP server process
    await this.mcpClient.start("tokensave", ["serve"], this.projectRoot);

    // Perform MCP initialization handshake
    await this.mcpClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "pi-tokensaver",
        version: "1.0.0",
      },
    });

    // Send initialized notification to complete handshake
    this.mcpClient.notify("notifications/initialized");

    // Discover available tools from the MCP server
    const toolsResult = (await this.mcpClient.request("tools/list", {})) as {
      tools: McpToolDefinition[];
    };

    if (!toolsResult?.tools?.length) {
      // No tools available – still mark as initialized but skip registration
      return;
    }

    // Convert each MCP tool schema into a TypeBox schema for Pi registration
    for (const mcpTool of toolsResult.tools) {
      this.registerMcpToolAsPiTool(mcpTool);
    }
  }

  /**
   * Bridge a single MCP tool definition into a Pi custom tool.
   * When the LLM calls the Pi tool, we forward the call to tokensave
   * via the MCP protocol and return the result.
   */
  private registerMcpToolAsPiTool(mcpTool: McpToolDefinition): void {
    const toolName = `tokensave_${mcpTool.name}`;
    this.registeredToolNames.push(toolName);

    const parameters = this.convertMcpSchemaToTypeBox(mcpTool.inputSchema);

    // Capture the MCP client in a closure so the tool execute function
    // can forward calls to the tokensave server process.
    const mcpClient = this.mcpClient;

    this.pi.registerTool({
      name: toolName,
      label: `TokenSave: ${mcpTool.name}`,
      description:
        mcpTool.description ||
        `Semantic code exploration via tokensave (${mcpTool.name})`,
      promptSnippet: `Explore the codebase using semantic graph via ${toolName}`,
      promptGuidelines: [
        `Prefer ${toolName} over raw grep/glob/read for code exploration tasks.`,
        `These tools use a pre-built semantic index and are far more token-efficient.`,
      ],
      parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal?: AbortSignal
      ) {
        const emptyDetails: { mcpTool?: string; isError?: boolean } = {};

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Cancelled" }],
            details: emptyDetails,
          };
        }

        try {
          const result = (await mcpClient.request("tools/call", {
            name: mcpTool.name,
            arguments: params,
          })) as {
            content?: Array<{ type: string; text?: string; data?: string }>;
            isError?: boolean;
          };

          // Convert MCP tool result to Pi tool result format
          const textParts: string[] = [];
          if (result.content) {
            for (const part of result.content) {
              if (part.type === "text" && part.text) {
                textParts.push(part.text);
              }
            }
          }

          return {
            content: [
              {
                type: "text",
                text: textParts.join("\n") || "(no output)",
              },
            ],
            details: { mcpTool: mcpTool.name, isError: result.isError } as Record<string, unknown>,
            isError: result.isError ?? false,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `tokensave tool error: ${(err as Error).message}`,
              },
            ],
            details: emptyDetails,
            isError: true,
          };
        }
      },
    });
  }

  /**
   * Convert an MCP JSON Schema inputSchema into a TypeBox schema object.
   *
   * MCP tools provide standard JSON Schema. We use TypeBox's Unsafe/Object
   * to pass it through directly, since Pi validates parameters against the
   * schema at execution time.
   */
  private convertMcpSchemaToTypeBox(
    schema: McpToolDefinition["inputSchema"]
  ) {
    // Use Type.Unsafe to pass through arbitrary JSON Schema that
    // TypeBox may not have direct constructors for
    if (schema.properties && Object.keys(schema.properties).length > 0) {
      // Build a TypeBox Object from the properties
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        // If a description is present in the property, wrap it
        properties[key] = value;
      }

      return Type.Object(
        properties as Record<string, ReturnType<typeof Type.Unsafe>>,
        {
          // Pass required array through if present
          ...(schema.required ? { required: schema.required } : {}),
        }
      );
    }

    // Fallback: empty object schema
    return Type.Object({});
  }

  /** Expose the number of registered tools for the status bar. */
  getRegisteredToolCount(): number {
    return this.registeredToolNames.length;
  }

  // ---- Phase 3: System Prompt Injection ----

  /**
   * Return a modified system prompt that instructs the agent to prefer
   * tokensave MCP tools over raw file exploration.
   */
  getSystemPromptSuffix(): string {
    if (this.registeredToolNames.length === 0) {
      return "";
    }

    return [
      "",
      "## TokenSave Semantic Graph Tools",
      "",
      "CRITICAL: Always use the tokensave_* MCP tools to explore the codebase.",
      "These tools query a pre-built local semantic graph and are dramatically",
      "more token-efficient than reading whole files or using raw grep/glob.",
      "",
      "Available tokensave tools: " + this.registeredToolNames.join(", "),
      "",
      "Do NOT use raw grep, glob, or read whole files unless the tokensave",
      "tools genuinely cannot answer the query (e.g., viewing exact file content",
      "at specific line numbers or binary files).",
      "",
    ].join("\n");
  }

  // ---- Phase 4: Teardown ----

  /**
   * Gracefully kill the tokensave serve process.
   */
  async teardown(): Promise<void> {
    await this.mcpClient.stop();
    this.initialized = false;
    this.registeredToolNames = [];
  }

  // ---- Utilities ----

  /**
   * Execute a command and capture its output. Simple wrapper around
   * child_process.spawn for one-shot commands.
   */
  private execCommand(
    command: string,
    args: string[],
    cwd?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: cwd || this.projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
      child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });

      child.on("error", (err) => {
        resolve({
          code: 1,
          stdout: "",
          stderr: err.message,
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function tokensaveExtension(pi: ExtensionAPI) {
  const ext = new TokenSaveExtension(pi);

  // ── Phase 1 & 2: Initialization + MCP Registration ──
  //
  // On session_start we detect the project root, run tokensave sync,
  // ensure .gitignore hygiene, then spawn the MCP server and bridge
  // its tools into Pi.
  pi.on("session_start", async (_event, ctx) => {
    try {
      ctx.ui.setStatus("tokensave", "⟳ Initializing tokensave...");

      // Phase 1: Initialize (sync + gitignore)
      // Use ctx.cwd which provides the current working directory
      await ext.initialize(ctx.cwd);

      // Phase 2: Spawn MCP server and register tools
      await ext.registerMcpTools();

      const toolCount = ext.getRegisteredToolCount();
      ctx.ui.setStatus(
        "tokensave",
        `✓ tokensave ready (${toolCount} tools)`
      );
      ctx.ui.notify("TokenSave extension loaded successfully", "info");
    } catch (err) {
      const msg = (err as Error).message;
      ctx.ui.setStatus("tokensave", `✗ tokensave error`);
      ctx.ui.notify(`TokenSave: ${msg}`, "error");

      // Don't throw – let the session continue without tokensave
      // The user will see the notification with installation instructions
    }
  });

  // ── Phase 3: System Prompt Injection ──
  //
  // Inject a rule into the system prompt on every agent turn telling
  // the LLM to prefer tokensave tools over raw file operations.
  pi.on("before_agent_start", async (event) => {
    const suffix = ext.getSystemPromptSuffix();
    if (!suffix) return;
    return {
      systemPrompt: event.systemPrompt + suffix,
    };
  });

  // ── Phase 4: Teardown ──
  //
  // When the session ends (Ctrl+C, Ctrl+D, SIGTERM, /new, /resume),
  // gracefully kill the tokensave serve child process to prevent
  // zombie processes.
  pi.on("session_shutdown", async () => {
    await ext.teardown();
  });
}
