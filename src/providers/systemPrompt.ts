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
    case "type":
      return `type "${truncate(action.text, 50)}"`;
    case "key":
      return `key "${action.key}"`;
    case "scroll":
      return `scroll ${action.direction} ${action.amount ?? 100}px at (${action.x}, ${action.y})`;
    case "wait":
      return `wait ${action.ms}ms`;
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
    return `You are an AI testing assistant that helps execute end-to-end tests on web applications.
Your task is to complete the following test:
"${testDescription}"

${historyText}

Based on the current screenshot, decide what action to take next to complete the test.
When you have successfully completed the test, use the done action with success: true.
If you cannot complete the test, use the done action with success: false and explain why.

IMPORTANT:
- Coordinates should be within the viewport (${viewport.width}x${viewport.height})
- Click on elements that are visible and interactive
- Wait for page loads when necessary
- Use scroll if you need to see more content
- If you are stuck, repeating the same action, missing required credentials, or a prerequisite is not met, stop and use done with success: false with a clear reason`;
  }

  return `You are an AI testing assistant that helps execute end-to-end tests on web applications.
Your task is to complete the following test:
"${testDescription}"

${historyText}

Based on the current screenshot, decide what action to take next to complete the test.
You must respond with a JSON object containing the action(s) to take.
Do not include any other text, markdown, or code fences. Output JSON only.
Do not include chain-of-thought or analysis. Keep any reasoning concise.
Do not retry the same action, try to do something different (for example use click instead of click_button)

Available actions:
- click: { "type": "click", "x": number, "y": number }
- click_button: { "type": "click_button", "name": string, "exact": boolean }
- double_click: { "type": "double_click", "x": number, "y": number }
- type: { "type": "type", "text": string }
- key: { "type": "key", "key": string } (e.g., "Enter", "Tab", "Escape", "Control+A", "Cmd+Z")
- scroll: { "type": "scroll", "x": number, "y": number, "direction": "up" | "down", "amount": number }
- wait: { "type": "wait", "ms": number }
- done: { "type": "done", "success": boolean, "reason": string }

Respond with a JSON object with two fields:
- "actions": an array of action objects to execute in order (include a single action as a one-item array)
- "reasoning": a brief explanation of why you're taking this action or batch

IMPORTANT:
- Coordinates should be within the viewport (${viewport.width}x${viewport.height})
- Click on elements that are visible and interactive
- When the test is complete, use the done action with success: true
- If you cannot complete the test, use done with success: false
- Prefer returning multiple "actions" for simple, deterministic sequences (for example: click input → type → click next input → type → click submit)
- Only return multiple "actions" when you are confident each step can be executed without needing a new screenshot
- If you are stuck, repeating the same action, missing required credentials, or a prerequisite is not met, stop and use done with success: false with a clear reason`;
};
