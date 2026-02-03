import Anthropic from "@anthropic-ai/sdk";
import {
  ComputerUseProvider,
  GetNextActionParams,
  GetNextActionResult,
} from "./base.js";
import { Action } from "../types/actions.js";
import { buildSystemPrompt } from "./systemPrompt.js";

/**
 * Claude provider using native Anthropic SDK
 */
export class AnthropicProvider implements ComputerUseProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model: string = "claude-sonnet-4-20250514") {
    const key = apiKey || process.env.ZENTEST_ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "Anthropic API key required. Set ZENTEST_ANTHROPIC_API_KEY or pass apiKey in config."
      );
    }
    this.client = new Anthropic({ apiKey: key });
    this.model = model;
  }

  async getNextAction(params: GetNextActionParams): Promise<GetNextActionResult> {
    const { screenshot, testDescription, actionHistory, viewport } = params;

    const systemPrompt = buildSystemPrompt({
      testDescription,
      actionHistory,
      viewport,
      mode: "json",
    });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshot.toString("base64"),
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

  private parseResponse(response: Anthropic.Messages.Message): GetNextActionResult {
    const textBlock = response.content.find(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text"
    );
    const content = textBlock?.text;
    if (!content) {
      return {
        actions: [{ type: "done", success: false, reason: "No response from AI" }],
        reasoning: "No response from AI",
      };
    }

    try {
      const parsed = JSON.parse(content) as {
        actions?: Action[];
        reasoning?: string;
      };
      const reasoning = parsed.reasoning || "No reasoning provided";
      if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
        return {
          actions: parsed.actions.map((action) => this.validateAction(action)),
          reasoning,
        };
      }
      return {
        actions: [{ type: "done", success: false, reason: "No actions returned" }],
        reasoning,
      };
    } catch {
      return {
        actions: [
          {
            type: "done",
            success: false,
            reason: `Failed to parse response: ${content}`,
          },
        ],
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

      case "click_button":
        return {
          type: "click_button",
          name: String(a.name || ""),
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
