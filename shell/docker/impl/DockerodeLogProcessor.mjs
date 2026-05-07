const NOOP = () => {};

function asPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/**
 * Docker multiplexed frame decoder (stdout/stderr) for non-TTY containers.
 * Frame: [streamType:1][0][0][0][size:uint32BE][payload...]
 * streamType: 1=stdout, 2=stderr.
 */
class DockerMuxDecoder {
  #buf = Buffer.alloc(0);
  #maxBufferBytes;

  constructor({ maxBufferBytes = 8 << 20 } = {}) {
    this.#maxBufferBytes = asPositiveInt(maxBufferBytes, 8 << 20);
  }

  push(chunk) {
    if (chunk?.length) this.#buf = Buffer.concat([this.#buf, chunk]);

    if (this.#maxBufferBytes > 0 && this.#buf.length > this.#maxBufferBytes) {
      throw new Error(`Docker log mux buffer exceeded ${this.#maxBufferBytes} bytes`);
    }

    const frames = [];
    while (this.#buf.length >= 8) {
      const streamType = this.#buf[0];
      const size = this.#buf.readUInt32BE(4);
      const frameLen = 8 + size;
      if (this.#buf.length < frameLen) break;

      const payload = this.#buf.subarray(8, frameLen);
      frames.push({
        stream: streamType === 2 ? 'stderr' : 'stdout',
        payload
      });

      this.#buf = this.#buf.subarray(frameLen);
    }
    return frames;
  }
}

/**
 * Newline splitter that retains only the undispatched tail fragment.
 * Memory remains bounded unless a producer emits extremely long text without '\n'.
 */
class LineSplitter {
  #partial = '';
  #maxPartialBytes;

  constructor({ maxPartialBytes = 1 << 20 } = {}) {
    this.#maxPartialBytes = asPositiveInt(maxPartialBytes, 1 << 20);
  }

  pushText(text) {
    if (!text) return { lines: [], forcedPartial: null };

    const combined = this.#partial + text;
    const parts = combined.split('\n');
    this.#partial = parts.pop() ?? '';

    const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

    if (this.#maxPartialBytes > 0 && Buffer.byteLength(this.#partial, 'utf8') > this.#maxPartialBytes) {
      const forced = this.#partial.endsWith('\r') ? this.#partial.slice(0, -1) : this.#partial;
      this.#partial = '';
      return { lines, forcedPartial: forced };
    }

    return { lines, forcedPartial: null };
  }

  flushPartial() {
    if (!this.#partial) return null;
    const out = this.#partial.endsWith('\r') ? this.#partial.slice(0, -1) : this.#partial;
    this.#partial = '';
    return out;
  }
}

/**
 * @typedef {Object} LogLineEvent
 * @property {'stdout'|'stderr'} stream
 * @property {string} line
 * @property {boolean=} partial
 */

class DockerLogDecoder {
  #isTty;
  #mux;
  #splitters;

  constructor({ isTty, maxPartialBytes, maxMuxBufferBytes } = {}) {
    this.#isTty = Boolean(isTty);
    this.#mux = this.#isTty ? null : new DockerMuxDecoder({ maxBufferBytes: maxMuxBufferBytes });
    this.#splitters = this.#isTty
      ? { stdout: new LineSplitter({ maxPartialBytes }) }
      : {
          stdout: new LineSplitter({ maxPartialBytes }),
          stderr: new LineSplitter({ maxPartialBytes })
        };
  }

  /**
   * @param {Buffer} buf
   * @returns {LogLineEvent[]}
   */
  pushBuffer(buf) {
    /** @type {LogLineEvent[]} */
    const out = [];

    if (this.#isTty) {
      const { lines, forcedPartial } = this.#splitters.stdout.pushText(buf.toString('utf8'));
      for (const line of lines) out.push({ stream: 'stdout', line });
      if (forcedPartial) out.push({ stream: 'stdout', line: forcedPartial, partial: true });
      return out;
    }

    for (const frame of this.#mux.push(buf)) {
      const { lines, forcedPartial } = this.#splitters[frame.stream].pushText(frame.payload.toString('utf8'));
      for (const line of lines) out.push({ stream: frame.stream, line });
      if (forcedPartial) out.push({ stream: frame.stream, line: forcedPartial, partial: true });
    }
    return out;
  }

  /**
   * @param {boolean} includeStderr
   * @returns {LogLineEvent[]}
   */
  flush(includeStderr) {
    /** @type {LogLineEvent[]} */
    const out = [];
    const sList = includeStderr && !this.#isTty ? ['stdout', 'stderr'] : ['stdout'];
    for (const s of sList) {
      const tail = this.#splitters[s]?.flushPartial?.();
      if (tail) out.push({ stream: s, line: tail, partial: true });
    }
    return out;
  }
}

function normalizeCallbacks(options) {
  const callbacks = options?.callbacks && typeof options.callbacks === 'object' ? options.callbacks : null;

  const onLine = typeof options?.onLine === 'function' ? options.onLine : callbacks && typeof callbacks.onLine === 'function' ? callbacks.onLine : null;
  const onError = typeof options?.onError === 'function' ? options.onError : callbacks && typeof callbacks.onError === 'function' ? callbacks.onError : NOOP;
  const onEnd = typeof options?.onEnd === 'function' ? options.onEnd : callbacks && typeof callbacks.onEnd === 'function' ? callbacks.onEnd : NOOP;

  return { onLine, onError, onEnd };
}

/**
 * Read container logs once (bounded). Uses Docker's `tail` to request the last N lines.
 *
 * @param {any} docker  Dockerode instance
 * @param {string} containerId
 * @param {Object=} options
 * @param {number=} options.maxLines       Max lines to return (also passed as Docker `tail`)
 * @param {number=} options.tailLines      Alias for maxLines
 * @param {boolean=} options.timestamps    If true, Docker prefixes timestamps into each line
 * @param {boolean=} options.includeStderr Include stderr (default true)
 * @param {AbortSignal=} options.signal
 * @param {number=} options.maxPartialBytes
 * @param {number=} options.maxMuxBufferBytes
 * @param {boolean=} options.flushPartialOnEnd
 * @returns {Promise<{mode: 'snapshot', lines: LogLineEvent[], aborted: boolean}>}
 */
export async function readContainerLogs(docker, containerId, options = {}) {
  const id = (containerId || '').trim();
  if (!id) throw new Error('containerId is required');

  const maxLines = asPositiveInt(options?.maxLines ?? options?.tailLines, 500);
  const timestamps = Boolean(options?.timestamps);
  const includeStderr = options?.includeStderr !== false;
  const flushPartialOnEnd = options?.flushPartialOnEnd !== false;
  const signal = options?.signal;

  const maxPartialBytes = asPositiveInt(options?.maxPartialBytes, 1 << 20);
  const maxMuxBufferBytes = asPositiveInt(options?.maxMuxBufferBytes, 8 << 20);

  const container = docker.getContainer(id);
  const info = await container.inspect();
  const isTty = Boolean(info?.Config?.Tty);

  const decoder = new DockerLogDecoder({ isTty, maxPartialBytes, maxMuxBufferBytes });

  const stream = await new Promise((resolve, reject) => {
    container.logs(
      {
        stdout: true,
        stderr: includeStderr,
        follow: false,
        tail: maxLines,
        timestamps
      },
      (err, s) => (err ? reject(err) : resolve(s))
    );
  });

  /** @type {LogLineEvent[]} */
  const lines = [];
  let aborted = false;
  let done = false;

  let abortListener = null;
  if (signal) {
    if (signal.aborted) {
      aborted = true;
      try { stream.destroy(); } catch { /* ignore */ }
    } else {
      abortListener = () => {
        aborted = true;
        try { stream.destroy(); } catch { /* ignore */ }
      };
      try {
        signal.addEventListener('abort', abortListener, { once: true });
      } catch {
        // ignore
      }
    }
  }

  const cleanup = () => {
    if (signal && abortListener) {
      try { signal.removeEventListener('abort', abortListener); } catch { /* ignore */ }
    }
    abortListener = null;
  };

  const finish = () => {
    if (done) return;
    done = true;
    cleanup();
  };

  return await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        for (const evt of decoder.pushBuffer(buf)) {
          if (lines.length >= maxLines) break;
          lines.push(evt);
        }
        if (lines.length >= maxLines) {
          try { stream.destroy(); } catch { /* ignore */ }
        }
      } catch (e) {
        finish();
        reject(e);
      }
    };

    const onError = (err) => {
      finish();
      reject(err);
    };

    const onEnd = () => {
      if (flushPartialOnEnd && lines.length < maxLines) {
        for (const evt of decoder.flush(includeStderr)) {
          if (lines.length >= maxLines) break;
          lines.push(evt);
        }
      }
      finish();
      resolve({ mode: 'snapshot', lines, aborted });
    };

    const onClose = () => {
      // Some streams emit 'close' without 'end' on destroy().
      onEnd();
    };

    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('end', onEnd);
    stream.on('close', onClose);
  });
}

/**
 * Follow container logs (bounded internal buffering). Uses Docker's `tail` to emit an initial burst
 * of last N lines, then follows.
 *
 * @param {any} docker  Dockerode instance
 * @param {string} containerId
 * @param {Object=} options
 * @param {number=} options.maxLines       Initial burst size (also passed as Docker `tail`)
 * @param {number=} options.tailLines      Alias for maxLines
 * @param {boolean=} options.timestamps
 * @param {boolean=} options.includeStderr
 * @param {{onLine?:(evt:LogLineEvent)=>void,onError?:(err:Error)=>void,onEnd?:()=>void}=} options.callbacks
 * @param {(evt:LogLineEvent)=>void=} options.onLine
 * @param {(err:Error)=>void=} options.onError
 * @param {()=>void=} options.onEnd
 * @param {AbortSignal=} options.signal
 * @param {number=} options.maxPartialBytes
 * @param {number=} options.maxMuxBufferBytes
 * @param {boolean=} options.flushPartialOnEnd
 * @returns {Promise<{mode:'follow', stop: ()=>void, done: Promise<void>, control: {pause: ()=>void, resume: ()=>void, isPaused: ()=>boolean}}>}
 */
export async function followContainerLogs(docker, containerId, options = {}) {
  const id = (containerId || '').trim();
  if (!id) throw new Error('containerId is required');

  const maxLines = asPositiveInt(options?.maxLines ?? options?.tailLines, 500);
  const timestamps = Boolean(options?.timestamps);
  const includeStderr = options?.includeStderr !== false;
  const flushPartialOnEnd = options?.flushPartialOnEnd !== false;
  const signal = options?.signal;

  const { onLine, onError, onEnd } = normalizeCallbacks(options);
  if (typeof onLine !== 'function') throw new Error('onLine callback is required');

  const maxPartialBytes = asPositiveInt(options?.maxPartialBytes, 1 << 20);
  const maxMuxBufferBytes = asPositiveInt(options?.maxMuxBufferBytes, 8 << 20);

  const container = docker.getContainer(id);
  const info = await container.inspect();
  const isTty = Boolean(info?.Config?.Tty);

  const decoder = new DockerLogDecoder({ isTty, maxPartialBytes, maxMuxBufferBytes });

  const stream = await new Promise((resolve, reject) => {
    container.logs(
      {
        stdout: true,
        stderr: includeStderr,
        follow: true,
        tail: maxLines,
        timestamps
      },
      (err, s) => (err ? reject(err) : resolve(s))
    );
  });

  let finished = false;
  let abortListener = null;

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const cleanup = () => {
    if (signal && abortListener) {
      try { signal.removeEventListener('abort', abortListener); } catch { /* ignore */ }
    }
    abortListener = null;
    try { stream.removeAllListeners('data'); } catch { /* ignore */ }
    try { stream.removeAllListeners('error'); } catch { /* ignore */ }
    try { stream.removeAllListeners('end'); } catch { /* ignore */ }
    try { stream.removeAllListeners('close'); } catch { /* ignore */ }
  };

  const finish = () => {
    if (finished) return;
    finished = true;

    if (flushPartialOnEnd) {
      try {
        for (const evt of decoder.flush(includeStderr)) {
          onLine(evt);
        }
      } catch (e) {
        try { onError(e); } catch { /* ignore */ }
      }
    }

    try { onEnd(); } catch { /* ignore */ }
    cleanup();
    resolveDone();
  };

  const stop = () => {
    if (finished) return;
    try { stream.destroy(); } catch { /* ignore */ }
    // Ensure done resolves even if 'end' is not emitted after destroy().
    finish();
  };

  if (signal) {
    if (signal.aborted) stop();
    else {
      abortListener = () => stop();
      try {
        signal.addEventListener('abort', abortListener, { once: true });
      } catch {
        // ignore
      }
    }
  }

  stream.on('data', (chunk) => {
    try {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const evt of decoder.pushBuffer(buf)) onLine(evt);
    } catch (e) {
      try { onError(e); } catch { /* ignore */ }
      stop();
    }
  });

  stream.on('error', (err) => {
    try { onError(err); } catch { /* ignore */ }
    stop();
  });

  stream.on('end', () => finish());
  stream.on('close', () => finish());

  const control = {
    pause: () => {
      try { stream.pause(); } catch { /* ignore */ }
    },
    resume: () => {
      try { stream.resume(); } catch { /* ignore */ }
    },
    isPaused: () => {
      try {
        return typeof stream.isPaused === 'function' ? !!stream.isPaused() : false;
      } catch {
        return false;
      }
    }
  };

  return { mode: 'follow', stop, done, control };
}

/**
 * Convenience wrapper to match the reference doc style:
 * - If `onLine` (or callbacks.onLine) is provided -> follow mode.
 * - Else -> snapshot mode.
 *
 * @param {any} docker
 * @param {string} containerId
 * @param {Object=} options
 * @returns {Promise<any>}
 */
export async function processContainerLogs(docker, containerId, options = {}) {
  const { onLine } = normalizeCallbacks(options);
  if (typeof onLine === 'function') return followContainerLogs(docker, containerId, options);
  return readContainerLogs(docker, containerId, options);
}
