// Structured logs (docs/wave9-plan.md step 9b.5): with LOG_FORMAT=json each line is one JSON object — time, level,
// context, message, and the request reference when there is one — so a log collector can search by reference
// (the one a person quotes from the error dialog) without parsing free text. Nothing secret is logged here.
import type { LoggerService, LogLevel } from '@nestjs/common';

export class JsonLogger implements LoggerService {
  constructor(
    private readonly out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
  ) {}

  private write(level: LogLevel, message: unknown, rest: unknown[]) {
    const args = [...rest];
    // Nest passes the context last, and a stack before it for errors.
    const context = typeof args.at(-1) === 'string' ? (args.pop() as string) : undefined;
    const stack =
      typeof args.at(-1) === 'string' && level === 'error' ? (args.pop() as string) : undefined;
    const msg =
      message instanceof Error
        ? message.message
        : typeof message === 'string'
          ? message
          : JSON.stringify(message);
    const ref = /^([A-HJ-NP-Z2-9]{10}) /.exec(msg)?.[1];
    this.out(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        ...(context ? { context } : {}),
        msg,
        ...(ref ? { ref } : {}),
        ...(stack
          ? { stack }
          : message instanceof Error && message.stack
            ? { stack: message.stack }
            : {}),
      }),
    );
  }

  log(message: unknown, ...rest: unknown[]) {
    this.write('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }
}
