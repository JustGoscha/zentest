const supportsColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== "1";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const applyColor = (text: string, c: string) =>
  supportsColor ? `${c}${text}${ansi.reset}` : text;

export const color = {
  bold: (text: string) => applyColor(text, ansi.bold),
  dim: (text: string) => applyColor(text, ansi.dim),
  red: (text: string) => applyColor(text, ansi.red),
  green: (text: string) => applyColor(text, ansi.green),
  yellow: (text: string) => applyColor(text, ansi.yellow),
  blue: (text: string) => applyColor(text, ansi.blue),
  magenta: (text: string) => applyColor(text, ansi.magenta),
  cyan: (text: string) => applyColor(text, ansi.cyan),
  gray: (text: string) => applyColor(text, ansi.gray),
};

export const sym = {
  pass: "✓",
  fail: "✗",
  bullet: "●",
  arrow: "→",
  dash: "─",
  warn: "⚠",
  info: "ℹ",
};

// ─── Basic output ────────────────────────────────

export const indent = (level: number) => "  ".repeat(level);

export const logLine = (level: number, message: string) => {
  console.log(`${indent(level)}${message}`);
};

export const logBlank = () => {
  console.log("");
};

// ─── Formatting helpers ─────────────────────────

const TERM_WIDTH = Math.min(process.stdout.columns || 56, 56);

export const formatHeader = (
  url: string,
  provider: string,
  mode: string,
  browser: string
): string[] => {
  return [
    color.bold("zentest v0.1.0"),
    color.dim(`${url} · ${provider} · ${mode} · ${browser}`),
  ];
};

export const formatSuiteBar = (name: string): string => {
  const label = ` ${name} `;
  const remaining = Math.max(0, TERM_WIDTH - label.length - 2);
  const line = sym.dash.repeat(remaining);
  return color.cyan(`${sym.dash}${sym.dash}${label}${line}`);
};

export const formatTestName = (name: string): string => {
  return `${color.blue(sym.bullet)} ${color.bold(name)}`;
};

export const formatAction = (index: number, summary: string): string => {
  const num = String(index).padStart(2, " ");
  return `${color.dim(num)}  ${summary}`;
};

export const formatTestResult = (
  passed: boolean,
  reason: string | undefined,
  durationMs: number,
  actionCount: number
): string => {
  const icon = passed ? color.green(sym.pass) : color.red(sym.fail);
  const label = passed
    ? color.green("passed")
    : color.red(`failed${reason ? `: ${reason}` : ""}`);
  const time = color.dim(formatDuration(durationMs));
  const actions = color.dim(`${actionCount} actions`);
  return `${icon} ${label}  ${time} · ${actions}`;
};

// ─── Summary table ──────────────────────────────

export interface TestSummaryRow {
  name: string;
  passed: boolean;
  durationMs: number;
  actionCount: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export const printSummaryTable = (
  rows: TestSummaryRow[],
  totalDurationMs: number,
  tokens?: TokenTotals
): void => {
  logBlank();
  logLine(0, formatSuiteBar("Results"));
  logBlank();

  // Column widths
  const nameWidth = Math.max(22, ...rows.map((r) => r.name.length)) + 2;

  // Header
  const header =
    "  " +
    "Test".padEnd(nameWidth) +
    "Result".padEnd(10) +
    "Time".padStart(8) +
    "Actions".padStart(9);
  logLine(0, color.dim(header));
  logLine(0, color.dim("  " + sym.dash.repeat(nameWidth + 10 + 8 + 9)));

  // Rows
  let totalPassed = 0;
  let totalActions = 0;

  for (const row of rows) {
    if (row.passed) totalPassed++;
    totalActions += row.actionCount;

    const icon = row.passed ? color.green(sym.pass) : color.red(sym.fail);
    const resultWord = row.passed ? "pass" : "fail";
    const resultText = row.passed ? color.green(resultWord) : color.red(resultWord);

    logLine(
      0,
      "  " +
        row.name.padEnd(nameWidth) +
        `${icon} ${resultText}` +
        " ".repeat(Math.max(0, 6 - resultWord.length)) +
        formatDuration(row.durationMs).padStart(8) +
        String(row.actionCount).padStart(9)
    );
  }

  // Footer
  logLine(0, color.dim("  " + sym.dash.repeat(nameWidth + 10 + 8 + 9)));

  const passedCount = totalPassed;
  const totalCount = rows.length;
  const allPassed = passedCount === totalCount;
  const passText = allPassed
    ? color.green(`${passedCount}/${totalCount}`)
    : color.yellow(`${passedCount}/${totalCount}`);

  logLine(
    0,
    "  " +
      "".padEnd(nameWidth) +
      passText +
      " ".repeat(Math.max(0, 10 - `${passedCount}/${totalCount}`.length)) +
      formatDuration(totalDurationMs).padStart(8) +
      String(totalActions).padStart(9)
  );

  logBlank();

  // Tokens
  if (tokens && tokens.totalTokens > 0) {
    const parts: string[] = [];
    if (tokens.inputTokens > 0) parts.push(`${formatNumber(tokens.inputTokens)} in`);
    if (tokens.outputTokens > 0) parts.push(`${formatNumber(tokens.outputTokens)} out`);
    parts.push(`${formatNumber(tokens.totalTokens)} total`);
    logLine(1, color.dim(`Tokens: ${parts.join(" · ")}`));
  }
};

// ─── Progress tracker ───────────────────────────

export interface ProgressHandle {
  thinking(step: number): void;
  executing(step: number, action: string): void;
  reasoning(text: string): void;
  clear(): void;
}

export const startProgress = (maxSteps: number): ProgressHandle => {
  const spinnerFrames = ["◐", "◓", "◑", "◒"];
  let frameIdx = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastLen = 0;
  let currentText = "";
  const prefix = indent(2);

  const render = () => {
    const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
    const text = `${prefix}${color.dim(frame)} ${currentText}`;
    const plainLen = stripAnsi(text).length;
    const padded = text + " ".repeat(Math.max(0, lastLen - plainLen));
    lastLen = Math.max(lastLen, plainLen);
    process.stdout.write(`\r${padded}`);
  };

  const startTimer = () => {
    if (!timer && process.stdout.isTTY) {
      timer = setInterval(render, 120);
    }
  };

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  if (!process.stdout.isTTY) {
    return {
      thinking(step) {
        logLine(2, color.dim(`Step ${step}/${maxSteps} · thinking...`));
      },
      executing(step, action) {
        logLine(2, color.dim(`Step ${step}/${maxSteps} · ${action}`));
      },
      reasoning(text) {
        const short = text.replace(/\s+/g, " ").trim();
        const display = short.length > 80 ? short.slice(0, 79) + "…" : short;
        logLine(2, color.dim(`💭 ${display}`));
      },
      clear() {},
    };
  }

  return {
    thinking(step) {
      currentText = color.dim(`Step ${step}/${maxSteps} · thinking...`);
      startTimer();
      render();
    },
    executing(step, action) {
      currentText = color.dim(`Step ${step}/${maxSteps} · ${truncate(action, 40)}`);
      render();
    },
    reasoning(text) {
      const short = text.replace(/\s+/g, " ").trim();
      const display = short.length > 80 ? short.slice(0, 79) + "…" : short;
      currentText = color.dim(`💭 ${display}`);
      startTimer();
      render();
    },
    clear() {
      stopTimer();
      if (process.stdout.clearLine) process.stdout.clearLine(0);
      if (process.stdout.cursorTo) process.stdout.cursorTo(0);
    },
  };
};

// ─── Spinner (for misc uses) ────────────────────

export type SpinnerHandle = {
  update: (message: string) => void;
  stop: (finalMessage?: string) => void;
};

export const startSpinner = (level: number, message: string): SpinnerHandle => {
  if (!process.stdout.isTTY) {
    logLine(level, `${color.dim(sym.arrow)} ${message}`);
    return {
      update: (msg: string) => logLine(level, `${color.dim(sym.arrow)} ${msg}`),
      stop: (msg?: string) => { if (msg) logLine(level, msg); },
    };
  }

  const frames = ["◐", "◓", "◑", "◒"];
  let index = 0;
  let lastLength = 0;
  let currentMessage = message;
  const pfx = indent(level);

  const render = () => {
    const frame = frames[index++ % frames.length];
    const text = `${pfx}${color.dim(frame)} ${currentMessage}`;
    const plainLen = stripAnsi(text).length;
    const padded = text + " ".repeat(Math.max(0, lastLength - plainLen));
    lastLength = Math.max(lastLength, plainLen);
    process.stdout.write(`\r${padded}`);
  };

  render();
  const timer = setInterval(render, 120);

  return {
    update: (msg: string) => { currentMessage = msg; render(); },
    stop: (finalMessage?: string) => {
      clearInterval(timer);
      if (process.stdout.clearLine) process.stdout.clearLine(0);
      if (process.stdout.cursorTo) process.stdout.cursorTo(0);
      if (finalMessage) {
        process.stdout.write(`${pfx}${finalMessage}\n`);
      }
    },
  };
};

// ─── Backward compat ────────────────────────────

export const INDENT_LEVELS = { suite: 0, test: 1, step: 2, detail: 3 };
export const symbols = { check: sym.pass, fail: sym.fail, warn: sym.warn, info: sym.info, arrow: sym.arrow, step: ">>", suite: "==" };

export const statusLabel = (kind: "check" | "fail" | "warn" | "info") => {
  if (kind === "check") return color.green(sym.pass);
  if (kind === "fail") return color.red(sym.fail);
  if (kind === "warn") return color.yellow(sym.warn);
  return color.cyan(sym.info);
};

export const formatSuiteHeader = (name: string) => formatSuiteBar(name);
export const formatTestHeader = (name: string) => formatTestName(name);

// ─── Utilities ──────────────────────────────────

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
};

const formatNumber = (n: number): string => n.toLocaleString("en-US");

const truncate = (str: string, max: number): string => {
  const clean = str.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
};

const stripAnsi = (str: string): string => str.replace(/\x1b\[\d+m/g, "");
