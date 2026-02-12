import { Page } from "playwright";
import { expect } from "@playwright/test";
import { captureScreenshot } from "./screenshot.js";

// AsyncFunction constructor (not globally available as a named class)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export interface CodeExecutionResult {
  code: string;
  screenshot?: Buffer;
  error?: string;
  timestamp: number;
}

/**
 * Executes AI-generated Playwright code strings in a sandboxed async function.
 * Scope: `page` (Playwright Page) and `expect` (@playwright/test).
 */
export class CodeExecutor {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async execute(code: string): Promise<CodeExecutionResult> {
    const timestamp = Date.now();
    try {
      const fn = new AsyncFunction("page", "expect", code);
      await fn(this.page, expect);

      const screenshot = await this.screenshotAfterSettle();
      return { code, screenshot, timestamp };
    } catch (error) {
      const screenshot = await this.screenshotAfterSettle();
      return {
        code,
        screenshot,
        error: error instanceof Error ? error.message : String(error),
        timestamp,
      };
    }
  }

  async waitForStable(): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // Timeout is fine
    }
  }

  private async screenshotAfterSettle(): Promise<Buffer> {
    // Brief delay to let animations/transitions settle
    await this.page.waitForTimeout(300);
    return captureScreenshot(this.page);
  }
}
