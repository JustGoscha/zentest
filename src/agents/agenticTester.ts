import { Page } from "playwright";
import { Test } from "../runner/testParser.js";
import { Action, ActionHistoryEntry, CodeHistoryEntry, CodeModeResponse, RecordedStep, ElementInfo } from "../types/actions.js";
import { BrowserExecutor } from "../browser/executor.js";
import type { MCPExecutor } from "../mcp/mcpExecutor.js";
import { CodeExecutor } from "../browser/codeExecutor.js";
import {
  captureScreenshot,
  ensureViewport,
  getViewportSize,
} from "../browser/screenshot.js";
import { ComputerUseProvider } from "../providers/index.js";
import type { TokenUsage } from "../providers/base.js";
import { parseCodeResponse } from "../providers/actionParser.js";
import { buildSystemPrompt } from "../providers/systemPrompt.js";
import {
  color,
  logLine,
  logBlank,
  sym,
  formatAction,
  formatTestResult,
  startProgress,
} from "../ui/cliOutput.js";

export interface AgenticTestResult {
  success: boolean;
  steps: RecordedStep[];
  error?: string;
  message?: string;
  durationMs: number;
  tokenUsage: Required<TokenUsage>;
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
  private executor: BrowserExecutor | MCPExecutor;
  private codeExecutor?: CodeExecutor;
  private options: AgenticTesterOptions;
  private lastFailure?: { error: string; screenshot?: Buffer; action?: Action; code?: string };
  private aiStepCount = 0;
  private actionCount = 0;
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
    options: Partial<AgenticTesterOptions> = {},
    mcpOrCodeExecutor?: MCPExecutor | CodeExecutor
  ) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.provider = provider;
    if (mcpOrCodeExecutor instanceof CodeExecutor) {
      this.codeExecutor = mcpOrCodeExecutor;
      this.executor = new BrowserExecutor(page); // fallback, not used in code mode
    } else {
      this.executor = mcpOrCodeExecutor || new BrowserExecutor(page);
    }
    this.options = {
      maxSteps: options.maxSteps || 50,
      viewport: options.viewport || { width: 1280, height: 720 },
      screenshotDir: options.screenshotDir,
      retryNoResponse: options.retryNoResponse ?? 2,
      verbose: options.verbose ?? false,
    };
  }

  async run(test: Test, runOptions?: { skipNavigation?: boolean }): Promise<AgenticTestResult> {
    if (this.codeExecutor) {
      return this.runCodeMode(test, runOptions);
    }
    return this.runActionMode(test, runOptions);
  }

  private async runCodeMode(test: Test, runOptions?: { skipNavigation?: boolean }): Promise<AgenticTestResult> {
    const startTime = Date.now();
    const steps: RecordedStep[] = [];
    const codeHistory: CodeHistoryEntry[] = [];
    let pendingCode: string[] = [];
    let pendingReasoning = "";
    let loopWarnings = 0;
    const progress = startProgress(this.options.maxSteps);
    const executor = this.codeExecutor!;

    const makeResult = (
      success: boolean,
      message?: string,
      error?: string
    ): AgenticTestResult => ({
      success,
      steps,
      message,
      error,
      durationMs: Date.now() - startTime,
      tokenUsage: { ...this.usageTotals },
    });

    const truncCode = (code: string, max = 80) => {
      const s = code.replace(/\s+/g, " ").trim();
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    };

    try {
      await ensureViewport(this.page, this.options.viewport);

      if (!runOptions?.skipNavigation) {
        await this.page.goto(this.baseUrl, { waitUntil: "networkidle" });
      }

      while (steps.length < this.options.maxSteps) {
        const viewport = getViewportSize(this.page);
        const stepNum = steps.length + 1;

        if (pendingCode.length === 0) {
          // Ask AI for next code
          progress.thinking(stepNum);
          const codeResponse = await this.getNextCodeWithRetry({
            testDescription: test.description,
            codeHistory,
            viewport,
          });
          progress.clear();

          this.aiStepCount += 1;

          // Done signaling
          if (codeResponse.done) {
            // Execute any final code (e.g. assertions) before finishing
            for (const code of codeResponse.code) {
              const result = await executor.execute(code);
              logLine(2, formatAction(this.actionCount + 1, truncCode(code)));
              if (result.error) {
                logLine(3, color.red(`${sym.fail} ${result.error}`));
              }
              steps.push({
                action: { type: "done", success: false, reason: "code-mode" },
                reasoning: codeResponse.reasoning,
                generatedCode: code,
                screenshot: result.screenshot,
                error: result.error,
                timestamp: result.timestamp,
                mode: "code",
              });
              this.actionCount += 1;
              codeHistory.push({ code, reasoning: codeResponse.reasoning, error: result.error });
            }

            const success = codeResponse.success ?? false;
            const reason = codeResponse.reason || codeResponse.reasoning;
            logBlank();
            logLine(2, formatTestResult(success, reason, Date.now() - startTime, this.actionCount));
            return makeResult(success, reason);
          }

          if (codeResponse.code.length === 0) {
            logBlank();
            logLine(2, formatTestResult(false, "No code from AI", Date.now() - startTime, this.actionCount));
            return makeResult(false, "No code returned from AI");
          }

          pendingCode = [...codeResponse.code];
          pendingReasoning = codeResponse.reasoning;
        }

        const code = pendingCode.shift()!;
        const reasoning = pendingReasoning;

        // Repeated code / loop detection
        if (this.isRepeatedCode(codeHistory, code, 3)) {
          loopWarnings += 1;
          if (loopWarnings >= 2) {
            progress.clear();
            logBlank();
            logLine(2, formatTestResult(false, "Stuck in loop", Date.now() - startTime, this.actionCount));
            return makeResult(false, "Stuck in a loop without progress");
          }
          // First warning: skip this code, tell AI to try coordinates
          logLine(3, color.yellow(`${sym.warn} Loop detected — forcing new approach`));
          pendingCode = [];
          this.lastFailure = {
            error: "You are repeating the same actions in a loop. STOP using the same locators. Look at the screenshot and use page.mouse.click(x, y) with exact coordinates of the element you need to click.",
            screenshot: await captureScreenshot(this.page),
          };
          continue;
        }

        // Execute code
        progress.executing(stepNum, truncCode(code));
        const result = await executor.execute(code);
        progress.clear();

        logLine(2, formatAction(this.actionCount + 1, truncCode(code)));

        if (result.error) {
          logLine(3, color.red(`${sym.fail} ${result.error}`));
        }

        if (reasoning) {
          progress.reasoning(reasoning);
        }

        // Record step
        steps.push({
          action: { type: "done", success: false, reason: "code-mode" },
          reasoning,
          generatedCode: code,
          screenshot: result.screenshot,
          error: result.error,
          timestamp: result.timestamp,
          mode: "code",
        });
        this.actionCount += 1;
        codeHistory.push({ code, reasoning, error: result.error });

        if (result.error) {
          this.lastFailure = {
            error: result.error,
            screenshot: result.screenshot,
            code,
          };
          pendingCode = []; // Ask AI again with error context
        }

        await executor.waitForStable();
      }

      progress.clear();
      logBlank();
      logLine(2, formatTestResult(false, "Max steps reached", Date.now() - startTime, this.actionCount));
      return makeResult(false, undefined, `Max steps (${this.options.maxSteps}) reached without completing test`);
    } catch (error) {
      progress.clear();
      const errorMessage = error instanceof Error ? error.message : String(error);
      logBlank();
      logLine(2, formatTestResult(false, errorMessage, Date.now() - startTime, this.actionCount));
      return makeResult(false, undefined, errorMessage);
    }
  }

  private async getNextCodeWithRetry(params: {
    testDescription: string;
    codeHistory: CodeHistoryEntry[];
    viewport: { width: number; height: number };
  }): Promise<CodeModeResponse> {
    const maxRetries = this.options.retryNoResponse ?? 0;
    let attempt = 0;
    let retryFeedback: string | undefined;

    while (true) {
      const screenshot =
        this.lastFailure?.screenshot || (await captureScreenshot(this.page));
      const failureText = this.lastFailure
        ? `Code \`${this.lastFailure.code || ""}\` failed: ${this.lastFailure.error}`
        : retryFeedback;

      const result = await this.provider.getNextAction({
        screenshot,
        testDescription: params.testDescription,
        actionHistory: [],
        viewport: params.viewport,
        lastFailureText: failureText,
        promptMode: "code",
        codeHistory: params.codeHistory,
      });
      this.recordUsage(result.usage);

      if (this.lastFailure?.screenshot) {
        this.lastFailure = undefined;
      }

      // Re-parse the raw response as code mode
      const parsed = parseCodeResponse(result.rawResponse);

      if (this.options.verbose) {
        logBlank();
        logLine(3, color.dim("── AI Response (code mode) ──"));
        if (result.rawResponse) {
          for (const line of result.rawResponse.split("\n")) logLine(4, color.dim(line));
        }
        logLine(3, color.dim(`Reasoning: ${parsed.reasoning}`));
        logLine(3, color.dim(`Code: ${parsed.code.length} statements, done: ${parsed.done}`));
        logLine(3, color.dim("────────────────────────────"));
        logBlank();
      }

      // Check if response needs retry (parse failure)
      const isParseFailure = parsed.done && parsed.code.length === 0 &&
        (parsed.reasoning.includes("Failed to parse") || parsed.reasoning.includes("No response"));
      if (!isParseFailure || attempt >= maxRetries) {
        return parsed;
      }

      retryFeedback = `Your previous response could not be parsed. Return valid JSON with: { "code": ["await ..."], "reasoning": "...", "done": false }`;
      attempt++;
      logLine(3, color.yellow(`${sym.warn} Invalid AI response, retrying (${attempt}/${maxRetries})...`));
    }
  }

  private isRepeatedCode(codeHistory: CodeHistoryEntry[], code: string, repeatCount: number): boolean {
    if (codeHistory.length < repeatCount) return false;
    const sig = code.trim();
    // Exact same code N times in a row
    if (codeHistory.slice(-repeatCount).every((h) => h.code.trim() === sig)) return true;
    // Oscillating pattern: detect cycles in last 2*repeatCount steps
    // e.g. click → escape → click → escape → click → escape
    const windowSize = repeatCount * 2;
    if (codeHistory.length >= windowSize) {
      const recent = [...codeHistory.slice(-windowSize), { code, reasoning: "", error: undefined }];
      const codes = recent.map((h) => h.code.trim());
      const unique = new Set(codes);
      // If only 2-3 unique codes in 6+ steps, we're looping
      if (unique.size <= 2 && codes.length >= windowSize) return true;
    }
    return false;
  }

  private async runActionMode(test: Test, runOptions?: { skipNavigation?: boolean }): Promise<AgenticTestResult> {
    const startTime = Date.now();
    const steps: RecordedStep[] = [];
    const actionHistory: ActionHistoryEntry[] = [];
    let pendingActions: Action[] = [];
    let pendingReasoning = "";
    const progress = startProgress(this.options.maxSteps);

    const makeResult = (
      success: boolean,
      message?: string,
      error?: string
    ): AgenticTestResult => ({
      success,
      steps,
      message,
      error,
      durationMs: Date.now() - startTime,
      tokenUsage: { ...this.usageTotals },
    });

    try {
      await ensureViewport(this.page, this.options.viewport);

      if (!runOptions?.skipNavigation) {
        await this.page.goto(this.baseUrl, { waitUntil: "networkidle" });
      }

      while (steps.length < this.options.maxSteps) {
        const viewport = getViewportSize(this.page);
        const stepNum = steps.length + 1;

        if (pendingActions.length === 0) {
          // Ask AI for next actions
          progress.thinking(stepNum);
          const { actions, reasoning } = await this.getNextActionWithRetry({
            testDescription: test.description,
            actionHistory,
            viewport,
          });
          progress.clear();
          pendingActions = actions;
          pendingReasoning = reasoning;
        }

        const action = pendingActions.shift();
        if (!action) {
          progress.clear();
          logBlank();
          logLine(2, formatTestResult(false, "No actions from AI", Date.now() - startTime, this.actionCount));
          return makeResult(false, "No actions returned from AI");
        }

        const reasoning = pendingReasoning;

        if (action.type !== "done" && this.isRepeatedAction(actionHistory, action, 3)) {
          progress.clear();
          logBlank();
          logLine(2, formatTestResult(false, "Repeated action", Date.now() - startTime, this.actionCount));
          return makeResult(false, "Repeated same action without progress");
        }

        // Done
        if (action.type === "done") {
          const doneAction = action as { type: "done"; success: boolean; reason: string };
          progress.clear();
          logBlank();
          logLine(2, formatTestResult(doneAction.success, doneAction.reason, Date.now() - startTime, this.actionCount));
          return makeResult(doneAction.success, doneAction.reason);
        }

        // Execute action
        const actionSummary = this.formatActionSummary(action);
        progress.executing(stepNum, actionSummary);
        const result = await this.executor.execute(action);
        progress.clear();

        // Print action line
        logLine(2, formatAction(this.actionCount + 1, this.formatActionSummary(action, result.elementInfo)));

        if (result.error) {
          logLine(3, color.red(`${sym.fail} ${result.error}`));
        }

        // Show reasoning in the progress/spinner area (not a permanent line)
        if (reasoning) {
          progress.reasoning(reasoning);
        }

        // Record step
        const step: RecordedStep = {
          action,
          reasoning,
          elementInfo: result.elementInfo,
          screenshot: result.screenshot,
          generatedCode: "generatedCode" in result ? (result as any).generatedCode : undefined,
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

        await this.executor.waitForStable();
      }

      progress.clear();
      logBlank();
      logLine(2, formatTestResult(false, "Max steps reached", Date.now() - startTime, this.actionCount));
      return makeResult(false, undefined, `Max steps (${this.options.maxSteps}) reached without completing test`);
    } catch (error) {
      progress.clear();
      const errorMessage = error instanceof Error ? error.message : String(error);
      logBlank();
      logLine(2, formatTestResult(false, errorMessage, Date.now() - startTime, this.actionCount));
      return makeResult(false, undefined, errorMessage);
    }
  }

  private async getNextActionWithRetry(params: {
    testDescription: string;
    actionHistory: ActionHistoryEntry[];
    viewport: { width: number; height: number };
  }): Promise<{ actions: Action[]; reasoning: string; rawResponse?: string }> {
    const maxRetries = this.options.retryNoResponse ?? 0;
    let attempt = 0;
    let retryFeedback: string | undefined;

    while (true) {
      const screenshot =
        this.lastFailure?.screenshot || (await captureScreenshot(this.page));
      const failureText = this.lastFailure
        ? `${this.formatActionSummary(this.lastFailure.action ?? { type: "done", success: false, reason: "" })} failed with error: ${this.lastFailure.error}`
        : retryFeedback;

      const requestParams = {
        screenshot,
        testDescription: params.testDescription,
        actionHistory: params.actionHistory,
        viewport: params.viewport,
        lastFailureText: failureText,
      };

      if (this.options.verbose) {
        this.logVerboseRequest(params, failureText);
      }

      const result = await this.provider.getNextAction(requestParams);
      this.aiStepCount += 1;
      this.recordUsage(result.usage);

      if (this.lastFailure?.screenshot) {
        this.lastFailure = undefined;
      }
      const normalized = this.normalizeResult(result);

      if (this.options.verbose) {
        this.logVerboseResponse(normalized);
      }

      if (!this.shouldRetry(normalized.actions, normalized.reasoning) || attempt >= maxRetries) {
        return normalized;
      }

      const retryAction = normalized.actions[0];
      if (
        retryAction?.type === "done" &&
        !retryAction.success &&
        typeof retryAction.reason === "string" &&
        retryAction.reason.startsWith("Unknown action:")
      ) {
        retryFeedback = `You made a mistake in your last response: ${retryAction.reason}. Use only supported action types: click_button, click_text, select_input, click, double_click, hover, drag, type, key, scroll, wait, assert_text, assert_not_text, assert_visible, done. Return corrected JSON only.`;
      } else {
        retryFeedback = `Your previous response was invalid: ${
          retryAction &&
          typeof retryAction === "object" &&
          "reason" in retryAction &&
          typeof retryAction.reason === "string"
            ? retryAction.reason
            : "Invalid response format"
        }. Return corrected JSON only.`;
      }

      attempt++;
      logLine(3, color.yellow(`${sym.warn} Invalid AI response, retrying (${attempt}/${maxRetries})...`));
    }
  }

  private logVerboseRequest(
    params: { testDescription: string; actionHistory: ActionHistoryEntry[]; viewport: { width: number; height: number } },
    failureText?: string
  ): void {
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

    logBlank();
    logLine(3, color.dim("── Request to AI ──"));
    logLine(3, color.dim("System Prompt:"));
    for (const line of systemPrompt.split("\n")) logLine(4, color.dim(line));
    logBlank();
    logLine(3, color.dim("User Message:"));
    logLine(4, color.dim("[Image: Screenshot]"));
    for (const line of userMessageText.split("\n")) logLine(4, color.dim(line));
    logLine(3, color.dim("───────────────────"));
  }

  private logVerboseResponse(normalized: { actions: Action[]; reasoning: string; rawResponse?: string }): void {
    if (normalized.rawResponse) {
      logBlank();
      logLine(3, color.dim("── AI Response ──"));
      for (const line of normalized.rawResponse.split("\n")) logLine(4, color.dim(line));
      logLine(3, color.dim("─────────────────"));
    }
    logLine(3, color.dim(`AI: ${normalized.reasoning}`));
    logLine(3, color.dim(`Queued: ${normalized.actions.length} actions`));
    logBlank();
  }

  private shouldRetry(actions: Action[], reasoning: string): boolean {
    if (actions.length !== 1) return false;
    const action = actions[0];
    if (action.type !== "done") return false;
    if (action.success) return false;
    const reason = (action as { reason?: string }).reason || reasoning || "";
    return (
      reason.includes("No response from AI") ||
      reason.includes("No action returned") ||
      reason.includes("Failed to parse AI response") ||
      reason.includes("Failed to parse response") ||
      reason.includes("Unknown action:")
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
    let actions =
      result.actions && result.actions.length > 0 ? result.actions : [fallback];
    const doneIndex = actions.findIndex((action) => action.type === "done");
    if (doneIndex >= 0) {
      actions = actions.slice(0, doneIndex + 1);
      const doneAction = actions[doneIndex] as { type: "done"; success: boolean };
      if (!doneAction.success && actions.length > 1) {
        actions = actions.slice(0, doneIndex);
      }
      if (doneAction.success) {
        const lower = result.reasoning.toLowerCase();
        const unfinished = [
          "still need", "remaining", "more steps", "not yet",
          "haven't completed", "next step", "continue with",
          "haven't done", "not complete", "incomplete",
        ];
        if (unfinished.some((s) => lower.includes(s))) {
          actions = actions.slice(0, doneIndex);
        }
      }
    }
    return {
      actions,
      reasoning: result.reasoning,
      rawResponse: result.rawResponse,
      usage: result.usage,
    };
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
      case "click_text":
        return `${action.type}:${action.text}:${action.exact ?? ""}`;
      case "select_input":
        return `${action.type}:${action.field}:${action.value}:${action.exact ?? ""}`;
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
      case "assert_not_text":
        return `${action.type}:${action.text ?? ""}`;
      default:
        return `${action.type}`;
    }
  }

  formatActionSummary(action: Action, elementInfo?: ElementInfo): string {
    const truncate = (value: string, max = 60) => {
      const singleLine = value.replace(/\s+/g, " ").trim();
      return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
    };

    const getElementDescription = (info?: ElementInfo): string => {
      if (!info) return "";

      const parts: string[] = [];

      if (info.tagName === "input" || info.tagName === "textarea") {
        const label = info.name || info.ariaLabel || info.placeholder;
        if (label) parts.push(`"${truncate(label, 40)}"`);
        parts.push(info.role || info.tagName || "input");
      } else {
        if (info.text) parts.push(`"${truncate(info.text, 40)}"`);
        parts.push(info.role || info.tagName || "element");
      }

      return parts.length > 0 ? ` on ${parts.join(" ")}` : "";
    };

    switch (action.type) {
      case "click":
        return `click at (${action.x}, ${action.y})${getElementDescription(elementInfo)}${action.button ? ` [${action.button}]` : ""}`;
      case "double_click":
        return `double click at (${action.x}, ${action.y})${getElementDescription(elementInfo)}`;
      case "mouse_move":
        return `hover (${action.x}, ${action.y})${getElementDescription(elementInfo)}`;
      case "mouse_down":
        return `mouse down at (${action.x}, ${action.y})${action.button ? ` [${action.button}]` : ""}`;
      case "mouse_up":
        return `mouse up at (${action.x}, ${action.y})${action.button ? ` [${action.button}]` : ""}`;
      case "drag":
        return `drag (${action.startX},${action.startY}) ${sym.arrow} (${action.endX},${action.endY})`;
      case "click_button":
        return `click button "${truncate(action.name, 40)}"${action.exact === false ? " [fuzzy]" : ""}`;
      case "click_text":
        return `click text "${truncate(action.text, 40)}"${action.exact === false ? " [fuzzy]" : ""}`;
      case "select_input":
        return `fill "${truncate(action.field, 30)}" ${sym.arrow} "${truncate(action.value, 20)}"${action.exact === false ? " [fuzzy]" : ""}`;
      case "type":
        return `type "${truncate(action.text, 40)}"`;
      case "key":
        return `press key "${action.key}"`;
      case "scroll":
        return `scroll ${action.direction} ${action.amount ?? 100}px`;
      case "wait":
        return `wait ${action.ms}ms`;
      case "assert_visible":
        return `assert visible at (${action.x}, ${action.y})`;
      case "assert_text":
        return `assert text "${truncate(action.text, 50)}"`;
      case "assert_not_text":
        return `assert NOT text "${truncate(action.text, 50)}"`;
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
    }
    if (typeof usage.outputTokens === "number") {
      this.usageTotals.outputTokens += usage.outputTokens;
    }
    if (typeof usage.totalTokens === "number") {
      this.usageTotals.totalTokens += usage.totalTokens;
    }
    if (typeof usage.imageTokens === "number") {
      this.usageTotals.imageTokens += usage.imageTokens;
    }
  }
}
