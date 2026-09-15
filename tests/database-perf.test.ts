import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testRoot = '';

function mockElectron(userDataPath: string): void {
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return userDataPath;
        if (name === 'home') return userDataPath;
        return userDataPath;
      },
      getVersion: () => '0.0.0-test',
      isPackaged: false,
    },
  }));
}

function mockLogger(): void {
  vi.doMock('../src/main/utils/logger', () => ({
    log: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  }));
}

async function loadRealDatabaseModule(userDataPath: string) {
  vi.resetModules();
  mockElectron(userDataPath);
  mockLogger();
  return import('../src/main/db/database');
}

describe('database performance pragmas', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-db-perf-'));
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock('electron');
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('runs WAL with synchronous=NORMAL so commits skip per-write fsync', async () => {
    const userDataPath = path.join(testRoot, 'userData');
    fs.mkdirSync(userDataPath, { recursive: true });

    const databaseModule = await loadRealDatabaseModule(userDataPath);
    databaseModule.initDatabase();
    const db = databaseModule.getDatabase();

    expect(db.pragma('journal_mode')).toEqual([{ journal_mode: 'wal' }]);
    // synchronous: 0=OFF 1=NORMAL 2=FULL — WAL + NORMAL is the recommended combo.
    // synchronous: 0=OFF 1=NORMAL 2=FULL — WAL + NORMAL is the recommended combo.
    // better-sqlite3 compiles SQLITE_DEFAULT_WAL_SYNCHRONOUS=1, and database.ts
    // also sets it explicitly so behavior never depends on build-time defaults.
    expect(db.pragma('synchronous')).toEqual([{ synchronous: 1 }]);

    databaseModule.closeDatabase();
  });

  it('sessions.update still persists changes correctly', async () => {
    const userDataPath = path.join(testRoot, 'userData');
    fs.mkdirSync(userDataPath, { recursive: true });

    const databaseModule = await loadRealDatabaseModule(userDataPath);
    databaseModule.initDatabase();
    const db = databaseModule.getDatabase();

    db.sessions.create({
      id: 'sess-1',
      title: 'Test',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: '/tmp/work',
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      created_at: 1000,
      updated_at: 1000,
    } as never);

    db.sessions.update('sess-1', { status: 'running' } as never);
    expect(db.sessions.get('sess-1')?.status).toBe('running');

    // Repeated same-shape updates keep working (statement cache correctness).
    db.sessions.update('sess-1', { status: 'idle' } as never);
    db.sessions.update('sess-1', { title: 'Renamed' } as never);
    const row = db.sessions.get('sess-1');
    expect(row?.status).toBe('idle');
    expect(row?.title).toBe('Renamed');

    databaseModule.closeDatabase();
  });

  it('traceSteps.update still persists changes correctly', async () => {
    const userDataPath = path.join(testRoot, 'userData');
    fs.mkdirSync(userDataPath, { recursive: true });

    const databaseModule = await loadRealDatabaseModule(userDataPath);
    databaseModule.initDatabase();
    const db = databaseModule.getDatabase();

    db.sessions.create({
      id: 'sess-2',
      title: 'Traces',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      created_at: 1000,
      updated_at: 1000,
    } as never);

    db.traceSteps.create({
      id: 'step-1',
      session_id: 'sess-2',
      type: 'tool_call',
      status: 'running',
      title: 'Calling tool',
      content: null,
      tool_name: 'bash',
      tool_input: null,
      tool_output: null,
      is_error: null,
      timestamp: 2000,
      duration: null,
    } as never);

    db.traceSteps.update('step-1', { status: 'completed', duration: 42 } as never);
    const steps = db.traceSteps.getBySessionId('sess-2');
    expect(steps[0].status).toBe('completed');
    expect(steps[0].duration).toBe(42);

    databaseModule.closeDatabase();
  });

  it('caches prepared statements for dynamic updates instead of re-preparing', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/main/db/database.ts'), 'utf8');
    expect(source).toContain('prepareCached');
    // The three dynamic-update sites must go through the cache.
    expect(source).not.toMatch(/rawDb\.prepare\(sql\)\.run\(\.\.\.values\)/);
  });
});
