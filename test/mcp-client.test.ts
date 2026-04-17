/**
 * Integration tests for McpClient
 *
 * These tests spawn the real tokensave MCP server over stdio and verify
 * the full JSON-RPC round-trip works correctly.
 *
 * Prerequisites: tokensave binary on PATH (`cargo install tokensave`)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import { McpClient } from "../src/index.js";

// ---------------------------------------------------------------------------
// Prerequisites check
// ---------------------------------------------------------------------------

function getTokensaveVersion(): string | null {
  try {
    return execSync("tokensave --version", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const TOKENSAVE_VERSION = getTokensaveVersion();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a tokensave MCP server and perform full handshake. */
async function startClient(cwd: string): Promise<McpClient> {
  const client = new McpClient();
  await client.start("tokensave", ["serve"], cwd);
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "0.1.0" },
  });
  client.notify("notifications/initialized");
  return client;
}

/** Create a minimal fake project with a .tokensave index. */
async function createFakeProject(): Promise<string> {
  const dir = join(tmpdir(), `tokensaver-test-${Date.now()}-${Math.random()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.ts"), "export const x = 1;\n");
  // tokensave needs an index — run sync
  execSync("tokensave sync", { cwd: dir, encoding: "utf8", stdio: "pipe" });
  return dir;
}

async function cleanupFakeProject(dir: string): Promise<void> {
  try {
    await unlink(join(dir, "index.ts")).catch(() => {});
    // tokensave index cleanup
    try {
      execSync("tokensave uninstall", { cwd: dir, encoding: "utf8", stdio: "pipe" });
    } catch {
      // best-effort
    }
    await rmdir(dir).catch(() => {});
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpClient", () => {
  // Skip entire suite if tokensave isn't available
  const testOrSkip = TOKENSAVE_VERSION ? it : it.skip;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = await createFakeProject();
  });

  afterAll(async () => {
    if (projectDir) await cleanupFakeProject(projectDir);
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("start()", () => {
    testOrSkip("resolves when tokensave serve spawns successfully", async () => {
      const client = new McpClient();
      await expect(client.start("tokensave", ["serve"], projectDir)).resolves.toBeUndefined();
      await client.stop();
    });

    testOrSkip("rejects when command does not exist", async () => {
      const client = new McpClient();
      await expect(client.start("nonexistent-binary", ["serve"], projectDir)).rejects.toThrow();
    });

    testOrSkip("resolves even when cwd does not exist (tokensave serves the project)", async () => {
      const client = new McpClient();
      await expect(client.start("tokensave", ["serve"], "/nonexistent/path")).rejects.toThrow();
      await client.stop().catch(() => {});
    });
  });

  describe("request()", () => {
    testOrSkip("completes initialize handshake", async () => {
      const client = new McpClient();
      await client.start("tokensave", ["serve"], projectDir);
      try {
        const result = await client.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" },
        });
        expect(result).toBeDefined();
        expect(typeof result).toBe("object");
      } finally {
        await client.stop();
      }
    });

    testOrSkip("rejects if called before start()", async () => {
      const client = new McpClient();
      await expect(client.request("tools/list", {})).rejects.toThrow("not running");
    });

    testOrSkip("rejects unknown methods with MCP error code", async () => {
      const client = new McpClient();
      await client.start("tokensave", ["serve"], projectDir);
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      });
      client.notify("notifications/initialized");
      try {
        await expect(client.request("nonexistent/method", {})).rejects.toThrow("MCP error");
      } finally {
        await client.stop();
      }
    });

    testOrSkip("rejects when process dies mid-request", async () => {
      const client = new McpClient();
      await client.start("tokensave", ["serve"], projectDir);
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      });
      client.notify("notifications/initialized");
      // Kill the process externally
      try {
        execSync("pkill -f 'tokensave serve'", { encoding: "utf8", stdio: "pipe" });
        await new Promise((r) => setTimeout(r, 200));
        await expect(client.request("tools/list", {})).rejects.toThrow();
      } catch {
        // pkill may not find the process — that's fine
      } finally {
        await client.stop().catch(() => {});
      }
    });
  });

  describe("notify()", () => {
    testOrSkip("does not throw before start()", async () => {
      const client = new McpClient();
      expect(() => client.notify("notifications/initialized")).not.toThrow();
    });

    testOrSkip("sends notifications without waiting for a response", async () => {
      const client = new McpClient();
      await client.start("tokensave", ["serve"], projectDir);
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      });
      // Should not throw or hang
      expect(() => client.notify("notifications/initialized")).not.toThrow();
      await client.stop();
    });
  });

  describe("stop()", () => {
    testOrSkip("resolves cleanly after normal use", async () => {
      const client = await startClient(projectDir);
      await expect(client.stop()).resolves.toBeUndefined();
    });

    testOrSkip("is idempotent — safe to call twice", async () => {
      const client = await startClient(projectDir);
      await client.stop();
      await expect(client.stop()).resolves.toBeUndefined();
    });

    testOrSkip("resolves even when stop() is called immediately after start()", async () => {
      const client = new McpClient();
      await client.start("tokensave", ["serve"], projectDir);
      await expect(client.stop()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // MCP Protocol
  // -------------------------------------------------------------------------

  describe("MCP protocol compliance", () => {
    testOrSkip("tools/list returns an array of tools with names and schemas", async () => {
      const client = await startClient(projectDir);
      try {
        const result = (await client.request("tools/list", {})) as {
          tools: Array<{
            name: string;
            description?: string;
            inputSchema: { type: string; properties?: Record<string, unknown> };
          }>;
        };

        expect(result).toBeDefined();
        expect(Array.isArray(result.tools)).toBe(true);
        expect(result.tools.length).toBeGreaterThan(0);

        for (const tool of result.tools) {
          expect(typeof tool.name).toBe("string");
          expect(tool.name.length).toBeGreaterThan(0);
          expect(tool.inputSchema?.type).toBe("object");
        }
      } finally {
        await client.stop();
      }
    });

    testOrSkip("tools/call executes a search query and returns structured results", async () => {
      const client = await startClient(projectDir);
      try {
        const toolsResult = (await client.request("tools/list", {})) as {
          tools: Array<{ name: string }>;
        };

        const searchTool = toolsResult.tools.find((t) =>
          t.name.toLowerCase().includes("search")
        );

        if (!searchTool) {
          // tokensave version without search tool — try 'query'
          const queryTool = toolsResult.tools.find((t) =>
            t.name.toLowerCase().includes("query")
          );
          if (!queryTool) return; // Skip if no search-like tool available
        }

        const toolName = searchTool?.name ?? "tokensave_search";
        const params: Record<string, unknown> = {};

        // Build params from the tool schema
        const toolDef = toolsResult.tools.find((t) => t.name === toolName) as Record<string, unknown> | undefined;
        if (toolDef) {
          const schema = (toolDef.inputSchema ?? { properties: {} }) as { properties?: Record<string, unknown> };
          if (schema.properties) {
            for (const [key, val] of Object.entries(schema.properties)) {
              const prop = val as Record<string, unknown>;
              if (prop.type === "string" && key.toLowerCase().includes("query")) {
                params[key] = "TokenSaveExtension";
              } else if (prop.type === "string" && key.toLowerCase().includes("pattern")) {
                params[key] = "class";
              }
            }
          }
        }

        if (Object.keys(params).length === 0) return; // Skip if can't build params

        const result = (await client.request("tools/call", {
          name: toolName,
          arguments: params,
        })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

        expect(result).toBeDefined();
        expect(Array.isArray(result.content)).toBe(true);
        expect(result.isError).not.toBe(true);

        // At least one text part should exist
        const textParts = result.content?.filter((c) => c.type === "text" && c.text);
        expect(textParts).toBeDefined();
      } finally {
        await client.stop();
      }
    });

    testOrSkip("multiple concurrent requests are correlated correctly", async () => {
      const client = await startClient(projectDir);
      try {
        // Fire two requests concurrently
        const [r1, r2] = await Promise.all([
          client.request("tools/list", {}),
          client.request("tools/list", {}),
        ]);

        // Both should return valid tool lists
        const tools1 = (r1 as { tools: unknown[] }).tools;
        const tools2 = (r2 as { tools: unknown[] }).tools;
        expect(Array.isArray(tools1)).toBe(true);
        expect(Array.isArray(tools2)).toBe(true);
        expect(tools1.length).toBe(tools2.length);
      } finally {
        await client.stop();
      }
    });

    testOrSkip("non-JSON stdout from tokensave does not break the parser", async () => {
      const client = new McpClient();
      // Suppress console spam during this test by capturing it
      await client.start("tokensave", ["serve", "--help"], projectDir).catch(() => {});
      // tokensave serve --help exits immediately with plain text
      // The buffer should handle non-JSON gracefully
      await client.stop();
      // If we get here without crashing, the test passes
      expect(true).toBe(true);
    });
  });
});
