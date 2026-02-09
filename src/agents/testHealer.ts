import { AgenticTester, AgenticTestResult } from "./agenticTester.js";
import { TestBuilder, TestResult } from "./testBuilder.js";
import { Test, TestSuite } from "../runner/testParser.js";
import { Page } from "playwright";
import { ComputerUseProvider } from "../providers/index.js";
import {
  INDENT_LEVELS,
  color,
  formatTestHeader,
  logLine,
  statusLabel,
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

  constructor(
    page: Page,
    baseUrl: string,
    provider: ComputerUseProvider,
    options: TestHealerOptions = {}
  ) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.provider = provider;
    this.options = options;
  }

  /**
   * Heal a single test (original API, kept for backward compatibility).
   */
  async heal(
    suiteName: string,
    test: Test,
    failureReason: string
  ): Promise<{ success: boolean; newTestCode?: string; error?: string }> {
    console.log(`  Healing test: ${test.name}`);
    console.log(`     Failure: ${failureReason}`);

    // Run agentic tester to figure out the new flow
    const agenticTester = new AgenticTester(
      this.page,
      this.baseUrl,
      this.provider,
      {
        maxSteps: this.options.maxSteps,
        viewport: this.options.viewport,
      }
    );
    const result = await agenticTester.run(test);

    if (!result.success) {
      return {
        success: false,
        error: `Agentic tester also failed: ${result.error}`,
      };
    }

    // Generate new static test
    const builder = new TestBuilder(suiteName, test.name);
    const newTestCode = builder.generate(result.steps, test);

    return {
      success: true,
      newTestCode,
    };
  }

  /**
   * Heal an entire suite by re-running all tests agentically.
   * Shares a single page across the suite. Stops on first failure.
   * Returns collected TestResult[] suitable for TestBuilder.generateSuite().
   */
  async healSuite(suite: TestSuite): Promise<HealSuiteResult> {
    const testResults: TestResult[] = [];
    let passed = 0;
    let failed = 0;
    let isFirstTest = true;

    for (const test of suite.tests) {
      console.log("");
      logLine(INDENT_LEVELS.test, formatTestHeader(test.name));
      logLine(INDENT_LEVELS.step, color.dim(`"${test.description}"`));

      const tester = new AgenticTester(
        this.page,
        this.baseUrl,
        this.provider,
        {
          maxSteps: this.options.maxSteps,
          viewport: this.options.viewport,
          verbose: this.options.verbose,
        }
      );

      const result = await tester.run(test, {
        skipNavigation: !isFirstTest,
      });
      isFirstTest = false;

      if (result.success) {
        passed++;
        testResults.push({ test, steps: result.steps });
      } else {
        failed++;
        logLine(
          INDENT_LEVELS.step,
          `${statusLabel("warn")} Stopping suite heal - subsequent tests depend on previous state`
        );
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
