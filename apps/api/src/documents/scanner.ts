// Virus scanning of uploads (docs/04-features.md P8): the hook every upload passes through, and one scanner for it,
// ClamAV's daemon (free, run as its own service; we only talk to it over its socket protocol). Without a scanner
// configured, files are kept and marked "not scanned". A file the scanner finds infected is refused. When the scanner
// cannot answer (down, timed out, or the file is over its size limit), the file is kept and marked "not scanned"
// rather than blocking the tender team; the reason is logged.
import { createReadStream } from 'node:fs';
import { connect } from 'node:net';
import { once } from 'node:events';

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'not_scanned'; reason: string };

/** clamd's INSTREAM command: the file in length-prefixed chunks, then a zero length; the reply ends in OK or FOUND. */
export function clamdScan(
  path: string,
  opts: { host: string; port: number; timeoutMs: number },
): Promise<ScanResult> {
  return new Promise((resolve) => {
    const socket = connect(opts.port, opts.host);
    let reply = '';
    let settled = false;
    const finish = (fallback: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(parseReply(reply, fallback));
    };
    socket.setTimeout(opts.timeoutMs, () => finish('the scanner did not answer in time'));
    socket.on('error', (err) => finish(`the scanner could not be reached (${err.message})`));
    socket.on('data', (d: Buffer) => {
      reply += d.toString('utf8');
      if (reply.includes('\0')) finish('no answer');
    });
    socket.on('end', () => finish('the scanner closed the connection'));
    socket.on('connect', () => {
      void (async () => {
        try {
          socket.write('zINSTREAM\0');
          for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
            if (settled) return;
            const len = Buffer.alloc(4);
            len.writeUInt32BE((chunk as Buffer).length);
            if (!socket.write(Buffer.concat([len, chunk as Buffer])))
              await Promise.race([once(socket, 'drain'), once(socket, 'close')]);
          }
          socket.write(Buffer.alloc(4));
        } catch (err) {
          finish(`the file could not be sent to the scanner (${(err as Error).message})`);
        }
      })();
    });
  });
}

export function parseReply(raw: string, fallback: string): ScanResult {
  const reply = raw.replace(/\0/g, '').trim();
  if (/:\s*OK$/.test(reply)) return { status: 'clean' };
  const found = /:\s*(.+)\s+FOUND$/.exec(reply);
  if (found) return { status: 'infected', signature: found[1]!.trim() };
  return { status: 'not_scanned', reason: reply ? `the scanner said: ${reply}` : fallback };
}
