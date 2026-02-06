import { Page } from "playwright";
import { Action, ActionResult, ElementInfo } from "../types/actions.js";
import { captureScreenshot } from "./screenshot.js";

const normalizeKeyCombo = (rawKey: string): string => {
  const trimmed = rawKey.trim();
  if (!trimmed) return "Enter";

  const hasPlus = trimmed.includes("+");
  const hasDashModifiers = /(^|[-])(cmd|command|meta|ctrl|control|alt|option|shift)-/i.test(
    trimmed
  );
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
};

/**
 * Executes actions via Playwright and returns results with element info
 */
export class BrowserExecutor {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
    this.page.setDefaultTimeout(5000);
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
          const target = await this.findClickableTarget(action.x, action.y);
          const clickX = target?.x ?? action.x;
          const clickY = target?.y ?? action.y;
          await this.page.mouse.click(clickX, clickY, {
            button: action.button || "left",
          });
          const elementInfo =
            target?.elementInfo ?? (await this.getElementAtPoint(clickX, clickY));
          const screenshot = await captureScreenshot(this.page);
          return { action, screenshot, elementInfo, timestamp };
        }

        case "click_button": {
          const locator = this.page.getByRole("button", {
            name: action.name,
            exact: action.exact ?? true,
          });
          const handle = await locator.first().elementHandle();
          if (!handle) {
            throw new Error(`No button found with name: ${action.name}`);
          }
          await locator.first().click();
          const elementInfo = await this.getElementInfoFromHandle(handle);
          const screenshot = await captureScreenshot(this.page);
          return { action, screenshot, elementInfo, timestamp };
        }

        case "double_click": {
          const target = await this.findClickableTarget(action.x, action.y);
          const clickX = target?.x ?? action.x;
          const clickY = target?.y ?? action.y;
          await this.page.mouse.dblclick(clickX, clickY);
          const elementInfo =
            target?.elementInfo ?? (await this.getElementAtPoint(clickX, clickY));
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
          await this.page.keyboard.press(normalizeKeyCombo(action.key));
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

      case "assert_visible": {
        const elementInfo = await this.getElementAtPoint(action.x, action.y);
        if (!elementInfo) {
          throw new Error(`No element found at (${action.x}, ${action.y})`);
        }
        const locator = this.page.locator(elementInfo.selector).first();
        const visible = await locator.isVisible();
        if (!visible) {
          throw new Error(`Element not visible at (${action.x}, ${action.y})`);
        }
        const expectedText = elementInfo.text?.trim();
        if (expectedText) {
          const actualText = (await locator.textContent()) || "";
          if (!actualText.includes(expectedText)) {
            throw new Error(
              `Expected text "${expectedText}" not found at (${action.x}, ${action.y})`
            );
          }
        } else if (elementInfo.ariaLabel || elementInfo.name) {
          const expectedLabel = elementInfo.ariaLabel || elementInfo.name || "";
          const actualLabel =
            (await locator.getAttribute("aria-label")) ||
            (await locator.getAttribute("name")) ||
            "";
          if (expectedLabel && actualLabel !== expectedLabel) {
            throw new Error(
              `Expected label "${expectedLabel}" not found at (${action.x}, ${action.y})`
            );
          }
        } else if (elementInfo.placeholder) {
          const actualPlaceholder = (await locator.getAttribute("placeholder")) || "";
          if (actualPlaceholder !== elementInfo.placeholder) {
            throw new Error(
              `Expected placeholder "${elementInfo.placeholder}" not found at (${action.x}, ${action.y})`
            );
          }
        }
        const screenshot = await captureScreenshot(this.page);
        return { action, screenshot, elementInfo, timestamp };
      }

      case "assert_text": {
        // Use text-based locator instead of position-based
        // This matches how the test builder generates tests
        const locator = this.page.getByText(action.text, { exact: false });
        const count = await locator.count();
        
        if (count === 0) {
          throw new Error(`Text "${action.text}" not found anywhere on the page`);
        }
        
        // Get element info for the first match (for recording purposes)
        const handle = await locator.first().elementHandle();
        const elementInfo = handle ? await this.getElementInfoFromHandle(handle) : undefined;
        
        const screenshot = await captureScreenshot(this.page);
        return { action, screenshot, elementInfo, timestamp };
      }

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

          // Get associated label text for inputs
          const getLabelText = (el: Element): string | undefined => {
            // Check aria-label first
            const ariaLabel = el.getAttribute("aria-label");
            if (ariaLabel) return ariaLabel;

            // Check for associated label element via 'for' attribute
            if (el.id) {
              const label = document.querySelector(`label[for="${el.id}"]`);
              if (label) {
                const labelText = label.textContent?.trim();
                if (labelText) return labelText;
              }
            }

            // Check for wrapping label element
            const parentLabel = el.closest("label");
            if (parentLabel) {
              const labelText = parentLabel.textContent?.trim();
              if (labelText) return labelText;
            }

            // Check name attribute
            const nameAttr = el.getAttribute("name");
            if (nameAttr) return nameAttr;

            // For inputs/textareas, fall back to placeholder
            if (
              el instanceof HTMLInputElement ||
              el instanceof HTMLTextAreaElement
            ) {
              if (el.placeholder) return el.placeholder;
            }

            return undefined;
          };

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

          const labelText = getLabelText(element);

          return {
            tagName: element.tagName.toLowerCase(),
            text: element.textContent?.trim().slice(0, 100),
            role: element.getAttribute("role") || undefined,
            name: labelText,
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

  private async getElementInfoFromHandle(
    handle: import("playwright").ElementHandle<Element>
  ): Promise<ElementInfo | undefined> {
    try {
      const box = await handle.boundingBox();
      if (!box) return undefined;
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      return await this.getElementAtPoint(centerX, centerY);
    } catch {
      return undefined;
    }
  }


  /**
   * Find a nearby interactive element and return its center point.
   */
  private async findClickableTarget(
    x: number,
    y: number
  ): Promise<{ x: number; y: number; elementInfo: ElementInfo } | undefined> {
    try {
      const target = await this.page.evaluate(({ x, y }) => {
        const isInteractive = (el: Element | null): el is Element => {
          if (!el) return false;
          const tag = el.tagName.toLowerCase();
          if (["button", "a", "input", "textarea", "select", "label"].includes(tag)) {
            return true;
          }
          const role = el.getAttribute("role");
          if (
            role === "button" ||
            role === "link" ||
            role === "checkbox" ||
            role === "tab" ||
            role === "menuitem"
          ) {
            return true;
          }
          if (el.hasAttribute("onclick")) return true;
          const tabIndex = el.getAttribute("tabindex");
          if (tabIndex && tabIndex !== "-1") return true;
          const style = window.getComputedStyle(el as HTMLElement);
          return style.cursor === "pointer";
        };

        const buildSelector = (el: Element): string => {
          const testId = el.getAttribute("data-testid");
          if (testId) return `[data-testid="${testId}"]`;

          const id = (el as HTMLElement).id;
          if (id) return `#${id}`;

          const role = el.getAttribute("role");
          const ariaLabel = el.getAttribute("aria-label");
          if (role && ariaLabel) {
            return `[role="${role}"][aria-label="${ariaLabel}"]`;
          }

          const tagName = el.tagName.toLowerCase();
          const text = el.textContent?.trim().slice(0, 50);
          if (
            (tagName === "button" || tagName === "a") &&
            text &&
            text.length < 30
          ) {
            return `${tagName}:has-text("${text}")`;
          }

          const className = el.className;
          if (className && typeof className === "string") {
            const classes = className.split(" ").filter((c) => c).slice(0, 2);
            if (classes.length > 0) {
              return `${tagName}.${classes.join(".")}`;
            }
          }

          return tagName;
        };

        const interactiveSelector =
          'button,a,input,textarea,select,label,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[onclick],[tabindex]';

        const findBestElement = (): Element | null => {
          const radius = 40;
          const step = 6;
          let best: Element | null = null;
          let bestDist = Infinity;

          for (let dx = -radius; dx <= radius; dx += step) {
            for (let dy = -radius; dy <= radius; dy += step) {
              const px = x + dx;
              const py = y + dy;
              if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) {
                continue;
              }
              const el = document.elementFromPoint(px, py) as Element | null;
              const target =
                (isInteractive(el)
                  ? el
                  : el
                    ? (el as Element).closest(interactiveSelector)
                    : null) || null;
              if (!target) continue;
              const rect = target.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              const dist = Math.hypot(cx - x, cy - y);
              if (dist < bestDist) {
                bestDist = dist;
                best = target;
              }
            }
          }

          return best;
        };

        const element = findBestElement();
        if (!element) return null;

        // Get associated label text for inputs
        const getLabelText = (el: Element): string | undefined => {
          // Check aria-label first
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel;

          // Check for associated label element via 'for' attribute
          if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) {
              const labelText = label.textContent?.trim();
              if (labelText) return labelText;
            }
          }

          // Check for wrapping label element
          const parentLabel = el.closest("label");
          if (parentLabel) {
            const labelText = parentLabel.textContent?.trim();
            if (labelText) return labelText;
          }

          // Check name attribute
          const nameAttr = el.getAttribute("name");
          if (nameAttr) return nameAttr;

          // For inputs/textareas, fall back to placeholder
          if (
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement
          ) {
            if (el.placeholder) return el.placeholder;
          }

          return undefined;
        };

        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const labelText = getLabelText(element);

        return {
          x: centerX,
          y: centerY,
          elementInfo: {
            tagName: element.tagName.toLowerCase(),
            text: element.textContent?.trim().slice(0, 100),
            role: element.getAttribute("role") || undefined,
            name: labelText,
            id: (element as HTMLElement).id || undefined,
            className:
              typeof (element as HTMLElement).className === "string"
                ? (element as HTMLElement).className
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
          },
        };
      }, { x, y });

      if (!target) return undefined;
      return target;
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
