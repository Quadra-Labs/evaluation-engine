/**
 * log.ts — structured, level-gated logging for a workload that must not leak what it decrypts.
 *
 * The one rule this module exists to enforce: a confidential workload's logs are not private. They
 * go to the container's stdout, which the operator reads. The whole product claim is that the
 * operator cannot see a buyer's result, so a stray `console.log(submission)` would refute it more
 * completely than any missing feature. Nothing here formats an arbitrary object; callers pass
 * scalar fields they have chosen deliberately.
 *
 * The Sui engine used `tracing_subscriber` with RUST_LOG. This is the same idea with no dependency:
 * four levels, one env var, JSON lines so a log shipper can parse them.
 */

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LEVELS)[number];

/** Scalars only, on purpose. See the header: no object ever reaches a log line by accident. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

function configuredLevel(): number {
    const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
    const found = LEVELS.indexOf(raw as LogLevel);
    return found === -1 ? LEVELS.indexOf('info') : found;
}

const threshold = configuredLevel();

function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVELS.indexOf(level) > threshold) return;
    const line: Record<string, unknown> = { level, msg: message };
    if (fields) {
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined) line[key] = value;
        }
    }
    const text = JSON.stringify(line);
    if (level === 'error' || level === 'warn') process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
}

export const log = {
    error: (message: string, fields?: LogFields) => emit('error', message, fields),
    warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
    info: (message: string, fields?: LogFields) => emit('info', message, fields),
    debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
};

/**
 * The message of an unknown thrown value, for a log field or an error response.
 *
 * Never the stack: a stack trace from inside the enclave names file paths and line numbers of the
 * measured image, which is free reconnaissance for anyone probing it.
 */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}
