import OpenAI from "openai";
import {
  ComputerUseProvider,
  GetNextActionParams,
  GetNextActionResult,
  TokenUsage,
} from "./base.js";
import { Action } from "../types/actions.js";
import { buildSystemPrompt } from "./systemPrompt.js";

/**
 * OpenAI computer use provider
 * Note: As of early 2025, OpenAI's computer use is in preview via the Responses API
 */
export class OpenAIProvider implements ComputerUseProvider {
  readonly name = "openai";
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model: string = "gpt-4o") {
    const key = apiKey || process.env.ZENTEST_OPENAI_API_KEY;
    if (!key) {
      throw new Error(
        "OpenAI API key required. Set ZENTEST_OPENAI_API_KEY or pass apiKey in config."
      );
    }
    this.client = new OpenAI({ apiKey: key });
    this.model = model;
  }

  async getNextAction(params: GetNextActionParams): Promise<GetNextActionResult> {
    const { screenshot, testDescription, actionHistory, viewport, lastFailureText } =
      params;

    const systemPrompt = buildSystemPrompt({
      testDescription,
      actionHistory,
      viewport,
      mode: "json",
    });

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${screenshot.toString("base64")}`,
              },
            },
            {
              type: "text",
              text: `${
                lastFailureText
                  ? `Last instruction failed: ${lastFailureText}. Try a different action.\n\n`
                  : ""
              }Did we complete the test? If not, what action should I take next to complete the test? Respond with JSON.`,
            },
          ],
        },
      ],
    });

    const parsed = this.parseResponse(response);
    return {
      ...parsed,
      usage: this.extractUsage(response),
    };
  }

  private parseResponse(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): GetNextActionResult {
    const content = response.choices[0]?.message?.content;
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
          actions: parsed.actions.map((action) => this.validateAction(action)),
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

    const extractBestJsonObject = (input: string): string | null => {
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

  private validateAction(action: unknown): Action {
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
          amount: Number(a.amount) || 100,
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
          x: Number(a.x) || 0,
          y: Number(a.y) || 0,
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

  private extractUsage(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): TokenUsage | undefined {
    const usage = response.usage;
    if (!usage) return undefined;
    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    };
  }
}
