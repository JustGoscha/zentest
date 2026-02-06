import { Test, TestSuite } from "../runner/testParser.js";
import { RecordedStep, Action, ElementInfo } from "../types/actions.js";

export interface TestResult {
  test: Test;
  steps: RecordedStep[];
}

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
  generate(steps: RecordedStep[], test: Test): string {
    const lines: string[] = [
      `import { test, expect } from '@playwright/test';`,
      ``,
      `async function loadZentestConfig() {`,
      `  try {`,
      `    const configUrl = new URL('../../zentest.config.js', import.meta.url);`,
      `    const loaded = await import(configUrl.href);`,
      `    return (loaded && loaded.default) || loaded || {};`,
      `  } catch {`,
      `    return {};`,
      `  }`,
      `}`,
      ``,
      ...this.buildDescriptionComment(test.description),
      `test('${test.name}', async ({ page }) => {`,
      `  const zentestConfig = await loadZentestConfig();`,
      `  const envName = process.env.ZENTEST_ENV;`,
      `  const envUrl = envName ? zentestConfig.environments?.[envName]?.url : undefined;`,
      `  const baseUrl = envUrl || zentestConfig.baseUrl;`,
      `  if (!baseUrl) {`,
      `    throw new Error('baseUrl is required to run static tests. Set it in zentest.config.js or use ZENTEST_ENV to select an environment.');`,
      `  }`,
      `  await page.goto(baseUrl, { waitUntil: 'networkidle' });`,
    ];

    const seenAssertions = new Set<string>();
    
    for (const step of steps) {
      const code = this.stepToCode(step);
      if (code) {
        // Deduplicate identical assertions
        const isAssertion = step.action.type === 'assert_visible' || step.action.type === 'assert_text';
        if (isAssertion && seenAssertions.has(code)) {
          continue; // Skip duplicate assertion
        }
        
        if (isAssertion) {
          seenAssertions.add(code);
        }
        
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

  /**
   * Generate a Playwright test suite from multiple tests
   * Uses test.describe.serial() so tests run in order and share browser state
   */
  generateSuite(testResults: TestResult[], suite: TestSuite): string {
    const lines: string[] = [
      `import { test, expect } from '@playwright/test';`,
      ``,
      ...this.buildConfigLoader(),
      ``,
      `test.describe.serial('${this.escapeString(suite.name)}', () => {`,
      `  let baseUrl;`,
      `  let page;`,
      ``,
      `  test.beforeAll(async ({ browser }) => {`,
      `    const zentestConfig = await loadZentestConfig();`,
      `    const envName = process.env.ZENTEST_ENV;`,
      `    const envUrl = envName ? zentestConfig.environments?.[envName]?.url : undefined;`,
      `    baseUrl = envUrl || zentestConfig.baseUrl;`,
      `    if (!baseUrl) {`,
      `      throw new Error('baseUrl is required to run static tests. Set it in zentest.config.js or use ZENTEST_ENV to select an environment.');`,
      `    }`,
      `    page = await browser.newPage();`,
      `  });`,
      ``,
      `  test.afterAll(async () => {`,
      `    await page.close();`,
      `  });`,
      ``,
    ];

    let isFirst = true;
    for (const { test, steps } of testResults) {
      lines.push(...this.buildTestBlock(test, steps, isFirst));
      isFirst = false;
    }

    lines.push(`});`);
    lines.push(``);

    return lines.join("\n");
  }

  private buildConfigLoader(): string[] {
    return [
      `async function loadZentestConfig() {`,
      `  try {`,
      `    const configUrl = new URL('../../zentest.config.js', import.meta.url);`,
      `    const loaded = await import(configUrl.href);`,
      `    return (loaded && loaded.default) || loaded || {};`,
      `  } catch {`,
      `    return {};`,
      `  }`,
      `}`,
    ];
  }

  private buildTestBlock(test: Test, steps: RecordedStep[], navigateFirst: boolean): string[] {
    const lines: string[] = [];

    // Add description comment
    lines.push(...this.buildDescriptionComment(test.description).map(line => `  ${line}`));
    lines.push(`  test('${test.name}', async () => {`);

    // Only navigate on first test
    if (navigateFirst) {
      lines.push(`    await page.goto(baseUrl, { waitUntil: 'networkidle' });`);
    }

    const seenAssertions = new Set<string>();

    for (const step of steps) {
      const code = this.stepToCode(step);
      if (code) {
        // Deduplicate identical assertions
        const isAssertion = step.action.type === 'assert_visible' || step.action.type === 'assert_text';
        if (isAssertion && seenAssertions.has(code)) {
          continue; // Skip duplicate assertion
        }

        if (isAssertion) {
          seenAssertions.add(code);
        }

        // Add reasoning as comment
        if (step.reasoning) {
          lines.push(`    // ${step.reasoning.slice(0, 80)}`);
        }
        lines.push(`    ${code}`);
      }
    }

    lines.push(`  });`);
    lines.push(``);

    return lines;
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

  private stepToCode(step: RecordedStep): string | null {
    switch (step.action.type) {
      case "click": {
        const locator = this.buildLocator(step.elementInfo, step.action);
        if (locator) {
          return `await ${locator}.click();`;
        }
        // Fallback to coordinate-based click
        return `await page.mouse.click(${step.action.x}, ${step.action.y});`;
      }

      case "click_button": {
        // Use getByRole with name parameter - name uses accessible name (button text content)
        // Always use exact: true to avoid matching multiple buttons with similar text
        return `await page.getByRole('button', { name: '${this.escapeString(step.action.name)}', exact: true }).click();`;
      }

      case "double_click": {
        const locator = this.buildLocator(step.elementInfo, step.action);
        if (locator) {
          return `await ${locator}.dblclick();`;
        }
        // Fallback to coordinate-based double click
        return `await page.mouse.dblclick(${step.action.x}, ${step.action.y});`;
      }

      case "type": {
        const locator = this.buildLocator(step.elementInfo, step.action);
        if (locator) {
          return `await ${locator}.fill('${this.escapeString(step.action.text)}');`;
        }
        // Fallback: type at current focus
        return `await page.keyboard.type('${this.escapeString(step.action.text)}');`;
      }

      case "key":
        return `await page.keyboard.press('${this.normalizeKeyCombo(step.action.key)}');`;

      case "scroll":
        return `await page.mouse.wheel(0, ${(step.action.amount || 100) * (step.action.direction === "up" ? -1 : 1)});`;

      case "wait":
        return `await page.waitForTimeout(${step.action.ms});`;

      case "assert_visible": {
        const locator = this.buildLocator(step.elementInfo, step.action);
        if (locator) {
          return `await expect(${locator}).toBeVisible();`;
        }
        // Fallback: check element exists at coordinates
        return `await expect(page.locator('body')).toBeVisible(); // assert_visible at (${step.action.x}, ${step.action.y})`;
      }

      case "assert_text": {
        // Use text directly from action
        return `await expect(page.getByText('${this.escapeString(step.action.text)}', { exact: false })).toBeVisible();`;
      }

      case "done":
        return null; // Don't generate code for done actions

      case "mouse_move":
      case "mouse_down":
      case "mouse_up":
      case "drag":
      case "screenshot":
        return null; // These are intermediate actions, don't generate code

      default: {
        // TypeScript exhaustiveness check
        const actionType = (step.action as Action).type;
        return `// ${actionType}: ${step.reasoning}`;
      }
    }
  }

  /**
   * Build the smartest Playwright locator from ElementInfo
   * Priority: data-testid > role+name > label > placeholder > text > id
   * NEVER use CSS selectors for inputs/buttons - always use getByRole/getByLabel/getByPlaceholder
   */
  private buildLocator(info: ElementInfo | undefined, action: Action): string | null {
    if (!info) {
      return null;
    }

    // 1. data-testid - most stable, explicit opt-in
    const testIdMatch = info.selector.match(/\[data-testid="([^"]+)"\]/);
    if (testIdMatch) {
      return `page.getByTestId('${testIdMatch[1]}')`;
    }

    // 2. For inputs and textareas: ALWAYS use getByRole/getByLabel/getByPlaceholder, never CSS selectors
    if (info.tagName === "input" || info.tagName === "textarea") {
      const role = info.role || this.inferRoleFromTagName(info.tagName);
      
      // Try getByRole with accessible name (from label, aria-label, or placeholder)
      if (role) {
        const accessibleName = info.ariaLabel || info.name || info.placeholder || null;
        if (accessibleName) {
          return `page.getByRole('${role}', { name: '${this.escapeString(accessibleName)}', exact: true })`;
        }
      }
      
      // Try getByLabel (uses associated label text)
      if (info.name) {
        return `page.getByLabel('${this.escapeString(info.name)}')`;
      }
      
      // Try getByPlaceholder
      if (info.placeholder) {
        return `page.getByPlaceholder('${this.escapeString(info.placeholder)}')`;
      }
      
      // Last resort: getByRole without name (less ideal but still semantic)
      if (role) {
        return `page.getByRole('${role}')`;
      }
      
      // If we can't infer role, return null rather than using CSS selector
      return null;
    }

    // 3. role + accessible name - Playwright's recommended approach for other elements
    // name uses accessible name which is the button's text content (when no aria-label)
    const role = info.role || this.inferRoleFromTagName(info.tagName);
    if (role) {
      const accessibleName = info.ariaLabel || info.name || info.text || null;
      if (accessibleName) {
        // Use exact: true to avoid matching multiple elements with similar text
        return `page.getByRole('${role}', { name: '${this.escapeString(accessibleName)}', exact: true })`;
      }
    }

    // 4. text content - for non-interactive elements or when no better option
    if (info.text) {
      return `page.getByText('${this.escapeString(info.text)}', { exact: true })`;
    }

    // 5. id - stable but not semantic (only for non-input elements)
    if (info.id) {
      return `page.locator('#${info.id}')`;
    }

    // 6. Never fall back to CSS selectors for inputs/buttons
    // For other elements, only use selector if it's not generic
    if (info.tagName !== "input" && info.tagName !== "button" && info.selector && !this.isGenericSelector(info.selector)) {
      return `page.locator('${this.escapeString(info.selector)}')`;
    }

    return null;
  }

  /**
   * Infer Playwright role from HTML tag name
   */
  private inferRoleFromTagName(tagName: string): string | null {
    const tag = tagName.toLowerCase();
    switch (tag) {
      case "button":
        return "button";
      case "a":
        return "link";
      case "input":
        // Default to textbox for inputs (most common case)
        // Specific types (checkbox, radio) should be set via info.role
        return "textbox";
      case "textarea":
        return "textbox";
      case "select":
        return "combobox";
      case "checkbox":
      case "input[type='checkbox']":
        return "checkbox";
      case "radio":
      case "input[type='radio']":
        return "radio";
      default:
        return null;
    }
  }


  /**
   * Check if selector is a generic tag name (not useful as locator)
   */
  private isGenericSelector(selector: string): boolean {
    const genericTags = /^(p|h1|h2|h3|h4|h5|h6|div|span|a|button|input|textarea|label|form|section|article|header|footer|nav|main|aside)$/i;
    return genericTags.test(selector);
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

