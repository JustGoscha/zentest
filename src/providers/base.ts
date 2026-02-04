import { Action, ActionHistoryEntry } from "../types/actions.js";

/**
 * Parameters for getting the next action from AI
 */
export interface GetNextActionParams {
  /** Current screenshot of the page */
  screenshot: Buffer;
  /** The test description in plain English */
  testDescription: string;
  /** History of actions taken so far */
  actionHistory: ActionHistoryEntry[];
  /** Current viewport dimensions */
  viewport: { width: number; height: number };
  /** Optional context for last failed instruction */
  lastFailureText?: string;
}

/**
 * Result from the AI provider
 */
export interface GetNextActionResult {
  /** Optional batch of actions to execute in order */
  actions: Action[];
  /** The AI's reasoning for this action */
  reasoning: string;
  /** Raw response text from the provider (verbatim) */
  rawResponse?: string;
}

/**
 * Abstract interface for computer use providers
 */
export interface ComputerUseProvider {
  /** Provider name for logging */
  readonly name: string;

  /**
   * Get the next action based on current state
   */
  getNextAction(params: GetNextActionParams): Promise<GetNextActionResult>;
}

/**
 * Supported provider types
 */
export type ProviderType = "anthropic" | "openai" | "openrouter";

/**
 * Provider configuration
 */
export interface ProviderConfig {
  provider: ProviderType;
  model: string;
  apiKey?: string;
}
