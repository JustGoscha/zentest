import { Page } from "playwright";
import { Action, ActionResult, ElementInfo } from "../types/actions.js";
import { captureScreenshot } from "./screenshot.js";

/**
 * Executes actions via Playwright and returns results with element info
 */
export class BrowserExecutor {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Execute an action and return the result with element info
   */
  async execute(action: Action): Promise<ActionResult> {
    const timestamp = Date.now();

    try {
      switch (action.type) {
        case "mouse_move":
          await this.page.mouse.move(action.x, action.y);
          break;

        case "mouse_down":
          await this.page.mouse.move(action.x, action.y);
          await this.page.mouse.down({ button: action.button || "left" });
          break;

        case "mouse_up":
          await this.page.mouse.move(action.x, action.y);
          await this.page.mouse.up({ button: action.button || "left" });
          break;

        case "click": {
          await this.page.mouse.click(action.x, action.y, {
            button: action.button || "left",
          });
          const elementInfo = await this.getElementAtPoint(action.x, action.y);
          const screenshot = await captureScreenshot(this.page);
          return { action, screenshot, elementInfo, timestamp };
        }

        case "double_click": {
          await this.page.mouse.dblclick(action.x, action.y);
          const elementInfo = await this.getElementAtPoint(action.x, action.y);
          const screenshot = await captureScreenshot(this.page);
          return { action, screenshot, elementInfo, timestamp };
        }

        case "drag":
          await this.page.mouse.move(action.startX, action.startY);
          await this.page.mouse.down();
          await this.page.mouse.move(action.endX, action.endY);
          await this.page.mouse.up();
          break;

        case "type":
          await this.page.keyboard.type(action.text);
          break;

        case "key":
          await this.page.keyboard.press(action.key);
          break;

        case "scroll": {
          await this.page.mouse.move(action.x, action.y);
          const delta = (action.amount || 100) * (action.direction === "up" ? -1 : 1);
          await this.page.mouse.wheel(0, delta);
          break;
        }

        case "wait":
          await this.page.waitForTimeout(action.ms);
          break;

        case "screenshot":
          // Just return the screenshot
          break;

        case "done":
          // Terminal action, just return
          break;
      }

      await this.waitForScreenshotJitter();
      const screenshot = await captureScreenshot(this.page);
      return { action, screenshot, timestamp };
    } catch (error) {
      await this.waitForScreenshotJitter();
      const screenshot = await captureScreenshot(this.page);
      return {
        action,
        screenshot,
        error: error instanceof Error ? error.message : String(error),
        timestamp,
      };
    }
  }

  /**
   * Get element info at a specific point using elementFromPoint
   */
  async getElementAtPoint(x: number, y: number): Promise<ElementInfo | undefined> {
    try {
      const elementInfo = await this.page.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          if (!element) return null;

          // Build the best selector for this element
          const buildSelector = (el: Element): string => {
            // Priority: data-testid, id, role+name, class+tag
            const testId = el.getAttribute("data-testid");
            if (testId) return `[data-testid="${testId}"]`;

            const id = el.id;
            if (id) return `#${id}`;

            const role = el.getAttribute("role");
            const ariaLabel = el.getAttribute("aria-label");
            if (role && ariaLabel) {
              return `[role="${role}"][aria-label="${ariaLabel}"]`;
            }

            // For buttons/links with text
            const tagName = el.tagName.toLowerCase();
            const text = el.textContent?.trim().slice(0, 50);
            if (
              (tagName === "button" || tagName === "a") &&
              text &&
              text.length < 30
            ) {
              return `${tagName}:has-text("${text}")`;
            }

            // Fallback to class-based selector
            const className = el.className;
            if (className && typeof className === "string") {
              const classes = className.split(" ").filter((c) => c).slice(0, 2);
              if (classes.length > 0) {
                return `${tagName}.${classes.join(".")}`;
              }
            }

            return tagName;
          };

          return {
            tagName: element.tagName.toLowerCase(),
            text: element.textContent?.trim().slice(0, 100),
            role: element.getAttribute("role") || undefined,
            name:
              element.getAttribute("aria-label") ||
              element.getAttribute("name") ||
              undefined,
            id: element.id || undefined,
            className:
              typeof element.className === "string"
                ? element.className
                : undefined,
            href:
              element instanceof HTMLAnchorElement ? element.href : undefined,
            placeholder:
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
                ? element.placeholder
                : undefined,
            ariaLabel: element.getAttribute("aria-label") || undefined,
            selector: buildSelector(element),
          };
        },
        { x, y }
      );

      return elementInfo || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Wait for page to become stable (network idle)
   */
  async waitForStable(): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // Timeout is okay, page might have ongoing requests
    }
  }

  private async waitForScreenshotJitter(): Promise<void> {
    const delayMs = 300 + Math.floor(Math.random() * 701);
    await this.page.waitForTimeout(delayMs);
  }
}
