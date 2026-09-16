/**
 * Regression tests for file-attachment copy on Windows.
 *
 * Root cause fixed here: processFileAttachments copied attachments to
 * `<session.cwd>/.tmp/<filename>` with fs.copyFileSync. When a same-named file
 * already existed and was locked (typical for repeated 录音-xxx.m4a attachments
 * where a previous copy handle lingered), copyFileSync threw EPERM and the
 * main process surfaced "Failed to process file attachment: EPERM..." as a red
 * global notice on every send.
 *
 * Fix: on EPERM/EBUSY/EACCES, retry with unique -1, -2… filename suffixes
 * instead of failing the whole attachment.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mirrors copyWithRetry() in src/main/session/session-manager.ts
// (kept in sync manually; the real method is private inside SessionManager).
function copyWithRetry(
  tmpDir: string,
  baseFilename: string,
  write: (target: string) => void
): string {
  const firstPath = path.join(tmpDir, baseFilename);
  try {
    write(firstPath);
    return firstPath;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
      throw err;
    }
    let lastErr: unknown = err;
    for (let i = 1; i < 1000; i++) {
      const ext = path.extname(baseFilename);
      const stem = baseFilename.slice(0, baseFilename.length - ext.length);
      const retryPath = path.join(tmpDir, `${stem}-${i}${ext}`);
      if (fs.existsSync(retryPath)) continue;
      try {
        write(retryPath);
        return retryPath;
      } catch (retryErr) {
        const retryCode = (retryErr as NodeJS.ErrnoException)?.code ?? '';
        if (retryCode !== 'EPERM' && retryCode !== 'EBUSY' && retryCode !== 'EACCES') {
          throw retryErr;
        }
        lastErr = retryErr;
      }
    }
    throw lastErr;
  }
}

// Writer that fails with EPERM for a specific locked path (simulates a locked
// same-named destination on Windows), and behaves like fs.writeFileSync else.
function makeLockedWriter(lockedPath: string, payload: Buffer) {
  return (target: string) => {
    if (path.resolve(target) === path.resolve(lockedPath)) {
      const err = new Error(
        `EPERM: operation not permitted, copyfile '${payload.toString()}' -> '${target}'`
      ) as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    }
    fs.writeFileSync(target, payload);
  };
}

describe('attachment copyWithRetry (EPERM unique-filename fallback)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-test-'));
  });

  it('uses the plain filename when no collision', () => {
    const payload = Buffer.from('audio-bytes');
    const dest = copyWithRetry(tmpDir, '录音-20260805-1630.m4a', (t) =>
      fs.writeFileSync(t, payload)
    );
    expect(path.basename(dest)).toBe('录音-20260805-1630.m4a');
    expect(fs.readFileSync(dest)).toEqual(payload);
  });

  it('falls back to -1 suffix when the same-named destination is locked (EPERM)', () => {
    const payload = Buffer.from('audio-bytes');
    const locked = path.join(tmpDir, '录音-20260805-1630.m4a');
    fs.writeFileSync(locked, 'old-locked-content');

    const dest = copyWithRetry(tmpDir, '录音-20260805-1630.m4a', makeLockedWriter(locked, payload));
    expect(dest).not.toBe(locked);
    expect(path.basename(dest)).toBe('录音-20260805-1630-1.m4a');
    expect(fs.readFileSync(dest)).toEqual(payload);
    // The locked original is untouched.
    expect(fs.readFileSync(locked).toString()).toBe('old-locked-content');
  });

  it('skips existing -N suffixes and uses the next free one', () => {
    const payload = Buffer.from('audio-bytes');
    const locked = path.join(tmpDir, 'a.m4a');
    fs.writeFileSync(locked, 'old');
    fs.writeFileSync(path.join(tmpDir, 'a-1.m4a'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'a-2.m4a'), 'x');

    const dest = copyWithRetry(tmpDir, 'a.m4a', makeLockedWriter(locked, payload));
    expect(path.basename(dest)).toBe('a-3.m4a');
  });

  it('rethrows non-EPERM errors untouched', () => {
    const boom = (): never => {
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    };
    expect(() => copyWithRetry(tmpDir, 'x.m4a', boom)).toThrow(/ENOENT/);
  });
});
