import type { BrowserContext } from "playwright";
import { createRequire } from "module";
import * as path from "path";

// Import MCP internals bundled with playwright.
// "playwright/lib/mcp/index" and "playwright/lib/mcp/sdk/exports" are in the
// package exports map. For non-exported internals (BrowserServerBackend, config)
// we resolve via absolute path from the exported MCP directory.
const require = createRequire(import.meta.url);
const mcpDir = path.dirname(require.resolve("playwright/lib/mcp/index"));

const { BrowserServerBackend } = require(path.join(mcpDir, "browser/browserServerBackend"));
const { resolveConfig } = require(path.join(mcpDir, "browser/config"));
const { wrapInClient } = require("playwright/lib/mcp/sdk/exports");

/**
 * Parsed result from an MCP tool call.
 */
export interface MCPToolResult {
  /** Full response text from the MCP tool */
  text: string;
  /** Playwright code extracted from "### Ran Playwright code" section */
  generatedCode?: string;
  /** Error message if the tool call failed */
  error?: string;
  /** Accessibility snapshot if included in response */
  snapshot?: string;
  /** Whether the tool call had an error */
  isError: boolean;
}

/**
 * Wraps the Playwright MCP server for in-process tool calls.
 * Uses the bundled MCP internals from playwright to avoid spawning a subprocess.
 *
 * Each tool call both executes the action AND returns the Playwright code
 * that was used (when codegen is enabled).
 */
export class MCPBrowserClient {
  private client: any;
  private backend: any;

  private constructor(client: any, backend: any) {
    this.client = client;
    this.backend = backend;
  }

  /**
   * Create an MCPBrowserClient backed by an existing BrowserContext.
   * The MCP server shares the browser — no second instance is launched.
   */
  static async create(
    browserContext: BrowserContext,
    options?: { codegen?: "typescript" | "none" }
  ): Promise<MCPBrowserClient> {
    const config = await resolveConfig({
      codegen: options?.codegen ?? "typescript",
      capabilities: ["core", "vision", "testing"],
      snapshot: { mode: "full" },
    });

    // SimpleBrowserContextFactory that returns our existing context
    const factory = {
      name: "zentest",
      description: "Zentest shared browser context",
      async createContext() {
        return {
          browserContext,
          close: async () => {
            // Don't close — zentest owns the context lifecycle
          },
        };
      },
    };

    const backend = new BrowserServerBackend(config, factory);
    const client = await wrapInClient(backend, {
      name: "zentest",
      version: "0.2.0",
    });

    return new MCPBrowserClient(client, backend);
  }

  /**
   * Call an MCP tool by name and return the parsed result.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<MCPToolResult> {
    const result = await this.client.callTool({ name, arguments: args });
    return MCPBrowserClient.parseResult(result);
  }

  /**
   * Convenience: take an accessibility snapshot and return the YAML text.
   */
  async snapshot(): Promise<string> {
    const result = await this.callTool("browser_snapshot", {});
    return result.snapshot || result.text;
  }

  /**
   * List all available MCP tools.
   */
  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const { tools } = await this.client.listTools();
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /**
   * Close the MCP client and clean up.
   */
  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Parse an MCP tool result into structured fields.
   *
   * MCP responses are markdown with sections like:
   * ### Ran Playwright code
   * ### Snapshot
   * ### Error
   */
  static parseResult(result: any): MCPToolResult {
    const isError = result.isError === true;
    const textParts: string[] = [];

    for (const content of result.content || []) {
      if (content.type === "text") {
        textParts.push(content.text);
      }
    }

    const fullText = textParts.join("\n");

    return {
      text: fullText,
      generatedCode: extractSection(fullText, "Ran Playwright code"),
      error: isError ? extractSection(fullText, "Error") || fullText : undefined,
      snapshot: extractSection(fullText, "Snapshot"),
      isError,
    };
  }
}

/**
 * Extract content from a named markdown section.
 * Sections are delimited by "### SectionName" headers.
 */
function extractSection(
  text: string,
  sectionName: string
): string | undefined {
  const marker = `### ${sectionName}`;
  const startIndex = text.indexOf(marker);
  if (startIndex === -1) return undefined;

  const contentStart = startIndex + marker.length;
  // Find the next section header or end of text
  const nextSection = text.indexOf("\n### ", contentStart);
  const rawContent =
    nextSection === -1
      ? text.slice(contentStart)
      : text.slice(contentStart, nextSection);

  // Strip leading/trailing whitespace and code fences
  let cleaned = rawContent.trim();
  if (cleaned.startsWith("```yaml")) {
    cleaned = cleaned.slice("```yaml".length);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice("```".length);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -"```".length);
  }

  return cleaned.trim() || undefined;
}
