import chalk from "chalk";
import ora, { type Ora } from "ora";

const SPINNER = { frames: ["◐", "◓", "◑", "◒"], interval: 120 };

export const color = {
  bold: (text: string) => chalk.bold(text),
  dim: (text: string) => chalk.dim(text),
  red: (text: string) => chalk.red(text),
  green: (text: string) => chalk.green(text),
  yellow: (text: string) => chalk.yellow(text),
  blue: (text: string) => chalk.blue(text),
  magenta: (text: string) => chalk.magenta(text),
  cyan: (text: string) => chalk.cyan(text),
  gray: (text: string) => chalk.gray(text),
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
    color.bold("zentest v0.2.0"),
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

  const spinner: Ora = ora({
    spinner: SPINNER,
    indent: 4,
    stream: process.stdout,
    color: "gray",
  });

  return {
    thinking(step) {
      spinner.text = chalk.dim(`Step ${step}/${maxSteps} · thinking...`);
      if (!spinner.isSpinning) spinner.start();
    },
    executing(step, action) {
      spinner.text = chalk.dim(`Step ${step}/${maxSteps} · ${truncate(action, 40)}`);
      if (!spinner.isSpinning) spinner.start();
    },
    reasoning(text) {
      const short = text.replace(/\s+/g, " ").trim();
      const display = short.length > 80 ? short.slice(0, 79) + "…" : short;
      spinner.text = chalk.dim(`💭 ${display}`);
      if (!spinner.isSpinning) spinner.start();
    },
    clear() {
      spinner.stop();
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

  const spinner: Ora = ora({
    text: message,
    spinner: SPINNER,
    indent: level * 2,
    stream: process.stdout,
    color: "gray",
  }).start();

  return {
    update: (msg: string) => { spinner.text = msg; },
    stop: (finalMessage?: string) => {
      spinner.stop();
      if (finalMessage) {
        logLine(level, finalMessage);
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
