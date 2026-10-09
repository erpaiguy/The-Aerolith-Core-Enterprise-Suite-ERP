// The part of archiver (MIT, already installed with exceljs) used to stream ZIP downloads. It ships no types; a
// declaration of the few calls used here avoids another dependency.
declare module 'archiver' {
  import type { Readable, Transform } from 'node:stream';

  interface Archiver extends Transform {
    append(source: Readable | Buffer | string, data: { name: string; date?: Date }): this;
    finalize(): Promise<void>;
    abort(): this;
    pointer(): number;
    on(event: 'entry', listener: (entry: { name: string }) => void): this;
    on(event: 'warning' | 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  function archiver(
    format: 'zip',
    options?: { zlib?: { level?: number }; store?: boolean; forceZip64?: boolean },
  ): Archiver;

  export default archiver;
}
