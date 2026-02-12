import { AgenticTester } from "./agenticTester.js";
import { TestBuilder, TestResult, SerializedSuiteSteps } from "./testBuilder.js";
import { Test, TestSuite } from "../runner/testParser.js";
import { RecordedStep } from "../types/actions.js";
import { Page } from "playwright";
import { ComputerUseProvider } from "../providers/index.js";
import type { MCPExecutor } from "../mcp/mcpExecutor.js";
import { CodeExecutor } from "../browser/codeExecutor.js";
import type { AutomationMode } from "../config/loader.js";
import { replaySteps } from "../runner/stepReplayer.js";
import {
  color,
  sym,
  formatTestName,
  logLine,
  logBlank,
} from "../ui/cliOutput.js";

export interface TestHealerOptions {
  maxSteps?: number;
  viewport?: { width: number; height: number };
  verbose?: boolean;
}

export interface HealSuiteResult {
  success: boolean;
  testResults: TestResult[];
  passed: number;
  failed: number;
  error?: string;
}

/**
 * The Test Healer runs when static Playwright tests fail.
 * It re-runs the Agentic Tester to figure out what changed
 * and generates a new static test.
 */
export class TestHealer {
  private page: Page;
  private baseUrl: string;
  private provider: ComputerUseProvider;
  private options: TestHealerOptions;
  private mcpOrCodeExecutor?: MCPExecutor | CodeExecutor;

  constructor(
    page: Page,
    baseUrl: string,
    provider: ComputerUseProvider,
    options: TestHealerOptions = {},
    mcpOrCodeExecutor?: MCPExecutor | CodeExecutor
  ) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.provider = provider;
    this.options = options;
    this.mcpOrCodeExecutor = mcpOrCodeExecutor;
  }

  /**
   * Heal a single test (original API, kept for backward compatibility).
   */
  async heal(
    suiteName: string,
    test: Test,
    failureReason: string
  ): Promise<{ success: boolean; newTestCode?: string; error?: string }> {
    logBlank();
    logLine(1, formatTestName(test.name));
    logLine(2, color.dim(`Failure: ${failureReason}`));

    // Run agentic tester to figure out the new flow
    const agenticTester = new AgenticTester(
      this.page,
      this.baseUrl,
      this.provider,
      {
        maxSteps: this.options.maxSteps,
        viewport: this.options.viewport,
      },
      this.mcpOrCodeExecutor
    );
    const result = await agenticTester.run(test);

    if (!result.success) {
      return {
        success: false,
        error: `Agentic tester also failed: ${result.error}`,
      };
    }

    // Generate new static test
    const automationMode: AutomationMode = this.mcpOrCodeExecutor instanceof CodeExecutor
      ? "code"
      : this.mcpOrCodeExecutor ? "mcp" : "vision";
    const builder = new TestBuilder(suiteName, test.name, automationMode);
    const newTestCode = builder.generate(result.steps, test);

    return {
      success: true,
      newTestCode,
    };
  }

  /**
   * Heal a suite by replaying saved steps for passing tests,
   * then switching to agentic mode from the failed test onward.
   *
   * If savedSteps/failedTestIndex are not provided, falls back to
   * running all tests agentically (original behavior).
   */
  async healSuite(
    suite: TestSuite,
    options?: {
      savedSteps?: SerializedSuiteSteps;
      failedTestIndex?: number;
    }
  ): Promise<HealSuiteResult> {
    const testResults: TestResult[] = [];
    let passed = 0;
    let failed = 0;

    const savedSteps = options?.savedSteps;
    const failedTestIndex = options?.failedTestIndex ?? 0;
    const canReplay = savedSteps && failedTestIndex > 0;

    // Navigate to baseUrl once
    await this.page.goto(this.baseUrl, { waitUntil: "networkidle" });

    // Phase 1: Replay saved steps for tests before the failure point
    if (canReplay) {
      for (let i = 0; i < failedTestIndex; i++) {
        const test = suite.tests[i];
        const saved = savedSteps.tests.find((t) => t.name === test.name);

        if (!saved) {
          // No saved steps for this test — fall back to full agentic
          logLine(2, `${color.yellow(sym.warn)} No saved steps for '${test.name}', falling back to agentic`);
          return this.healSuiteAgentic(suite);
        }

        logBlank();
        logLine(1, formatTestName(test.name));
        logLine(2, `${color.cyan(sym.info)} Replaying saved steps...`);

        try {
          await replaySteps(this.page, saved.steps as RecordedStep[]);
          passed++;
          testResults.push({ test, steps: saved.steps as RecordedStep[] });
          logLine(2, `${color.green(sym.pass)} Replay complete`);
        } catch (error) {
          // Replay failed — the passing tests no longer work either.
          // Fall back to full agentic from scratch.
          logLine(2, `${color.yellow(sym.warn)} Replay failed: ${error instanceof Error ? error.message : error}`);
          logLine(2, `${color.cyan(sym.info)} Falling back to full agentic healing...`);
          return this.healSuiteAgentic(suite);
        }
      }
    }

    // Phase 2: Run remaining tests agentically
    for (let i = canReplay ? failedTestIndex : 0; i < suite.tests.length; i++) {
      const test = suite.tests[i];
      logBlank();
      logLine(1, formatTestName(test.name));
      logLine(2, color.dim(`"${test.description}"`));

      const tester = new AgenticTester(
        this.page,
        this.baseUrl,
        this.provider,
        {
          maxSteps: this.options.maxSteps,
          viewport: this.options.viewport,
          verbose: this.options.verbose,
        },
        this.mcpOrCodeExecutor
      );

      // Skip navigation — we already navigated (and possibly replayed) above
      const result = await tester.run(test, { skipNavigation: true });

      if (result.success) {
        passed++;
        testResults.push({ test, steps: result.steps });
      } else {
        failed++;
        logLine(2, `${color.yellow(sym.warn)} Stopping suite heal — subsequent tests depend on previous state`);
        break;
      }
    }

    const allPassed = failed === 0 && passed === suite.tests.length;

    return {
      success: allPassed,
      testResults,
      passed,
      failed,
      error: allPassed
        ? undefined
        : `Healer passed ${passed}/${suite.tests.length} tests`,
    };
  }

  /**
   * Full agentic fallback — re-runs all tests from scratch.
   */
  private async healSuiteAgentic(suite: TestSuite): Promise<HealSuiteResult> {
    const testResults: TestResult[] = [];
    let passed = 0;
    let failed = 0;

    // Navigate fresh
    await this.page.goto(this.baseUrl, { waitUntil: "networkidle" });

    for (const test of suite.tests) {
      logBlank();
      logLine(1, formatTestName(test.name));
      logLine(2, color.dim(`"${test.description}"`));

      const tester = new AgenticTester(
        this.page,
        this.baseUrl,
        this.provider,
        {
          maxSteps: this.options.maxSteps,
          viewport: this.options.viewport,
          verbose: this.options.verbose,
        },
        this.mcpOrCodeExecutor
      );

      // Skip navigation — we already navigated above
      const result = await tester.run(test, { skipNavigation: true });

      if (result.success) {
        passed++;
        testResults.push({ test, steps: result.steps });
      } else {
        failed++;
        logLine(2, `${color.yellow(sym.warn)} Stopping suite heal — subsequent tests depend on previous state`);
        break;
      }
    }

    const allPassed = failed === 0 && passed === suite.tests.length;

    return {
      success: allPassed,
      testResults,
      passed,
      failed,
      error: allPassed
        ? undefined
        : `Healer passed ${passed}/${suite.tests.length} tests`,
    };
  }
}
