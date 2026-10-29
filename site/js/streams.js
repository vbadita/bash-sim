// Byte-ish streams between commands: pipes with backpressure, file and string
// readers, collecting writers. All reads and writes are async so pipelines run
// concurrently (yes | head -3 terminates the producer with EPIPE).

export class EPIPE extends Error {
  constructor() {
    super('Broken pipe');
    this.code = 'EPIPE';
  }
}

export class Reader {
  constructor() {
    this.buf = '';
    this.eof = false;
  }
  async _pull() {
    return null;
  }
  async fill() {
    if (this.eof) return false;
    const c = await this._pull();
    if (c === null || c === undefined) {
      this.eof = true;
      return false;
    }
    this.buf += c;
    return true;
  }
  // a line without its trailing newline; {line, nl} so callers can tell a final
  // unterminated line apart; null at EOF
  async readLineRaw() {
    for (;;) {
      const i = this.buf.indexOf('\n');
      if (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        return { line, nl: true };
      }
      if (!(await this.fill())) {
        if (this.buf === '') return null;
        const line = this.buf;
        this.buf = '';
        return { line, nl: false };
      }
    }
  }
  async readLine() {
    const r = await this.readLineRaw();
    return r ? r.line : null;
  }
  async readUntil(delim) {
    for (;;) {
      const i = this.buf.indexOf(delim);
      if (i >= 0) {
        const s = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + delim.length);
        return { line: s, nl: true };
      }
      if (!(await this.fill())) {
        if (this.buf === '') return null;
        const s = this.buf;
        this.buf = '';
        return { line: s, nl: false };
      }
    }
  }
  async readChars(n) {
    while (this.buf.length < n && (await this.fill()));
    const s = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return s;
  }
  async readAll() {
    while (await this.fill());
    const s = this.buf;
    this.buf = '';
    return s;
  }
  async *lines() {
    for (;;) {
      const l = await this.readLine();
      if (l === null) return;
      yield l;
    }
  }
  // returns available chunk (or null at EOF) without waiting for a full line
  async read() {
    if (this.buf) {
      const s = this.buf;
      this.buf = '';
      return s;
    }
    if (!(await this.fill())) return null;
    const s = this.buf;
    this.buf = '';
    return s;
  }
  close() {}
}

export class StringReader extends Reader {
  constructor(s) {
    super();
    this.buf = s;
    this.eof = true;
  }
}

export class EmptyReader extends Reader {
  constructor() {
    super();
    this.eof = true;
  }
}

// reads lazily from a function returning a string (device files)
export class FnReader extends Reader {
  constructor(fn) {
    super();
    this.fn = fn;
  }
  async _pull() {
    return this.fn();
  }
}

export class Writer {
  async write() {}
  close() {}
}

export class NullWriter extends Writer {
  async write() {}
}

export class CollectWriter extends Writer {
  constructor(limit = 64 * 1024 * 1024) {
    super();
    this.parts = [];
    this.size = 0;
    this.limit = limit;
  }
  async write(s) {
    this.size += s.length;
    if (this.size > this.limit) throw new Error('output too large');
    this.parts.push(s);
  }
  get text() {
    return this.parts.join('');
  }
}

export class FnWriter extends Writer {
  constructor(fn) {
    super();
    this.fn = fn;
  }
  async write(s) {
    await this.fn(s);
  }
}

const HIGH_WATER = 64 * 1024;

export class Pipe {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.writeClosed = false;
    this.readClosed = false;
    this.waitR = null;
    this.waitW = null;
    this.writers = 0;
    const pipe = this;
    this.reader = new (class extends Reader {
      async _pull() {
        return pipe._read();
      }
      close() {
        pipe.closeRead();
      }
    })();
    this.writer = new (class extends Writer {
      async write(s) {
        return pipe._write(s);
      }
      close() {
        pipe.closeWrite();
      }
    })();
  }
  async _write(s) {
    if (this.readClosed) throw new EPIPE();
    if (!s) return;
    this.chunks.push(s);
    this.size += s.length;
    if (this.waitR) {
      const w = this.waitR;
      this.waitR = null;
      w();
    }
    while (this.size > HIGH_WATER && !this.readClosed) {
      await new Promise((r) => (this.waitW = r));
    }
    if (this.readClosed) throw new EPIPE();
  }
  async _read() {
    for (;;) {
      if (this.chunks.length) {
        const s = this.chunks.join('');
        this.chunks = [];
        this.size = 0;
        if (this.waitW) {
          const w = this.waitW;
          this.waitW = null;
          w();
        }
        return s;
      }
      if (this.writeClosed) return null;
      await new Promise((r) => (this.waitR = r));
    }
  }
  closeWrite() {
    this.writeClosed = true;
    if (this.waitR) {
      const w = this.waitR;
      this.waitR = null;
      w();
    }
  }
  closeRead() {
    this.readClosed = true;
    this.chunks = [];
    this.size = 0;
    if (this.waitW) {
      const w = this.waitW;
      this.waitW = null;
      w();
    }
  }
}
