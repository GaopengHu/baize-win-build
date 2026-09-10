import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard for the "app won't launch" crash shipped in 0.0.1:
 *
 * ws@8 exports `module.exports = WebSocket` (a class extending EventEmitter).
 * Under Electron 22 (Node 16), EventEmitter's static members (on, once, init,
 * setMaxListeners, ...) are ENUMERABLE INHERITED properties. When Rollup emits
 * its namespace interop helper (`getAugmentedNamespace`, minified as `mc`) for
 * a named import from an external CJS module, the helper iterates with
 * `for...in` (which walks the prototype chain) and then calls
 * `Object.getOwnPropertyDescriptor(exports, name)` — undefined for inherited
 * names — crashing at bundle top level with
 * "TypeError: Cannot read properties of undefined (reading 'get')".
 *
 * A default import (+ destructuring / type-only imports) makes Rollup emit the
 * simple `getDefaultExportFromCjs` interop instead, matching the working
 * 3.3.1 bundle shape (`require("ws")` + property access).
 */
describe('ws import style avoids namespace interop crash', () => {
  const gatewaySource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/remote/gateway.ts'),
    'utf8'
  );

  it('gateway.ts does not use value-position named imports from ws', () => {
    // `import { X } from 'ws'` (non-type) is what triggers Rollup's mc() wrapper.
    expect(gatewaySource).not.toMatch(/^import\s*\{[^}]*\}\s*from\s*['"]ws['"]/m);
  });

  it('gateway.ts imports ws as default and binds members at runtime', () => {
    expect(gatewaySource).toMatch(/^import\s+\w+\s+from\s+'ws';/m);
    expect(gatewaySource).toContain('wsLib as unknown as WsModule');
    expect(gatewaySource).toMatch(/^const \{ WebSocketServer, WebSocket \} =/m);
  });

  it('no other main-process module value-imports named bindings from ws', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        if (/^import\s*\{[^}]*\}\s*from\s*['"]ws['"]/m.test(source)) {
          offenders.push(full);
        }
      }
    };
    walk(path.resolve(process.cwd(), 'src/main'));
    expect(offenders).toEqual([]);
  });
});
