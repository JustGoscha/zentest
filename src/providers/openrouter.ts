import OpenAI from "openai";
import {
  ComputerUseProvider,
  GetNextActionParams,
  GetNextActionResult,
} from "./base.js";
import { Action } from "../types/actions.js";

/**
 * OpenRouter provider - routes to various models via OpenAI-compatible API
 */
export class OpenRouterProvider implements ComputerUseProvider {
  readonly name = "openrouter";
  private client: OpenAI;
  private model: string;

  constructor(apiKey?: string, model: string = "anthropic/claude-sonnet-4") {
    const key = apiKey || process.env.ZENTEST_OPENROUTER_API_KEY;
    if (!key) {
      throw new Error(
        "OpenRouter API key required. Set ZENTEST_OPENROUTER_API_KEY or pass apiKey in config."
      );
    }
    this.client = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://zentest.dev",
        "X-Title": "Zentest",
      },
    });
    this.model = model;
  }

  async getNextAction(params: GetNextActionParams): Promise<GetNextActionResult> {
    const { screenshot, testDescription, actionHistory, viewport } = params;

    // Build conversation context
    const historyText =
      actionHistory.length > 0
        ? `\n\nActions taken so far:\n${actionHistory
            .map((h, i) => `${i + 1}. ${h.action.type}: ${h.reasoning}`)
            .join("\n")}`
        : "";

    const systemPrompt = `You are an AI testing assistant that helps execute end-to-end tests on web applications.
Your task is to complete the following test:
"${testDescription}"

${historyText}

Based on the current screenshot, decide what action to take next to complete the test.
You must respond with a JSON object containing the action to take.

Available actions:
- click: { "type": "click", "x": number, "y": number }
- double_click: { "type": "double_click", "x": number, "y": number }
- type: { "type": "type", "text": string }
- key: { "type": "key", "key": string } (e.g., "Enter", "Tab", "Escape")
- scroll: { "type": "scroll", "x": number, "y": number, "direction": "up" | "down", "amount": number }
- wait: { "type": "wait", "ms": number }
- done: { "type": "done", "success": boolean, "reason": string }

Respond with a JSON object with two fields:
- "action": the action object
- "reasoning": a brief explanation of why you're taking this action

IMPORTANT:
- Coordinates should be within the viewport (${viewport.width}x${viewport.height})
- Click on elements that are visible and interactive
- When the test is complete, use the done action with success: true
- If you cannot complete the test, use done with success: false`;

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
              text: "What action should I take next to complete the test? Respond with JSON.",
            },
          ],
        },
      ],
    });

    return this.parseResponse(response);
  }

  private parseResponse(
    response: OpenAI.Chat.Completions.ChatCompletion
  ): GetNextActionResult {
    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        action: { type: "done", success: false, reason: "No response from AI" },
        reasoning: "No response from AI",
      };
    }

    try {
      const parsed = JSON.parse(content) as {
        action: Action;
        reasoning: string;
      };
      return {
        action: this.validateAction(parsed.action),
        reasoning: parsed.reasoning || "No reasoning provided",
      };
    } catch {
      return {
        action: {
          type: "done",
          success: false,
          reason: `Failed to parse response: ${content}`,
        },
        reasoning: "Failed to parse AI response",
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
}
