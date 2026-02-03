import { AgenticTester, AgenticTestResult } from "./agenticTester.js";
import { TestBuilder } from "./testBuilder.js";
import { Test } from "../runner/testParser.js";
import { Page } from "playwright";
import { ComputerUseProvider } from "../providers/index.js";

export interface TestHealerOptions {
  maxSteps?: number;
  viewport?: { width: number; height: number };
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

  async heal(
    suiteName: string,
    test: Test,
    failureReason: string
  ): Promise<{ success: boolean; newTestCode?: string; error?: string }> {
    console.log(`  🔧 Healing test: ${test.name}`);
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

    // Generate new static test using legacy steps format
    const legacySteps = AgenticTester.toLegacySteps(result.steps);
    const builder = new TestBuilder(suiteName, test.name);
    const newTestCode = builder.generate(legacySteps, test);

    return {
      success: true,
      newTestCode,
    };
  }
}
