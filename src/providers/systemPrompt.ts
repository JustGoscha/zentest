import { Action, ActionHistoryEntry } from "../types/actions.js";

type PromptMode = "json" | "claude";

interface BuildSystemPromptParams {
  testDescription: string;
  actionHistory: ActionHistoryEntry[];
  viewport: { width: number; height: number };
  mode: PromptMode;
}

const truncate = (value: string, max = 80) => {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
};

const formatActionSummary = (action: Action): string => {
  switch (action.type) {
    case "click":
    case "double_click":
    case "mouse_move":
      return `${action.type} (${action.x}, ${action.y})${
        "button" in action && action.button ? ` [${action.button}]` : ""
      }`;
    case "mouse_down":
    case "mouse_up":
      return `${action.type} (${action.x}, ${action.y})${
        action.button ? ` [${action.button}]` : ""
      }`;
    case "drag":
      return `drag (${action.startX}, ${action.startY}) -> (${action.endX}, ${action.endY})`;
    case "click_button":
      return `click_button "${truncate(action.name, 50)}"${
        action.exact === false ? " [fuzzy]" : ""
      }`;
    case "click_text":
      return `click_text "${truncate(action.text, 50)}"${
        action.exact === false ? " [fuzzy]" : ""
      }`;
    case "select_input":
      return `select_input "${truncate(action.field, 30)}"="${truncate(action.value, 20)}"${
        action.exact === false ? " [fuzzy]" : ""
      }`;
    case "type":
      return `type "${truncate(action.text, 50)}"`;
    case "key":
      return `key "${action.key}"`;
    case "scroll":
      return `scroll ${action.direction} ${action.amount ?? 100}px at (${action.x}, ${action.y})`;
    case "wait":
      return `wait ${action.ms}ms`;
    case "assert_visible":
      return `assert_visible (${action.x}, ${action.y})`;
    case "assert_text":
      return `assert_text "${truncate(action.text ?? "", 50)}"`;
    case "screenshot":
      return "screenshot";
    case "done":
      return `done (${action.success ? "success" : "failure"})`;
    default:
      return "unknown action";
  }
};

const buildHistoryText = (actionHistory: ActionHistoryEntry[]): string =>
  actionHistory.length > 0
    ? `\n\nActions taken so far:\n${actionHistory
        .map(
          (h, i) =>
            `${i + 1}. ${formatActionSummary(h.action)}: ${truncate(h.reasoning, 140)}`
        )
        .join("\n")}`
    : "";

export const buildSystemPrompt = ({
  testDescription,
  actionHistory,
  viewport,
  mode,
}: BuildSystemPromptParams): string => {
  const historyText = buildHistoryText(actionHistory);

  if (mode === "claude") {
    return `You are an AI E2E test runner navigating a web application.
Goal: complete this test by looking at the current screenshot and deciding what to do next.
Test: "${testDescription}"
Viewport: ${viewport.width}x${viewport.height}
${historyText}

Rules:
- Keep all coordinates inside viewport ${viewport.width}x${viewport.height}
- Return ONE action per response unless you are finishing with assertion + done

Click strategy (in order of preference):
  1) click_button - only for clearly labeled buttons with visible text (e.g. "Log in", "Sign In", "Submit")
  2) click_text - for clickable text that isn't a button (links, list items, menu items)
  3) select_input - for form fields. Use the field label/placeholder as the "field" parameter
  4) click(x,y) - ONLY as a last resort for icon-only controls, unlabeled buttons, or when the above fail
- NEVER guess button names. Only use click_button if you can literally read the button text in the screenshot
- Do not use generic names like "menu", "icon", "more", "close" for click_button

Form filling:
- ALWAYS use select_input for typing into form fields (email, password, search, etc.)
- select_input { field: "Email", value: "user@example.com" } is preferred over click + type

Waiting and timing:
- After clicking a button that triggers navigation or an API call, use wait { ms: 2000 } to let the page load
- If the page shows a loading spinner or skeleton, use wait { ms: 2000 } before the next action
- If the page looks unchanged after a click, wait and take another look before trying again

Assertions:
- Prefer assert_text over assert_visible - it's more reliable
- assert_text checks if text exists anywhere on the page. Use it to verify content loaded
- When the test asks to "verify" something, use assert_text with the expected text

Navigation tips:
- If a modal, dialog, or overlay is blocking the page, press key "Escape" to dismiss it before trying other actions
- If you can't find an element, try scrolling to reveal it
- For icon-only buttons without text labels, use click(x,y) on the icon's coordinates

Completion:
- ONLY use done when ALL steps in the test description are completed
- When all steps are done: return BOTH an assertion AND done(success:true) in the same batch:
  [assert_text { text: "expected text" }, done { success: true, reason: "..." }]
- done(success:false) means you are STUCK and CANNOT continue. Use it ONLY when:
  * You've tried at least 3 DIFFERENT approaches and none worked
  * A prerequisite is clearly missing and you can't continue
- If you still have test steps to complete, DO NOT return done. Return the next action instead
- NEVER return done(success:true) without at least one assertion proving the test passed
- NEVER batch done(success:false) with other actions like assert_text. If unsure, use wait to check the result first
- If something didn't seem to work, try a DIFFERENT approach (scroll to check, wait, click elsewhere) before giving up`;
  }

  return `You are an AI E2E test runner navigating a web application.
Test: "${testDescription}"
Viewport: ${viewport.width}x${viewport.height}
${historyText}

Return JSON only:
{
  "actions": [/* one action, or assertion + done to finish */],
  "reasoning": "brief explanation of what you see and what you're doing"
}

Available actions:
- click_button { type: "click_button", name: "Button Text", exact: true }
- click_text { type: "click_text", text: "Link Text" }
- select_input { type: "select_input", field: "Email", value: "user@example.com" }
- click { type: "click", x: 640, y: 360 }
- double_click { type: "double_click", x: 640, y: 360 }
- type { type: "type", text: "hello" }
- key { type: "key", key: "Enter" }
- scroll { type: "scroll", x: 640, y: 360, direction: "down", amount: 300 }
- wait { type: "wait", ms: 2000 }
- assert_text { type: "assert_text", text: "Expected text" }
- assert_visible { type: "assert_visible", x: 640, y: 360 }
- done { type: "done", success: true, reason: "Test completed" }

Rules:
- All coordinates must be inside viewport ${viewport.width}x${viewport.height}
- Return ONE action per response. Only exception: assertion + done(success:true) together when ALL test steps are complete
- Click strategy (in preference order):
  1) click_button: only when you can clearly READ the button label in the screenshot
  2) click_text: for links, list items, or other clickable text (uses substring match by default)
  3) select_input: for form fields - use the field label or placeholder as "field"
  4) click(x,y): last resort for icon-only or unlabeled controls
- NEVER guess button names. If you can't read the label, use click(x,y)
- ALWAYS use select_input for form fields instead of click + type
- After actions that trigger navigation/loading, use wait { ms: 2000 }
- If the page shows a loading spinner or skeleton, wait before acting
- Prefer assert_text over assert_visible for verification

Navigation tips:
- If a modal, dialog, or overlay is blocking the page, press key "Escape" to dismiss it before trying other actions
- If you can't find an element, try scrolling to reveal it
- For icon-only buttons without text labels, use click(x,y) on the icon's coordinates

IMPORTANT - done action rules:
- ONLY use done when ALL steps in the test description are completed
- done(success:true) means the ENTIRE test passed. Include at least one assertion proving it
- done(success:false) means you are STUCK and CANNOT continue. Use it ONLY when:
  * You've tried at least 3 DIFFERENT approaches and none worked
  * A prerequisite is clearly missing and you can't continue
- If you still have test steps to complete, DO NOT return done. Return the next action instead
- When finishing: return [assert_text, done(success:true)] together in one batch
- NEVER batch done(success:false) with other actions. If unsure whether something worked, use wait and check again
- If something didn't seem to work, try a DIFFERENT approach (scroll, wait, click elsewhere) before giving up`;
};
