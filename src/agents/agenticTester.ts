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
  retryNoResponse?: number;
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
      retryNoResponse: options.retryNoResponse ?? 2,
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
        const viewport = getViewportSize(this.page);

        console.log(`    Step ${i + 1}/${this.options.maxSteps}...`);

        // 2. Ask AI for next action (retry on empty/invalid response)
        const { action, reasoning } = await this.getNextActionWithRetry({
          testDescription: test.description,
          actionHistory,
          viewport,
        });

        console.log(`      Action: ${action.type} - ${reasoning.slice(0, 60)}...`);

        if (action.type !== "done" && this.isRepeatedAction(actionHistory, action, 3)) {
          const reason = "Repeated same action without progress";
          console.log(`    ✗ Test failed: ${reason}`);
          return {
            success: false,
            steps,
            message: reason,
          };
        }

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

  private async getNextActionWithRetry(params: {
    testDescription: string;
    actionHistory: Array<{ action: Action; reasoning: string }>;
    viewport: { width: number; height: number };
  }): Promise<{ action: Action; reasoning: string }> {
    const maxRetries = this.options.retryNoResponse ?? 0;
    let attempt = 0;

    while (true) {
      const screenshot = await captureScreenshot(this.page);
      const result = await this.provider.getNextAction({
        screenshot,
        testDescription: params.testDescription,
        actionHistory: params.actionHistory,
        viewport: params.viewport,
      });

      if (!this.shouldRetry(result.action, result.reasoning) || attempt >= maxRetries) {
        return result;
      }

      attempt++;
      console.log(`      No response from AI, retrying (${attempt}/${maxRetries})...`);
    }
  }

  private shouldRetry(action: Action, reasoning: string): boolean {
    if (action.type !== "done") return false;
    if (action.success) return false;
    const reason = (action as { reason?: string }).reason || reasoning || "";
    return (
      reason.includes("No response from AI") ||
      reason.includes("Failed to parse AI response") ||
      reason.includes("Failed to parse response")
    );
  }

  private isRepeatedAction(
    actionHistory: Array<{ action: Action; reasoning: string }>,
    action: Action,
    repeatCount: number
  ): boolean {
    if (actionHistory.length < repeatCount) return false;
    const signature = this.actionSignature(action);
    const recent = actionHistory.slice(-repeatCount);
    return recent.every((item) => this.actionSignature(item.action) === signature);
  }

  private actionSignature(action: Action): string {
    switch (action.type) {
      case "click":
      case "double_click":
      case "mouse_move":
        return `${action.type}:${action.x},${action.y}:${"button" in action ? action.button : ""}`;
      case "type":
        return `${action.type}:${action.text}`;
      case "key":
        return `${action.type}:${action.key}`;
      case "scroll":
        return `${action.type}:${action.x},${action.y}:${action.direction}:${action.amount}`;
      case "wait":
        return `${action.type}:${action.ms}`;
      case "done":
        return `${action.type}:${action.success}:${action.reason}`;
      default:
        return `${action.type}`;
    }
  }
}
