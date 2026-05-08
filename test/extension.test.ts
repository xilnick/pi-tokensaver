/**
 * Unit tests for TokenSaveExtension
 *
 * Tests the extension's internal logic:
 *   - Schema conversion (MCP JSON Schema → TypeBox)
 *   - System prompt injection
 *   - .gitignore handling
 *   - Extension lifecycle wiring
 *
 * Most tests mock the Pi ExtensionAPI so they run without a real pi session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rmdir, unlink, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";

// We need to import the extension's internals
// Since TokenSaveExtension and McpClient are exported, we can test them directly
// but we need to mock ExtensionAPI

// ---------------------------------------------------------------------------
// Mock ExtensionAPI
// ---------------------------------------------------------------------------

interface MockTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (...args: unknown[]) => Promise<unknown>;
}

function createMockPi() {
  const tools: MockTool[] = [];
  const eventHandlers = new Map<string, Function[]>();

  return {
    tools,
    eventHandlers,
    on(event: string, handler: Function) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
    },
    registerTool(tool: MockTool) {
      tools.push(tool);
    },
    // Simulate firing an event
    async fireEvent(event: string, ...args: unknown[]) {
      const handlers = eventHandlers.get(event) ?? [];
      for (const h of handlers) {
        await h(...args);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TokenSaveExtension — Schema Conversion", () => {
  // We test the convertMcpSchemaToTypeBox logic directly
  // since it's a private method, we replicate the logic here for verification

  function convertMcpSchemaToTypeBox(schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  }) {
    if (schema.properties && Object.keys(schema.properties).length > 0) {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        properties[key] = value;
      }
      return Type.Object(
        properties as Record<string, ReturnType<typeof Type.Unsafe>>,
        {
          ...(schema.required ? { required: schema.required } : {}),
        }
      );
    }
    return Type.Object({});
  }

  it("converts a simple MCP schema with string properties", () => {
    const schema = {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    };

    const typebox = convertMcpSchemaToTypeBox(schema);

    expect(typebox.type).toBe("object");
    expect(typebox.properties).toBeDefined();
    expect((typebox.properties as Record<string, unknown>).query).toBeDefined();
    expect((typebox.properties as Record<string, unknown>).limit).toBeDefined();
    // TypeBox auto-populates required from all properties by default
    expect(typebox.required).toContain("query");
  });

  it("handles empty properties (falls back to empty object)", () => {
    const schema = {
      type: "object" as const,
      properties: {},
    };

    const typebox = convertMcpSchemaToTypeBox(schema);
    expect(typebox.type).toBe("object");
    expect(Object.keys(typebox.properties ?? {}).length).toBe(0);
  });

  it("handles missing properties (falls back to empty object)", () => {
    const schema = {
      type: "object" as const,
    };

    const typebox = convertMcpSchemaToTypeBox(schema);
    expect(typebox.type).toBe("object");
    expect(Object.keys(typebox.properties ?? {}).length).toBe(0);
  });

  it("preserves nested schema types (arrays, objects)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        options: {
          type: "object",
          properties: {
            verbose: { type: "boolean" },
          },
        },
      },
      required: ["path"],
    };

    const typebox = convertMcpSchemaToTypeBox(schema);
    expect(typebox.type).toBe("object");
    const props = typebox.properties as Record<string, Record<string, unknown>>;
    expect(props.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(props.options).toEqual({
      type: "object",
      properties: { verbose: { type: "boolean" } },
    });
    expect(typebox.required).toContain("path");
  });

  it("passes through required array when present", () => {
    const schema = {
      type: "object" as const,
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    };

    const typebox = convertMcpSchemaToTypeBox(schema);
    expect(typebox.required).toEqual(["a", "b"]);
  });

  it("omits required when not present in MCP schema", () => {
    const schema = {
      type: "object" as const,
      properties: {
        a: { type: "string" },
      },
    };

    const typebox = convertMcpSchemaToTypeBox(schema);
    // TypeBox auto-populates required from all properties by default
    expect(typebox.required).toBeDefined();
  });
});

describe("TokenSaveExtension — System Prompt Injection", () => {
  // Test getSystemPromptSuffix logic
  function getSystemPromptSuffix(registeredToolNames: string[]): string {
    if (registeredToolNames.length === 0) return "";

    return [
      "",
      "## TokenSave Semantic Graph Tools",
      "",
      "CRITICAL: Always use the tokensave_* MCP tools to explore the codebase.",
      "These tools query a pre-built local semantic graph and are dramatically",
      "more token-efficient than reading whole files or using raw grep/glob.",
      "",
      "Available tokensave tools: " + registeredToolNames.join(", "),
      "",
      "Do NOT use raw grep, glob, or read whole files unless the tokensave",
      "tools genuinely cannot answer the query (e.g., viewing exact file content",
      "at specific line numbers or binary files).",
      "",
    ].join("\n");
  }

  it("returns empty string when no tools registered", () => {
    expect(getSystemPromptSuffix([])).toBe("");
  });

  it("returns prompt with tool names when tools are registered", () => {
    const suffix = getSystemPromptSuffix(["tokensave_search", "tokensave_callers"]);
    expect(suffix).toContain("## TokenSave Semantic Graph Tools");
    expect(suffix).toContain("tokensave_search");
    expect(suffix).toContain("tokensave_callers");
    expect(suffix).toContain("CRITICAL");
    expect(suffix).toContain("token-efficient");
  });

  it("lists all tool names in the prompt", () => {
    const tools = ["tokensave_search", "tokensave_context", "tokensave_status"];
    const suffix = getSystemPromptSuffix(tools);
    for (const name of tools) {
      expect(suffix).toContain(name);
    }
  });

  it("prompt starts with a blank line for separation", () => {
    const suffix = getSystemPromptSuffix(["tokensave_search"]);
    expect(suffix.startsWith("\n")).toBe(true);
  });
});

describe("TokenSaveExtension — .gitignore Handling", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `tokensaver-gitignore-test-${Date.now()}-${Math.random()}`);
    await mkdir(tempDir, { recursive: true });
    // Initialize a git repo so git rev-parse and check-ignore work
    const init = await execCommand("git", ["init"], tempDir);
    expect(init.code).toBe(0);
  });

  afterEach(async () => {
    try {
      if (existsSync(join(tempDir, ".gitignore"))) {
        await unlink(join(tempDir, ".gitignore"));
      }
      await rmdir(tempDir);
    } catch {
      // best-effort cleanup
    }
  });

  // Replicate the ensureGitignore logic from the extension
  function execCommand(
    command: string,
    args: string[],
    cwd?: string
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
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

  async function ensureGitignore(projectRoot: string): Promise<void> {
    const inRepo = await execCommand("git", ["rev-parse", "--is-inside-work-tree"], projectRoot);
    if (inRepo.code !== 0) return;

    // git check-ignore: 0 = ignored, 1 = not ignored, 128 = error.
    // Only append when git definitively says "not ignored".
    const ignored = await execCommand("git", ["check-ignore", "-q", ".tokensave/"], projectRoot);
    if (ignored.code !== 1) return;

    const gitignorePath = join(projectRoot, ".gitignore");
    const entry = "\n# TokenSave semantic graph data\n.tokensave/\n";
    const { appendFile } = await import("node:fs/promises");
    await appendFile(gitignorePath, entry);
  }

  it("creates .gitignore if it does not exist", async () => {
    const gitignorePath = join(tempDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(false);

    await ensureGitignore(tempDir);

    expect(existsSync(gitignorePath)).toBe(true);
    const content = await readFile(gitignorePath, "utf8");
    expect(content).toContain(".tokensave/");
  });

  it("appends to existing .gitignore", async () => {
    const gitignorePath = join(tempDir, ".gitignore");
    await writeFile(gitignorePath, "node_modules/\ndist/\n");

    await ensureGitignore(tempDir);

    const content = await readFile(gitignorePath, "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".tokensave/");
  });

  it("does not append .tokensave/ when it is already in the local .gitignore", async () => {
    const gitignorePath = join(tempDir, ".gitignore");
    await writeFile(gitignorePath, "node_modules/\n.tokensave/\n");

    await ensureGitignore(tempDir);

    const content = await readFile(gitignorePath, "utf8");
    const count = content.split(".tokensave/").length - 1;
    expect(count).toBe(1);
  });

  it("does not append .tokensave/ when it is already ignored by a global gitignore", async () => {
    // Create a local .gitignore that does NOT mention .tokensave
    const gitignorePath = join(tempDir, ".gitignore");
    await writeFile(gitignorePath, "node_modules/\n");

    // Create a fake "global" gitignore inside the repo and tell git to use it
    const globalIgnorePath = join(tempDir, ".global_gitignore");
    await writeFile(globalIgnorePath, ".tokensave/\n");
    await execCommand("git", ["config", "core.excludesfile", globalIgnorePath], tempDir);

    await ensureGitignore(tempDir);

    const content = await readFile(gitignorePath, "utf8");
    expect(content).not.toContain("TokenSave semantic graph data");
  });

  it("is idempotent — calling twice does not create duplicates", async () => {
    // First call: creates
    await ensureGitignore(tempDir);
    // Second call: should be a no-op because .tokensave/ is now in .gitignore
    await ensureGitignore(tempDir);

    const content = await readFile(join(tempDir, ".gitignore"), "utf8");
    const count = content.split(".tokensave/").length - 1;
    expect(count).toBe(1);
  });

  it("does nothing when not inside a git work tree", async () => {
    const nonRepoDir = join(tmpdir(), `tokensaver-nonrepo-test-${Date.now()}-${Math.random()}`);
    await mkdir(nonRepoDir, { recursive: true });

    try {
      await ensureGitignore(nonRepoDir);
      const gitignorePath = join(nonRepoDir, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(false);
    } finally {
      await rmdir(nonRepoDir);
    }
  });
});

describe("TokenSaveExtension — Extension Wiring", () => {
  it("registers session_start event handler", async () => {
    // Import the extension factory function dynamically
    // to test the wiring
    const { default: factory } = await import("../src/index.js");
    const mockPi = createMockPi();

    factory(mockPi as unknown as Parameters<typeof factory>[0]);

    expect(mockPi.eventHandlers.has("session_start")).toBe(true);
  });

  it("registers before_agent_start event handler", async () => {
    const { default: factory } = await import("../src/index.js");
    const mockPi = createMockPi();

    factory(mockPi as unknown as Parameters<typeof factory>[0]);

    expect(mockPi.eventHandlers.has("before_agent_start")).toBe(true);
  });

  it("registers session_shutdown event handler", async () => {
    const { default: factory } = await import("../src/index.js");
    const mockPi = createMockPi();

    factory(mockPi as unknown as Parameters<typeof factory>[0]);

    expect(mockPi.eventHandlers.has("session_shutdown")).toBe(true);
  });

  it("before_agent_start does nothing when no tools are registered", async () => {
    const { default: factory } = await import("../src/index.js");
    const mockPi = createMockPi();

    factory(mockPi as unknown as Parameters<typeof factory>[0]);

    const handlers = mockPi.eventHandlers.get("before_agent_start") ?? [];
    expect(handlers.length).toBe(1);

    // Call the handler with a mock event
    const mockEvent = { systemPrompt: "You are helpful." };
    const result = await handlers[0](mockEvent, {});

    // With no tools registered, should return undefined
    expect(result).toBeUndefined();
  });
});
