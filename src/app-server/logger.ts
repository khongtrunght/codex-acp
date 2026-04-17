const prefix = "[codex-acp]";

function format(level: string, message: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return `${prefix} ${level} ${message}`;
  }
  return `${prefix} ${level} ${message} ${safeStringify(meta)}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, replaceErrors);
  } catch {
    return String(value);
  }
}

function replaceErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    process.stderr.write(`${format("debug", message, meta)}\n`);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    process.stderr.write(`${format("info", message, meta)}\n`);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    process.stderr.write(`${format("warn", message, meta)}\n`);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    process.stderr.write(`${format("error", message, meta)}\n`);
  },
} as const;
