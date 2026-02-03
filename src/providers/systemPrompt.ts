import { ActionHistoryEntry } from "../types/actions.js";

type PromptMode = "json" | "claude";

interface BuildSystemPromptParams {
  testDescription: string;
  actionHistory: ActionHistoryEntry[];
  viewport: { width: number; height: number };
  mode: PromptMode;
}

const buildHistoryText = (actionHistory: ActionHistoryEntry[]): string =>
  actionHistory.length > 0
    ? `\n\nActions taken so far:\n${actionHistory
        .map((h, i) => {
          const errorText = h.error ? ` (error: ${h.error})` : "";
          return `${i + 1}. ${h.action.type}: ${h.reasoning}${errorText}`;
        })
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

Available actions:
- click: { "type": "click", "x": number, "y": number }
- click_button: { "type": "click_button", "name": string, "exact": boolean }
- double_click: { "type": "double_click", "x": number, "y": number }
- type: { "type": "type", "text": string }
- key: { "type": "key", "key": string } (e.g., "Enter", "Tab", "Escape")
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
- Prefer returning "actions" for simple, deterministic sequences (for example: click input → type → click next input → type → click submit)
- Only return "actions" when you are confident each step can be executed without needing a new screenshot
- If you are stuck, repeating the same action, missing required credentials, or a prerequisite is not met, stop and use done with success: false with a clear reason`;
};
