import { AgenticStep } from "./agenticTester.js";
import { Test } from "../runner/testParser.js";
import { ElementInfo } from "../types/actions.js";

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
      ...this.buildDescriptionComment(test.description),
      `test('${test.name}', async ({ page }) => {`,
      `  const baseUrl = process.env.ZENTEST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;`,
      `  if (!baseUrl) {`,
      `    throw new Error('ZENTEST_BASE_URL is required to run static tests');`,
      `  }`,
      `  await page.goto(baseUrl, { waitUntil: 'networkidle' });`,
    ];

    for (const step of steps) {
      const code = this.stepToCode(step);
      if (code) {
        // Add reasoning as comment
        if (step.reasoning) {
          lines.push(`  // ${step.reasoning.slice(0, 80)}`);
        }
        lines.push(`  ${code}`);
      }
    }

    lines.push(`});`);
    lines.push(``);

    return lines.join("\n");
  }

  private buildDescriptionComment(description: string): string[] {
    if (!description) {
      return [`// Generated from: ""`];
    }

    if (!description.includes("\n")) {
      return [`// Generated from: "${description}"`];
    }

    const lines = description
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      return [`// Generated from: ""`];
    }

    return [
      `/**`,
      ...lines.map((line) => ` * ${line}`),
      ` */`,
    ];
  }

  private stepToCode(step: AgenticStep): string | null {
    const selector = step.selector ? this.toSemanticSelector(step.selector) : null;

    switch (step.action) {
      case "navigate":
        return `await page.goto('${this.escapeString(step.value || "")}');`;

      case "click":
        if (!selector) return null;
        return `await ${selector}.click();`;

      case "click_button":
        if (selector) return `await ${selector}.click();`;
        return `await page.getByRole('button', { name: '${this.escapeString(step.value || "")}', exact: true }).click();`;

      case "double_click":
        if (!selector) return null;
        return `await ${selector}.dblclick();`;

      case "type":
        if (!selector) return null;
        return `await ${selector}.fill('${this.escapeString(step.value || "")}');`;

      case "key":
        return `await page.keyboard.press('${this.normalizeKeyCombo(
          step.value || "Enter"
        )}');`;

      case "scroll":
        return `await page.mouse.wheel(0, ${step.value || "100"});`;

      case "wait":
        return `await page.waitForTimeout(${step.value || "1000"});`;

      case "assert_visible":
        if (!selector) return null;
        if (step.value) {
          return `await expect(${selector}).toBeVisible();\n  await expect(${selector}).toContainText('${this.escapeString(step.value)}');`;
        }
        return `await expect(${selector}).toBeVisible();`;

      case "assert_text":
        if (!selector) return null;
        return `await expect(${selector}).toContainText('${this.escapeString(step.value || "")}');`;

      case "done":
        return null; // Don't generate code for done actions

      default:
        return `// ${step.action}: ${step.reasoning}`;
    }
  }

  /**
   * Convert a raw selector to a semantic Playwright selector
   * Prefers getByRole, getByText, getByLabel over CSS selectors
   */
  private toSemanticSelector(selector: string): string {
    // data-testid - use getByTestId
    const testIdMatch = selector.match(/\[data-testid="([^"]+)"\]/);
    if (testIdMatch) {
      return `page.getByTestId('${testIdMatch[1]}')`;
    }

    // role + aria-label - use getByRole with name
    const roleMatch = selector.match(/\[role="([^"]+)"\]\[aria-label="([^"]+)"\]/);
    if (roleMatch) {
      return `page.getByRole('${roleMatch[1]}', { name: '${this.escapeString(roleMatch[2])}' })`;
    }

    // button:has-text or a:has-text - use getByRole
    const hasTextMatch = selector.match(/^(button|a):has-text\("([^"]+)"\)$/);
    if (hasTextMatch) {
      const role = hasTextMatch[1] === "a" ? "link" : "button";
      return `page.getByRole('${role}', { name: '${this.escapeString(hasTextMatch[2])}' })`;
    }

    // input with placeholder - use getByPlaceholder
    const placeholderMatch = selector.match(/input\[placeholder="([^"]+)"\]/);
    if (placeholderMatch) {
      return `page.getByPlaceholder('${this.escapeString(placeholderMatch[1])}')`;
    }

    // label-based selectors
    const labelMatch = selector.match(/label:has-text\("([^"]+)"\)/);
    if (labelMatch) {
      return `page.getByLabel('${this.escapeString(labelMatch[1])}')`;
    }

    // ID-based selector - convert to getByTestId style or use locator
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      return `page.locator('#${id}')`;
    }

    // Fallback to locator for CSS selectors
    return `page.locator('${this.escapeString(selector)}')`;
  }

  private normalizeKeyCombo(rawKey: string): string {
    const trimmed = rawKey.trim();
    if (!trimmed) return "Enter";

    const hasPlus = trimmed.includes("+");
    const hasDashModifiers =
      /(^|[-])(cmd|command|meta|ctrl|control|alt|option|shift)-/i.test(trimmed);
    const delimiter = hasPlus ? "+" : hasDashModifiers ? "-" : null;
    const parts = delimiter ? trimmed.split(delimiter) : [trimmed];

    const normalized = parts
      .map((part) => {
        const token = part.trim();
        if (!token) return "";
        const lower = token.toLowerCase();
        switch (lower) {
          case "cmd":
          case "command":
          case "meta":
            return "Meta";
          case "ctrl":
          case "control":
            return "Control";
          case "alt":
          case "option":
            return "Alt";
          case "shift":
            return "Shift";
          case "esc":
            return "Escape";
          case "return":
            return "Enter";
          case "space":
          case "spacebar":
            return "Space";
          case "del":
            return "Delete";
          default:
            return token.length === 1 ? token.toUpperCase() : token;
        }
      })
      .filter(Boolean);

    return normalized.join("+") || "Enter";
  }

  /**
   * Escape special characters in strings for JavaScript
   */
  private escapeString(str: string): string {
    return str
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  }
}

/**
 * Build the best selector for an element from ElementInfo
 */
export function buildBestSelector(info: ElementInfo): string {
  // Priority: data-testid, id, role+name, text content, CSS

  // 1. data-testid
  if (info.selector.includes("data-testid")) {
    return info.selector;
  }

  // 2. ID
  if (info.id) {
    return `#${info.id}`;
  }

  // 3. Role + name (aria-label or visible text)
  if (info.role) {
    const name = info.ariaLabel || info.name || info.text?.slice(0, 30);
    if (name) {
      return `[role="${info.role}"][aria-label="${name}"]`;
    }
  }

  // 4. Button/link with text
  if (
    (info.tagName === "button" || info.tagName === "a") &&
    info.text &&
    info.text.length < 30
  ) {
    return `${info.tagName}:has-text("${info.text}")`;
  }

  // 5. Input with placeholder
  if (
    (info.tagName === "input" || info.tagName === "textarea") &&
    info.placeholder
  ) {
    return `${info.tagName}[placeholder="${info.placeholder}"]`;
  }

  // 6. Fallback to the selector from ElementInfo
  return info.selector;
}
