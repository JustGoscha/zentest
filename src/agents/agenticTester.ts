import { Page } from "playwright";
import { Test } from "../runner/testParser.js";
import { Action, RecordedStep } from "../types/actions.js";
import { BrowserExecutor } from "../browser/executor.js";
import {
  captureScreenshot,
  ensureViewport,
  getViewportSize,
} from "../browser/screenshot.js";
import { ComputerUseProvider } from "../providers/index.js";

export interface AgenticTestResult {
  success: boolean;
  steps: RecordedStep[];
  error?: string;
  message?: string;
}

// Keep legacy interface for backward compatibility
export interface AgenticStep {
  action: string;
  selector?: string;
  value?: string;
  screenshot?: string;
  reasoning: string;
}

export interface AgenticTesterOptions {
  maxSteps: number;
  viewport: { width: number; height: number };
  screenshotDir?: string;
}

/**
 * The Agentic Tester uses AI to interpret plain English tests
 * and execute them by navigating and interacting with the page.
 */
export class AgenticTester {
  private page: Page;
  private baseUrl: string;
  private provider: ComputerUseProvider;
  private executor: BrowserExecutor;
  private options: AgenticTesterOptions;

  constructor(
    page: Page,
    baseUrl: string,
    provider: ComputerUseProvider,
    options: Partial<AgenticTesterOptions> = {}
  ) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.provider = provider;
    this.executor = new BrowserExecutor(page);
    this.options = {
      maxSteps: options.maxSteps || 50,
      viewport: options.viewport || { width: 1280, height: 720 },
      screenshotDir: options.screenshotDir,
    };
  }

  async run(test: Test): Promise<AgenticTestResult> {
    const steps: RecordedStep[] = [];
    const actionHistory: Array<{ action: Action; reasoning: string }> = [];

    try {
      // Ensure consistent viewport
      await ensureViewport(this.page, this.options.viewport);

      // Navigate to base URL
      await this.page.goto(this.baseUrl, { waitUntil: "networkidle" });

      console.log(`    Starting test: "${test.description}"`);
      console.log(`    Using provider: ${this.provider.name}`);

      for (let i = 0; i < this.options.maxSteps; i++) {
        // 1. Take screenshot
        const screenshot = await captureScreenshot(this.page);
        const viewport = getViewportSize(this.page);

        console.log(`    Step ${i + 1}/${this.options.maxSteps}...`);

        // 2. Ask AI for next action
        const { action, reasoning } = await this.provider.getNextAction({
          screenshot,
          testDescription: test.description,
          actionHistory,
          viewport,
        });

        console.log(`      Action: ${action.type} - ${reasoning.slice(0, 60)}...`);

        // 3. Check if done
        if (action.type === "done") {
          const doneAction = action as { type: "done"; success: boolean; reason: string };
          console.log(
            `    ${doneAction.success ? "✓" : "✗"} Test ${doneAction.success ? "passed" : "failed"}: ${doneAction.reason}`
          );
          return {
            success: doneAction.success,
            steps,
            message: doneAction.reason,
          };
        }

        // 4. Execute action
        const result = await this.executor.execute(action);

        if (result.error) {
          console.log(`      Error: ${result.error}`);
        }

        // 5. Record step
        const step: RecordedStep = {
          action,
          reasoning,
          elementInfo: result.elementInfo,
          screenshot: result.screenshot,
          timestamp: result.timestamp,
        };
        steps.push(step);
        actionHistory.push({ action, reasoning });

        // 6. Wait for page to settle
        await this.executor.waitForStable();
      }

      console.log(`    ✗ Max steps (${this.options.maxSteps}) reached`);
      return {
        success: false,
        steps,
        error: `Max steps (${this.options.maxSteps}) reached without completing test`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`    ✗ Error: ${errorMessage}`);
      return {
        success: false,
        steps,
        error: errorMessage,
      };
    }
  }

  /**
   * Convert RecordedSteps to legacy AgenticSteps for TestBuilder compatibility
   */
  static toLegacySteps(steps: RecordedStep[]): AgenticStep[] {
    return steps.map((step) => ({
      action: step.action.type,
      selector: step.elementInfo?.selector,
      value: "text" in step.action ? (step.action as { text: string }).text : undefined,
      reasoning: step.reasoning,
    }));
  }
}
