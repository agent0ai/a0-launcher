# Docker Log Processor (DockerInterface Extension)

This repo includes a small, reusable log processor for Dockerode-based containers.

It provides:
- read-once snapshots (last N lines, bounded)
- follow mode with initial burst (last N lines) + live streaming
- per-line callbacks with clean line splitting
- bounded internal buffering for partial lines and mux frames
- `AbortSignal` cancellation
- pause/resume control (for UI backpressure patterns)

Code:
- `shell/docker/impl/DockerodeLogProcessor.mjs` (core stream processing)
- `shell/docker/impl/DockerodeDocker.mjs` (implements the interface methods)
- `shell/docker/DockerInterface.mjs` (declares the interface)

## Concepts

Docker logs behave differently depending on whether the container was started with a TTY:
- `Config.Tty: true`: the logs stream is plain bytes (single stream).
- `Config.Tty: false`: Docker emits multiplexed stdout/stderr frames with an 8-byte header per frame.

The processor inspects the container to detect TTY, then either:
- splits UTF-8 data into lines directly (TTY)
- demuxes frames (stdout/stderr) and then splits each stream into lines (non-TTY)

## API Surface

These methods are exposed via `DockerInterface` (and implemented by `DockerodeDocker`):

- `readContainerLogs(containerId, options)`
  - read-once snapshot, returns `{ mode: 'snapshot', lines, aborted }`
- `followContainerLogs(containerId, options)`
  - follow mode, returns `{ mode: 'follow', stop, done, control }`

### LogLineEvent

Each emitted or returned line is:

```js
{
  stream: 'stdout' | 'stderr',
  line: string,
  partial?: boolean, // true if flushed without a trailing '\n' (end/stop/guard)
}
```

## Options

### Common options

- `maxLines`: number
  - snapshot: maximum lines returned (and passed as Docker `tail`)
  - follow: initial burst size (passed as Docker `tail`)
- `includeStderr`: boolean (default `true`)
- `timestamps`: boolean (default `false`)
- `signal`: `AbortSignal`
  - follow: abort stops the stream
  - snapshot: abort stops reading and returns `aborted: true` with whatever was collected
- `maxPartialBytes`: number (default `1 << 20`)
  - bounds the partial line buffer; if exceeded, the current partial is force-emitted as `{ partial: true }`
- `maxMuxBufferBytes`: number (default `8 << 20`)
  - bounds the internal demux buffer for non-TTY containers
- `flushPartialOnEnd`: boolean (default `true`)
  - if true, flushes the remaining partial line as `{ partial: true }` on end/stop

### Follow-only callbacks

You can provide callbacks either directly or under `callbacks`:

```js
{
  callbacks: {
    onLine: (evt) => {},
    onError: (err) => {},
    onEnd: () => {},
  }
}
```

Or:

```js
{
  onLine: (evt) => {},
  onError: (err) => {},
  onEnd: () => {},
}
```

## Examples (Electron-Oriented)

These examples assume Docker access stays in the Electron main process, and the renderer only receives sanitized text lines via IPC.

### 1) Read-once snapshot for diagnostics (search for error patterns)

```js
import { DockerInterface } from './DockerInterface.mjs';

const docker = await DockerInterface.get();
const { lines, aborted } = await docker.readContainerLogs(containerId, {
  maxLines: 500,
  includeStderr: true,
  timestamps: true,
});

if (!aborted) {
  const errorLines = lines.filter(({ line }) => /error|fatal|panic/i.test(line));
  // show errorLines in UI, attach to bug report, etc.
}
```

### 2) Follow logs for a live viewer (AbortController lifecycle)

```js
import { DockerInterface } from './DockerInterface.mjs';

const docker = await DockerInterface.get();
const viewAbort = new AbortController();

const { stop, done, control } = await docker.followContainerLogs(containerId, {
  maxLines: 200, // initial burst
  signal: viewAbort.signal,
  callbacks: {
    onLine: (evt) => {
      // forward to renderer via IPC
      // event.sender.send('logs:line', { containerId, evt })
    },
    onError: (err) => {
      // forward an error banner / status
    },
    onEnd: () => {
      // mark the viewer as ended
    },
  }
});

// On view dispose:
viewAbort.abort(new Error('Log view closed'));
await done;
```

Notes:
- `stop()` is immediate (destroys the stream) and resolves `done`.
- `control.pause()` and `control.resume()` are useful for backpressure patterns.

### 3) Backpressure: pause/resume based on a bounded queue + renderer ACK

This pattern prevents an overwhelmed renderer from causing unbounded memory growth.

Main process:

```js
import { ipcMain } from 'electron';
import { DockerInterface } from './DockerInterface.mjs';

const docker = await DockerInterface.get();
const handles = new Map(); // followId -> { stop }

ipcMain.handle('logs:follow', async (event, { containerId, followId }) => {
  const viewAbort = new AbortController();

  const HI_WATER = 5000;
  const LO_WATER = 1000;
  const BATCH = 200;

  let paused = false;
  const queue = [];
  let inflight = 0;

  const ackChannel = `logs:ack:${followId}`;
  const ackHandler = (_ev, { n }) => {
    inflight = Math.max(0, inflight - (n | 0));
  };
  ipcMain.on(ackChannel, ackHandler);

  function pump(control) {
    while (!paused && queue.length > 0) {
      const batch = queue.splice(0, Math.min(BATCH, queue.length));
      inflight += batch.length;
      event.sender.send('logs:batch', { followId, batch, ackChannel });

      if (queue.length + inflight > HI_WATER) {
        paused = true;
        control.pause();
        break;
      }
    }

    if (paused && (queue.length + inflight) < LO_WATER) {
      paused = false;
      control.resume();
    }
  }

  const { stop, done, control } = await docker.followContainerLogs(containerId, {
    maxLines: 500,
    signal: viewAbort.signal,
    callbacks: {
      onLine: (evt) => {
        queue.push(evt);
        pump(control);
      },
      onError: (err) => event.sender.send('logs:error', { followId, error: String(err?.message ?? err) }),
      onEnd: () => event.sender.send('logs:end', { followId }),
    },
  });

  handles.set(followId, { stop: () => viewAbort.abort(new Error('User stopped logs')) });

  done.finally(() => {
    handles.delete(followId);
    ipcMain.removeListener(ackChannel, ackHandler);
  });

  return { ok: true };
});

ipcMain.handle('logs:stop', async (_event, { followId }) => {
  handles.get(followId)?.stop?.();
  return { ok: true };
});
```

Renderer (batch render + ACK):

```js
import { ipcRenderer } from 'electron';

let pending = [];
let ackChannel = null;
let renderedSinceAck = 0;

ipcRenderer.on('logs:batch', (_ev, { batch, ackChannel: ch }) => {
  ackChannel = ch;
  pending.push(...batch);
});

function renderTick() {
  const MAX_PER_TICK = 300;
  const slice = pending.splice(0, Math.min(MAX_PER_TICK, pending.length));

  for (const { stream, line } of slice) {
    appendLineToUI(stream, line);
  }

  renderedSinceAck += slice.length;
  if (ackChannel && renderedSinceAck > 0) {
    ipcRenderer.send(ackChannel, { n: renderedSinceAck });
    renderedSinceAck = 0;
  }

  requestAnimationFrame(renderTick);
}

requestAnimationFrame(renderTick);
```

### 4) Read-once with timeout + user cancel (AbortSignal.any)

```js
import { DockerInterface } from './DockerInterface.mjs';

const docker = await DockerInterface.get();
const user = new AbortController();
const timeout = AbortSignal.timeout(2000);
const signal = AbortSignal.any([user.signal, timeout]);

const res = await docker.readContainerLogs(containerId, { maxLines: 500, signal });
// res.aborted is true if either signal fired while reading
```

## Limitations

- Some Docker logging drivers do not support `docker logs`; in that case, Dockerode will error and the caller should surface a diagnostic to the user.
- If a container emits extremely long text without newlines, `maxPartialBytes` forces a flush to keep memory bounded. The emitted line will have `partial: true`.
