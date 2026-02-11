import { Action } from "../types/actions.js";
import { GetNextActionResult } from "./base.js";

/**
 * Validate and normalize a raw action object from AI response
 */
export function validateAction(action: unknown): Action {
  if (!action || typeof action !== "object") {
    return { type: "done", success: false, reason: "Invalid action object" };
  }

  const a = action as Record<string, unknown>;
  const type = a.type as string;

  switch (type) {
    case "click":
    case "double_click":
    case "mouse_move":
      return {
        type: type as "click" | "double_click" | "mouse_move",
        x: Number(a.x) || 0,
        y: Number(a.y) || 0,
        ...(type === "click" && a.button
          ? { button: a.button as "left" | "right" | "middle" }
          : {}),
      } as Action;

    case "click_button":
      return {
        type: "click_button",
        name: String(a.name || ""),
        exact: "exact" in a ? Boolean(a.exact) : true,
      };

    case "click_text":
      return {
        type: "click_text",
        text: String(a.text || ""),
        exact: "exact" in a ? Boolean(a.exact) : false,
      };

    case "select_input":
      return {
        type: "select_input",
        field: String(a.field || ""),
        value: String(a.value || ""),
        exact: "exact" in a ? Boolean(a.exact) : true,
      };

    case "mouse_down":
    case "mouse_up":
      return {
        type: type as "mouse_down" | "mouse_up",
        x: Number(a.x) || 0,
        y: Number(a.y) || 0,
        ...(a.button ? { button: a.button as "left" | "right" | "middle" } : {}),
      } as Action;

    case "drag":
      return {
        type: "drag",
        startX: Number(a.startX) || 0,
        startY: Number(a.startY) || 0,
        endX: Number(a.endX) || 0,
        endY: Number(a.endY) || 0,
      };

    case "type":
      return { type: "type", text: String(a.text || "") };

    case "key":
      return { type: "key", key: String(a.key || "Enter") };

    case "scroll":
      return {
        type: "scroll",
        x: Number(a.x) || 0,
        y: Number(a.y) || 0,
        direction: a.direction === "up" ? "up" : "down",
        amount: Math.max(200, Number(a.amount) || 0),
      };

    case "wait":
      return { type: "wait", ms: Number(a.ms) || 1000 };

    case "assert_visible":
      return {
        type: "assert_visible",
        x: Number(a.x) || 0,
        y: Number(a.y) || 0,
      };

    case "assert_text":
      return {
        type: "assert_text",
        text: String(a.text || ""),
      };

    case "done":
      return {
        type: "done",
        success: Boolean(a.success),
        reason: String(a.reason || ""),
      };

    default:
      return { type: "done", success: false, reason: `Unknown action: ${type}` };
  }
}

/**
 * Parse a raw text response from any AI provider into a GetNextActionResult.
 * Handles direct JSON, fenced code blocks, and embedded JSON objects.
 */
export function parseJsonResponse(content: string | null | undefined): GetNextActionResult {
  if (!content) {
    return {
      actions: [{ type: "done", success: false, reason: "No response from AI" }],
      reasoning: "No response from AI",
    };
  }

  const tryParse = (input: string): GetNextActionResult => {
    const parsed = JSON.parse(input) as {
      actions?: Action[];
      reasoning?: string;
    };
    const reasoning = parsed.reasoning || "No reasoning provided";
    if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
      return {
        actions: parsed.actions.map((action) => validateAction(action)),
        reasoning,
        rawResponse: content,
      };
    }
    return {
      actions: [{ type: "done", success: false, reason: "No actions returned" }],
      reasoning,
      rawResponse: content,
    };
  };

  try {
    return tryParse(content);
  } catch {
    const extracted = extractBestJsonObject(content);
    if (extracted) {
      try {
        return tryParse(extracted);
      } catch {
        // fall through
      }
    }
    return {
      actions: [
        {
          type: "done",
          success: false,
          reason: `Failed to parse response: ${content}`,
        },
      ],
      reasoning: "Failed to parse AI response",
      rawResponse: content,
    };
  }
}

/**
 * Extract the best JSON object from a string that may contain surrounding text.
 */
function extractBestJsonObject(input: string): string | null {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const candidates: Array<{ text: string; parsed: unknown }> = [];
  const stack: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "{") {
      stack.push(i);
    } else if (ch === "}" && stack.length > 0) {
      const start = stack.pop()!;
      const candidate = input.slice(start, i + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") {
          candidates.push({ text: candidate, parsed });
        }
      } catch {
        // keep searching for a valid JSON object
      }
    }
  }

  if (candidates.length === 0) return null;
  const withActions = candidates.filter((item) => {
    const parsed = item.parsed as { actions?: unknown };
    return Array.isArray(parsed.actions);
  });
  const pool = withActions.length > 0 ? withActions : candidates;
  pool.sort((a, b) => b.text.length - a.text.length);
  return pool[0].text;
}
