import { StringDecoder } from 'node:string_decoder';
/** Drain all bytes, retaining at most one bounded line even without newlines. */
export class BoundedLogStream {
  #buffer = ''; #bytes = 0; #discard = false; #decoder = new StringDecoder('utf8');
  constructor(readonly line: (value: string) => void, readonly lost: () => void) {}
  push(chunk: Buffer): void {
    for (const part of this.#decoder.write(chunk).split(/(?<=\n)/)) {
      if (!this.#discard) {
        this.#bytes += Buffer.byteLength(part);
        if (this.#bytes > 65536) { this.#discard = true; this.#buffer = ''; this.lost(); }
        else this.#buffer += part;
      }
      if (part.endsWith('\n')) {
        if (!this.#discard && this.#buffer.trim()) this.line(this.#buffer.trim());
        this.#buffer = ''; this.#bytes = 0; this.#discard = false;
      }
    }
  }
  end(): void { if (!this.#discard && this.#buffer.trim()) this.line(this.#buffer.trim()); }
}
