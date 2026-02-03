import { AgenticStep } from "./agenticTester.js";
import { Test } from "../runner/testParser.js";

/**
 * The Test Builder observes the Agentic Tester's actions
 * and generates a Playwright test file.
 */
export class TestBuilder {
  private suiteName: string;
  private testName: string;

  constructor(suiteName: string, testName: string) {
    this.suiteName = suiteName;
    this.testName = testName;
  }

  /**
   * Generate a Playwright test from recorded steps
   */
  generate(steps: AgenticStep[], test: Test): string {
    const lines: string[] = [
      `import { test, expect } from '@playwright/test';`,
      ``,
      `// Generated from: "${test.description}"`,
      `test('${test.name}', async ({ page }) => {`,
    ];

    for (const step of steps) {
      const code = this.stepToCode(step);
      if (code) {
        lines.push(`  ${code}`);
      }
    }

    lines.push(`});`);
    lines.push(``);

    return lines.join("\n");
  }

  private stepToCode(step: AgenticStep): string | null {
    switch (step.action) {
      case "navigate":
        return `await page.goto('${step.value}');`;

      case "click":
        return `await page.locator('${step.selector}').click();`;

      case "type":
        return `await page.locator('${step.selector}').fill('${step.value}');`;

      case "assert_visible":
        return `await expect(page.locator('${step.selector}')).toBeVisible();`;

      case "assert_text":
        return `await expect(page.locator('${step.selector}')).toContainText('${step.value}');`;

      default:
        return `// ${step.action}: ${step.reasoning}`;
    }
  }
}
