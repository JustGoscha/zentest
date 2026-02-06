import { Page } from "playwright";
import { Test } from "../runner/testParser.js";
import { Action, ActionHistoryEntry, RecordedStep, ElementInfo } from "../types/actions.js";
import { BrowserExecutor } from "../browser/executor.js";
import {
  captureScreenshot,
  ensureViewport,
  getViewportSize,
} from "../browser/screenshot.js";
import { ComputerUseProvider } from "../providers/index.js";
import type { TokenUsage } from "../providers/base.js";
import { buildSystemPrompt } from "../providers/systemPrompt.js";
import {
  INDENT_LEVELS,
  color,
  logLine,
  startSpinner,
  statusLabel,
  symbols,
} from "../ui/cliOutput.js";

export interface AgenticTestResult {
  success: boolean;
  steps: RecordedStep[];
  error?: string;
  message?: string;
}


export interface AgenticTesterOptions {
  maxSteps: number;
  viewport: { width: number; height: number };
  screenshotDir?: string;
  retryNoResponse?: number;
  verbose?: boolean;
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
  private lastFailure?: { error: string; screenshot?: Buffer; action?: Action };
  private aiStepCount = 0;
  private actionCount = 0;
  private hasUsage = false;
  private usageTotals: Required<TokenUsage> = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    imageTokens: 0,
  };

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
      verbose: options.verbose ?? false,
    };
  }

  async run(test: Test): Promise<AgenticTestResult> {
    const steps: RecordedStep[] = [];
    const actionHistory: ActionHistoryEntry[] = [];
    let pendingActions: Action[] = [];
    let pendingReasoning = "";

    try {
      // Ensure consistent viewport
      await ensureViewport(this.page, this.options.viewport);

      // Navigate to base URL
      await this.page.goto(this.baseUrl, { waitUntil: "networkidle" });

      logLine(
        INDENT_LEVELS.step,
        `${statusLabel("info")} Starting test: "${test.description}"`
      );
      logLine(
        INDENT_LEVELS.detail,
        `${statusLabel("info")} Using provider: ${this.provider.name}`
      );

      while (steps.length < this.options.maxSteps) {
        // 1. Take screenshot
        const viewport = getViewportSize(this.page);

        logLine(
          INDENT_LEVELS.step,
          `${symbols.step} Step ${steps.length + 1}/${this.options.maxSteps}`
        );
        console.log("");

        if (pendingActions.length === 0) {
          // 2. Ask AI for next action batch (retry on empty/invalid response)
          const { actions, reasoning } = await this.getNextActionWithRetry({
            testDescription: test.description,
            actionHistory,
            viewport,
          });
          pendingActions = actions;
          pendingReasoning = reasoning;
          if (this.options.verbose) {
            logLine(
              INDENT_LEVELS.detail,
              `${color.magenta("Tool:")} ${JSON.stringify(pendingActions)}`
            );
          }
        }

        const action = pendingActions.shift();
        if (!action) {
          const reason = "No actions returned from AI";
          logLine(INDENT_LEVELS.step, `${statusLabel("fail")} Test failed: ${reason}`);
          this.logRunStats();
          return {
            success: false,
            steps,
            message: reason,
          };
        }

        const reasoning = pendingReasoning;
        if (this.options.verbose) {
          logLine(INDENT_LEVELS.detail, `${color.cyan("Action:")} ${action.type}`);
          logLine(INDENT_LEVELS.detail, `${color.yellow("Reasoning:")} ${reasoning}`);
          logLine(
            INDENT_LEVELS.detail,
            `${color.magenta("Tool:")} ${JSON.stringify(action)}`
          );
        }

        if (action.type !== "done" && this.isRepeatedAction(actionHistory, action, 3)) {
          const reason = "Repeated same action without progress";
          logLine(INDENT_LEVELS.step, `${statusLabel("fail")} Test failed: ${reason}`);
          this.logRunStats();
          return {
            success: false,
            steps,
            message: reason,
          };
        }

        // 3. Check if done
        if (action.type === "done") {
          const doneAction = action as { type: "done"; success: boolean; reason: string };
          logLine(
            INDENT_LEVELS.step,
            `${
              doneAction.success
                ? color.green("☑︎ TEST PASSED")
                : color.red("☒ TEST FAILED")
            }: ${doneAction.reason}`
          );
          this.logRunStats();
          return {
            success: doneAction.success,
            steps,
            message: doneAction.reason,
          };
        }

        // 4. Execute action
        const result = await this.executor.execute(action);

        // Log action summary (with element info if available)
        if (!this.options.verbose) {
          logLine(
            INDENT_LEVELS.detail,
            `${color.cyan("Action:")} ${this.formatActionSummary(action, result.elementInfo)}`
          );
        }

        if (result.error) {
          logLine(INDENT_LEVELS.detail, `${statusLabel("fail")} Error: ${result.error}`);
        }

        // 5. Record step
        const step: RecordedStep = {
          action,
          reasoning,
          elementInfo: result.elementInfo,
          screenshot: result.screenshot,
          error: result.error,
          timestamp: result.timestamp,
        };
        steps.push(step);
        this.actionCount += 1;
        actionHistory.push({ action, reasoning, error: result.error });

        if (result.error) {
          this.lastFailure = {
            error: result.error,
            screenshot: result.screenshot,
            action,
          };
          pendingActions = [];
        }

        // 6. Wait for page to settle
        await this.executor.waitForStable();
      }

      logLine(
        INDENT_LEVELS.step,
        `${statusLabel("fail")} Max steps (${this.options.maxSteps}) reached`
      );
      this.logRunStats();
      return {
        success: false,
        steps,
        error: `Max steps (${this.options.maxSteps}) reached without completing test`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logLine(INDENT_LEVELS.step, `${statusLabel("fail")} Error: ${errorMessage}`);
      this.logRunStats();
      return {
        success: false,
        steps,
        error: errorMessage,
      };
    }
  }


  private async getNextActionWithRetry(params: {
    testDescription: string;
    actionHistory: ActionHistoryEntry[];
    viewport: { width: number; height: number };
  }): Promise<{ actions: Action[]; reasoning: string; rawResponse?: string }> {
    const maxRetries = this.options.retryNoResponse ?? 0;
    let attempt = 0;

    while (true) {
      const screenshot =
        this.lastFailure?.screenshot || (await captureScreenshot(this.page));
      const spinner = startSpinner(INDENT_LEVELS.detail, "sending to AI...");
      const switchTimer = setTimeout(() => {
        spinner.update("AI is thinking...");
      }, 150);
      const failureText = this.lastFailure
        ? `${this.formatActionSummary(this.lastFailure.action ?? { type: "done", success: false, reason: "" })} failed with error: ${this.lastFailure.error}`
        : undefined;
      
      const requestParams = {
        screenshot,
        testDescription: params.testDescription,
        actionHistory: params.actionHistory,
        viewport: params.viewport,
        lastFailureText: failureText,
      };
      
      if (this.options.verbose) {
        spinner.stop();
        logLine(INDENT_LEVELS.detail, ``);
        const systemPrompt = buildSystemPrompt({
          testDescription: params.testDescription,
          actionHistory: params.actionHistory,
          viewport: params.viewport,
          mode: "json",
        });
        
        const userMessageText = `${
          failureText
            ? `Last instruction failed: ${failureText}. Try a different action.\n\n`
            : ""
        }Did we complete the test? If not, what action should I take next to complete the test? Respond with JSON.`;
        
        logLine(INDENT_LEVELS.detail, `${color.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
        logLine(INDENT_LEVELS.detail, `${color.blue("Request to AI")}`);
        logLine(INDENT_LEVELS.detail, `${color.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
        logLine(INDENT_LEVELS.detail, ``);
        logLine(INDENT_LEVELS.detail, `${color.cyan("System Prompt:")}`);
        logLine(INDENT_LEVELS.detail, `${color.gray("─────────────────────────────────────────")}`);
        this.logMultiline(INDENT_LEVELS.detail + 1, systemPrompt);
        logLine(INDENT_LEVELS.detail, ``);
        logLine(INDENT_LEVELS.detail, `${color.cyan("User Message:")}`);
        logLine(INDENT_LEVELS.detail, `${color.gray("─────────────────────────────────────────")}`);
        logLine(INDENT_LEVELS.detail + 1, `${color.gray("[Image: Screenshot (base64 encoded)]")}`);
        this.logMultiline(INDENT_LEVELS.detail + 1, userMessageText);
        logLine(INDENT_LEVELS.detail, ``);
        logLine(INDENT_LEVELS.detail, `${color.blue("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
        logLine(INDENT_LEVELS.detail, ``);
      }
      
      const result = await this.provider.getNextAction(requestParams);
      this.aiStepCount += 1;
      this.recordUsage(result.usage);
      clearTimeout(switchTimer);
      if (!this.options.verbose) {
        spinner.update("AI is thinking...");
      }
      spinner.stop();
      if (this.lastFailure?.screenshot) {
        this.lastFailure = undefined;
      }
      const normalized = this.normalizeResult(result);
      if (this.options.verbose && normalized.rawResponse) {
        logLine(INDENT_LEVELS.detail, ``);
        logLine(INDENT_LEVELS.detail, `${color.green("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
        logLine(INDENT_LEVELS.detail, `${color.green("AI Raw Response:")}`);
        logLine(INDENT_LEVELS.detail, `${color.green("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
        this.logMultiline(INDENT_LEVELS.detail + 1, normalized.rawResponse);
        logLine(INDENT_LEVELS.detail, `${color.green("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")}`);
        logLine(INDENT_LEVELS.detail, ``);
      }
      logLine(INDENT_LEVELS.detail, `${color.yellow("AI:")} ${normalized.reasoning}`);
      logLine(
        INDENT_LEVELS.detail,
        `${color.magenta("Queued:")} ${normalized.actions.length} actions`
      );

      if (!this.shouldRetry(normalized.actions, normalized.reasoning) || attempt >= maxRetries) {
        return normalized;
      }

      attempt++;
      logLine(
        INDENT_LEVELS.detail,
        `${statusLabel("warn")} No response from AI, retrying (${attempt}/${maxRetries})...`
      );
    }
  }

  private shouldRetry(actions: Action[], reasoning: string): boolean {
    if (actions.length !== 1) return false;
    const action = actions[0];
    if (action.type !== "done") return false;
    if (action.success) return false;
    const reason = (action as { reason?: string }).reason || reasoning || "";
    return (
      reason.includes("No response from AI") ||
      reason.includes("Failed to parse AI response") ||
      reason.includes("Failed to parse response")
    );
  }

  private normalizeResult(result: {
    actions?: Action[];
    reasoning: string;
    rawResponse?: string;
    usage?: TokenUsage;
  }): { actions: Action[]; reasoning: string; rawResponse?: string; usage?: TokenUsage } {
    const fallback: Action = {
      type: "done",
      success: false,
      reason: "No action returned",
    };
    const actions =
      result.actions && result.actions.length > 0 ? result.actions : [fallback];
    const doneIndex = actions.findIndex((action) => action.type === "done");
    return {
      actions: doneIndex >= 0 ? actions.slice(0, doneIndex + 1) : actions,
      reasoning: result.reasoning,
      rawResponse: result.rawResponse,
      usage: result.usage,
    };
  }

  private logMultiline(level: number, text: string): void {
    const lines = text.split("\n");
    for (const line of lines) {
      logLine(level, line);
    }
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
      case "click_button":
        return `${action.type}:${action.name}:${action.exact ?? ""}`;
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
      case "assert_visible":
        return `${action.type}:${action.x},${action.y}`;
      case "assert_text":
        return `${action.type}:${action.x},${action.y}:${action.text ?? ""}`;
      default:
        return `${action.type}`;
    }
  }

  private formatActionSummary(action: Action, elementInfo?: ElementInfo): string {
    const truncate = (value: string, max = 60) => {
      const singleLine = value.replace(/\s+/g, " ").trim();
      return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
    };

    const getElementDescription = (info?: ElementInfo): string => {
      if (!info) return "";
      
      const parts: string[] = [];
      
      // Special handling for inputs: show label or placeholder, then input type
      if (info.tagName === "input" || info.tagName === "textarea") {
        const label = info.name || info.ariaLabel || info.placeholder;
        if (label) {
          parts.push(`"${truncate(label, 40)}"`);
        }
        const elementType = info.role || info.tagName || "input";
        parts.push(elementType);
      } else {
        // For other elements: show text if available, then element type
        if (info.text) {
          parts.push(`"${truncate(info.text, 40)}"`);
        }
        const elementType = info.role || info.tagName || "element";
        parts.push(elementType);
      }
      
      return parts.length > 0 ? ` on ${parts.join(" ")}` : "";
    };

    switch (action.type) {
      case "click":
        return `click at (${action.x}, ${action.y})${getElementDescription(elementInfo)}${action.button ? ` [${action.button}]` : ""}`;
      case "double_click":
        return `double click at (${action.x}, ${action.y})${getElementDescription(elementInfo)}`;
      case "mouse_move":
        return `move mouse to (${action.x}, ${action.y})`;
      case "mouse_down":
        return `mouse down at (${action.x}, ${action.y})${action.button ? ` [${action.button}]` : ""}`;
      case "mouse_up":
        return `mouse up at (${action.x}, ${action.y})${action.button ? ` [${action.button}]` : ""}`;
      case "drag":
        return `drag from (${action.startX}, ${action.startY}) to (${action.endX}, ${action.endY})`;
      case "click_button":
        return `click button "${truncate(action.name, 40)}"${action.exact === false ? " [fuzzy]" : ""}`;
      case "type":
        return `type "${truncate(action.text, 40)}"`;
      case "key":
        return `press key "${action.key}"`;
      case "scroll":
        return `scroll ${action.direction} ${action.amount ?? 100}px at (${action.x}, ${action.y})`;
      case "wait":
        return `wait ${action.ms}ms`;
      case "assert_visible":
        return `assert visible at (${action.x}, ${action.y})`;
      case "assert_text":
        return `assert text at (${action.x}, ${action.y})`;
      case "screenshot":
        return "capture screenshot";
      case "done":
        return `done (${action.success ? "success" : "failure"})`;
      default:
        return "unknown action";
    }
  }

  private recordUsage(usage?: TokenUsage): void {
    if (!usage) return;
    if (typeof usage.inputTokens === "number") {
      this.usageTotals.inputTokens += usage.inputTokens;
      this.hasUsage = true;
    }
    if (typeof usage.outputTokens === "number") {
      this.usageTotals.outputTokens += usage.outputTokens;
      this.hasUsage = true;
    }
    if (typeof usage.totalTokens === "number") {
      this.usageTotals.totalTokens += usage.totalTokens;
      this.hasUsage = true;
    }
    if (typeof usage.imageTokens === "number") {
      this.usageTotals.imageTokens += usage.imageTokens;
      this.hasUsage = true;
    }
  }

  private logRunStats(): void {
    logLine(
      INDENT_LEVELS.step,
      `${statusLabel("info")} AI steps: ${this.aiStepCount}, actions: ${this.actionCount}`
    );
    if (!this.hasUsage) return;
    const parts: string[] = [];
    if (this.usageTotals.inputTokens > 0) {
      parts.push(`input ${this.usageTotals.inputTokens}`);
    }
    if (this.usageTotals.outputTokens > 0) {
      parts.push(`output ${this.usageTotals.outputTokens}`);
    }
    if (this.usageTotals.totalTokens > 0) {
      parts.push(`total ${this.usageTotals.totalTokens}`);
    }
    if (this.usageTotals.imageTokens > 0) {
      parts.push(`image ${this.usageTotals.imageTokens}`);
    }
    if (parts.length > 0) {
      logLine(INDENT_LEVELS.step, `${statusLabel("info")} Tokens: ${parts.join(", ")}`);
    }
  }
}
