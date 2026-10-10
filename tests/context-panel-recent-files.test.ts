import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const contextPanelPath = path.resolve(process.cwd(), 'src/renderer/components/ContextPanel.tsx');

describe('ContextPanel artifact list is session-scoped', () => {
  // Historical context: the panel used to merge an mtime-based workspace
  // scan (`artifacts.listRecentFiles`, files touched after
  // `activeSession.createdAt`) into `displayArtifacts`. That scan cannot
  // distinguish session-introduced files from anything else landing in the
  // CWD during the session (manual copies, editor autosaves, other agents),
  // so artifacts "accumulated" across what the session actually produced.
  // The scan was replaced by precise extraction from toolInput paths and
  // bash redirect targets (see `stepProducesPaths`). These tests guard
  // against the mtime scan creeping back in.
  it('does not trigger workspace mtime scans', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).not.toContain('listRecentFiles');
    expect(source).not.toContain('recentWorkspaceFiles');
  });

  it('builds the artifact list from trace-derived candidates only', () => {
    const source = fs.readFileSync(contextPanelPath, 'utf8');
    expect(source).toContain('const displayArtifacts = useMemo(() => {');
    expect(source).toContain('shouldDisplayArtifactPath');
  });
});
