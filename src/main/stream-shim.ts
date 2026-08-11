import { TransformStream, ReadableStream, WritableStream } from 'stream/web';
if (typeof globalThis.TransformStream === 'undefined') {
  (globalThis as any).TransformStream = TransformStream;
}
if (typeof globalThis.ReadableStream === 'undefined') {
  (globalThis as any).ReadableStream = ReadableStream;
}
if (typeof globalThis.WritableStream === 'undefined') {
  (globalThis as any).WritableStream = WritableStream;
}

// Polyfill structuredClone for Node 16 (Electron 22)
// pi-tui's UndoStack class uses structuredClone for its undo/redo state.
if (typeof globalThis.structuredClone === 'undefined') {
  const polyfill = require('@ungap/structured-clone');
  (globalThis as any).structuredClone = polyfill.default;
}

// Polyfill FormData for Node 16 (Electron 22)
// OpenAI SDK's client.js checks `body instanceof FormData` which throws
// ReferenceError in Node 16 where FormData is not a global.
if (typeof globalThis.FormData === 'undefined') {
  const { FormData } = require('formdata-node');
  (globalThis as any).FormData = FormData;
}

// Polyfill fetch etc. for Node 16 (Electron 22)
// undici v7 requires Node.js >= 20.18.1 — too new for Electron 22 (Node 16)
// Use node-fetch v2 which supports Node.js 4+
try {
  const fetchFn = require('node-fetch') as any;
  const fn = typeof fetchFn === 'function' ? fetchFn : fetchFn.default;
  if (typeof globalThis.fetch === 'undefined') {
    (globalThis as any).fetch = fn;
  }
  if (typeof globalThis.Headers === 'undefined') {
    (globalThis as any).Headers = fn.Headers;
  }
  if (typeof globalThis.Request === 'undefined') {
    (globalThis as any).Request = fn.Request;
  }
  if (typeof globalThis.Response === 'undefined') {
    (globalThis as any).Response = fn.Response;
  }
} catch (e) {
  try {
    const undici = require('undici') as any;
    if (typeof globalThis.fetch === 'undefined') {
      (globalThis as any).fetch = undici.fetch;
    }
    if (typeof globalThis.Headers === 'undefined') {
      (globalThis as any).Headers = undici.Headers;
    }
    if (typeof globalThis.Request === 'undefined') {
      (globalThis as any).Request = undici.Request;
    }
    if (typeof globalThis.Response === 'undefined') {
      (globalThis as any).Response = undici.Response;
    }
  } catch (e2) {
    console.error('[stream-shim] Failed to polyfill fetch:', e, e2);
  }
}
