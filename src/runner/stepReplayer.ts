import { Page } from "playwright";
import { RecordedStep } from "../types/actions.js";

const POST_CLICK_WAIT_MS = 250;

/**
 * Replay recorded steps on a live Playwright page.
 * This is the runtime equivalent of TestBuilder.stepToCode —
 * instead of generating code strings, it executes actions directly.
 *
 * Assertions are skipped during replay since we're just
 * fast-forwarding browser state for the healer.
 */
export async function replaySteps(
  page: Page,
  steps: RecordedStep[]
): Promise<void> {
  for (const step of steps) {
    if (step.error) continue;
    await replayStep(page, step);
  }
}

async function replayStep(page: Page, step: RecordedStep): Promise<void> {
  const action = step.action;

  switch (action.type) {
    case "click":
      await page.mouse.click(action.x, action.y);
      await page.waitForTimeout(POST_CLICK_WAIT_MS);
      break;

    case "click_button": {
      const exact = action.exact ?? true;
      await page
        .getByRole("button", { name: action.name, exact })
        .click();
      const isSubmit =
        /sign.?in|log.?in|submit|save|confirm|continue|next/i.test(
          action.name
        );
      if (isSubmit) {
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(1000);
      } else {
        await page.waitForTimeout(POST_CLICK_WAIT_MS);
      }
      break;
    }

    case "click_text": {
      const exact = action.exact ?? false;
      await page.getByText(action.text, { exact }).first().click();
      await page.waitForTimeout(POST_CLICK_WAIT_MS);
      break;
    }

    case "select_input": {
      const exact = action.exact ?? true;
      await fillInputByField(page, action.field, action.value, exact);
      break;
    }

    case "double_click":
      await page.mouse.dblclick(action.x, action.y);
      await page.waitForTimeout(POST_CLICK_WAIT_MS);
      break;

    case "type":
      await page.keyboard.type(action.text);
      break;

    case "key":
      await page.keyboard.press(normalizeKeyCombo(action.key));
      break;

    case "scroll":
      await page.mouse.wheel(
        0,
        (action.amount || 100) * (action.direction === "up" ? -1 : 1)
      );
      break;

    case "wait":
      await page.waitForTimeout(action.ms);
      if (action.ms >= 2000) {
        await page.waitForLoadState("networkidle").catch(() => {});
      }
      break;

    // Skip assertions during replay — we're just fast-forwarding state
    case "assert_visible":
    case "assert_text":
    case "done":
    case "mouse_move":
    case "mouse_down":
    case "mouse_up":
    case "drag":
    case "screenshot":
      break;
  }
}

async function fillInputByField(
  page: Page,
  field: string,
  value: string,
  exact = true
): Promise<void> {
  const candidates = [
    page.getByLabel(field, { exact }),
    page.getByPlaceholder(field, { exact }),
    page.getByRole("textbox", { name: field, exact }),
  ];
  for (const locator of candidates) {
    if ((await locator.count()) > 0) {
      await locator.first().click();
      await locator.first().fill(value);
      return;
    }
  }
  throw new Error(`No input found for field: ${field}`);
}

function normalizeKeyCombo(rawKey: string): string {
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
