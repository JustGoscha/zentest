# Zentest Architecture & Implementation Decisions

This document summarizes the architectural decisions and implementation details for the Zentest agentic testing framework.

## Overview

Zentest is an AI-powered end-to-end testing framework that uses vision-capable AI models to navigate web applications and generate Playwright tests from natural language descriptions.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AgenticTester                           │
│  (orchestrates the test loop)                               │
└───────────────────────────┬─────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌─────────────────┐  ┌───────────────────┐
│ BrowserExecutor│  │ ComputerUse     │  │ TestBuilder       │
│ (Playwright)   │  │ Provider        │  │ (records actions) │
└───────────────┘  └────────┬────────┘  └───────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      ┌──────────┐   ┌──────────┐   ┌──────────────┐
      │ Anthropic│   │ OpenAI   │   │ OpenRouter   │
      │ Adapter  │   │ Adapter  │   │ Adapter      │
      └──────────┘   └──────────┘   └──────────────┘
```

## Key Design Decisions

### 1. Provider Abstraction Layer

**Decision**: Abstract AI provider interface (`ComputerUseProvider`) that works with multiple backends.

**Rationale**: Users should be able to switch between AI providers without code changes.

**Implementation**:
- `src/providers/base.ts` - Abstract interface
- `src/providers/anthropic.ts` - Uses Anthropic's beta computer use API
- `src/providers/openai.ts` - Uses vision + JSON structured output
- `src/providers/openrouter.ts` - OpenAI-compatible API routing to various models

```typescript
interface ComputerUseProvider {
  readonly name: string;
  getNextAction(params: GetNextActionParams): Promise<GetNextActionResult>;
}
```

### 2. Three-Model Configuration

**Decision**: Separate model configurations for different components.

**Rationale**: Different tasks have different requirements:
- **Agentic model**: Requires multimodal/vision for screenshot analysis
- **Builder model**: Only generates code, no vision needed (can use cheaper models)
- **Healer model**: Re-runs failed tests, requires multimodal/vision

**Implementation**:
```typescript
interface ModelConfig {
  agenticModel: string;  // e.g., claude-sonnet-4-20250514
  builderModel: string;  // e.g., claude-haiku-3-5-20241022
  healerModel: string;   // e.g., claude-sonnet-4-20250514
}
```

### 3. Environment Variable Configuration

**Decision**: All configuration via `ZENTEST_*` prefixed environment variables.

**Rationale**:
- Clear namespace avoids conflicts
- Standard `.env` file support
- Easy CI/CD integration

**Variables**:
```
ZENTEST_ANTHROPIC_API_KEY    # Anthropic API key
ZENTEST_OPENAI_API_KEY       # OpenAI API key
ZENTEST_OPENROUTER_API_KEY   # OpenRouter API key
ZENTEST_PROVIDER             # anthropic | openai | openrouter
ZENTEST_AGENTIC_MODEL        # Model for agentic tester
ZENTEST_BUILDER_MODEL        # Model for test builder
ZENTEST_HEALER_MODEL         # Model for test healer
ZENTEST_VIEWPORT_WIDTH       # Browser viewport width
ZENTEST_VIEWPORT_HEIGHT      # Browser viewport height
ZENTEST_HEADLESS             # auto | true | false
ZENTEST_MAX_STEPS            # Max steps before timeout
```

### 4. Automatic dotenv Loading

**Decision**: Auto-load `.env` from current working directory on CLI startup.

**Implementation** (`src/cli.ts`):
```typescript
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  loadEnv({ path: envPath });
}
```

### 5. Headless Mode Auto-Detection

**Decision**: Default to "auto" which detects CI vs interactive mode.

**Rationale**:
- CI environments should run headless
- Local development benefits from visible browser

**Implementation**:
```typescript
function shouldRunHeadless(config: ZentestConfig): boolean {
  if (config.headless === "auto") {
    return !process.stdout.isTTY || !!process.env.CI;
  }
  return config.headless;
}
```

### 6. Coordinate-to-Selector Conversion

**Decision**: Convert AI's coordinate-based clicks to semantic Playwright selectors.

**Rationale**: Generated tests should be maintainable and resilient to layout changes.

**Selector Priority** (highest to lowest):
1. `data-testid` → `page.getByTestId()`
2. `role` + accessible name → `page.getByRole()`
3. `placeholder` → `page.getByPlaceholder()`
4. `aria-label` → `page.getByLabel()`
5. Link text → `page.getByRole('link', { name })`
6. Button text → `page.getByRole('button', { name })`
7. Fallback to CSS selector

**Implementation**: `src/agents/testBuilder.ts` - `toSemanticSelector()` and `buildBestSelector()`

### 7. Action Type System

**Decision**: Strongly typed action definitions shared across all providers.

**Implementation** (`src/types/actions.ts`):
```typescript
type Action =
  | MouseAction      // click, double_click, mouse_move, etc.
  | KeyboardAction   // type, key
  | ScrollAction     // scroll with direction
  | ControlAction;   // screenshot, wait, done
```

### 8. Element Info Capture

**Decision**: Capture rich element information at click coordinates for selector generation.

**Implementation**: `BrowserExecutor.getElementAtPoint()` uses `document.elementFromPoint()` to capture:
- Tag name, text content, id, className
- ARIA attributes (role, label)
- Form attributes (placeholder, name)
- Link href

### 9. Test Recording and Replay Flow

**Flow**:
1. **First run (no static test exists)**: Run agentic test → generate Playwright test on success
2. **Subsequent runs**: Run static Playwright test first
3. **`--agentic` flag**: Force agentic mode, regenerate static test
4. **Test failure**: Healer re-runs with vision to diagnose changes

### 10. Anthropic Computer Use Integration

**Decision**: Use Anthropic's beta computer use API for Claude models.

**Implementation** (`src/providers/anthropic.ts`):
```typescript
const response = await this.client.beta.messages.create({
  model: this.model,
  tools: [{
    type: "computer_20250124",
    name: "computer",
    display_width_px: viewport.width,
    display_height_px: viewport.height,
    display_number: 1,
  }],
  betas: ["computer-use-2025-01-24"],
  // ...
});
```

## File Structure

```
src/
├── types/
│   └── actions.ts          # Action type definitions
├── browser/
│   ├── executor.ts         # Playwright action execution
│   └── screenshot.ts       # Screenshot utilities
├── providers/
│   ├── base.ts             # Provider interface
│   ├── anthropic.ts        # Claude adapter
│   ├── openai.ts           # GPT-4 adapter
│   ├── openrouter.ts       # OpenRouter adapter
│   └── index.ts            # Provider factory
├── agents/
│   ├── agenticTester.ts    # Main AI test loop
│   ├── testBuilder.ts      # Playwright code generation
│   └── testHealer.ts       # Failed test diagnosis
├── config/
│   └── loader.ts           # Config loading + env overrides
├── commands/
│   ├── init.ts             # Project initialization
│   └── run.ts              # Test execution
└── cli.ts                  # CLI entry point
```

## Dependencies

- `@anthropic-ai/sdk` - Anthropic API client
- `openai` - OpenAI API client
- `playwright` - Browser automation
- `dotenv` - Environment variable loading
- `commander` - CLI framework

## Configuration Example

```javascript
// zentest.config.js
export default {
  baseUrl: "https://example.com",
  environments: {
    production: { url: "https://example.com" },
    dev: { url: "https://dev.example.com" },
  },
  provider: "anthropic",
  models: {
    agenticModel: "claude-sonnet-4-20250514",
    builderModel: "claude-haiku-3-5-20241022",
    healerModel: "claude-sonnet-4-20250514",
  },
  maxSteps: 50,
  viewport: { width: 1280, height: 720 },
  headless: "auto",
}
```
