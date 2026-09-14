/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
// Node 16 (Electron 22) web API polyfills. Lazy `require` + `any` casts are
// intentional: each shim must resolve at runtime, tolerate missing modules,
// and assign onto globalThis without importing Node 18+ typings.
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

// Polyfill Blob for Node 16 (Electron 22)
// The bundled OpenAI SDK schemas build `z.instanceof(Blob)` validators at
// module top level; without a global Blob the whole bundle throws
// "ReferenceError: Blob is not defined" during load. Node 16 ships Blob in
// 'node:buffer' (since 15.7) but does not expose it globally (Node 18+).
if (typeof globalThis.Blob === 'undefined') {
  try {
    const { Blob } = require('node:buffer') as any;
    if (Blob) {
      (globalThis as any).Blob = Blob;
    }
  } catch (e) {
    console.error('[stream-shim] Failed to polyfill Blob:', e);
  }
}

// Polyfill File for Node 16 (Electron 22)
// Same reason as Blob: OpenAI SDK blob-like schemas reference the global File.
// buffer.File only exists in Node 20+, so fall back to formdata-node's File
// (already a dependency, used for the FormData polyfill above).
if (typeof globalThis.File === 'undefined') {
  try {
    const { File } = require('formdata-node');
    (globalThis as any).File = File;
  } catch (e) {
    console.error('[stream-shim] Failed to polyfill File:', e);
  }
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
