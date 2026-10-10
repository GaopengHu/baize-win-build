import type { TraceStep } from '../renderer/types';

/**
 * Canonical key used for membership tests between a candidate path and a
 * consumed path. Both forms are normalised to:
 *  - trimmed
 *  - backslashes → forward slashes
 *  - trailing slashes stripped
 *  - leading "./" stripped
 *  - lowercased
 *
 * Use this to normalise BOTH the candidate (from `shouldDisplayArtifactPath`)
 * and the produced entry (from `computeConsumedPaths`) before comparison.
 */
export function pathToConsumedKey(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '').toLowerCase();
}

const FILE_PRODUCER_TOOLS = new Set([
  'write_file',
  'edit_file',
  'Write',
  'Edit',
  'write',
  'edit',
  'NotebookEdit',
  'notebook_edit',
  'artifact',
]);

const BASH_LIKE_TOOLS = new Set([
  'Bash',
  'bash',
  'run_command',
  'shell',
  'bash_command',
  'BashCommand',
]);

function extractFilePathFromInput(input: Record<string, unknown> | undefined): string | null {
  if (!input || typeof input !== 'object') return null;
  const candidates = [input.path, input.filePath, input.file_path, input.relativePath];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function extractBashCommand(input: Record<string, unknown> | undefined): string | null {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() ?? p;
}

function commandReferencesPath(cmd: string, targetPath: string): boolean {
  if (!cmd || !targetPath) return false;
  const targetKey = pathToConsumedKey(targetPath);
  if (!targetKey) return false;

  // 1. Absolute substring with proper boundaries: `data.json` must not match
  //    `mydata.json` or `data.json.bak` — so the match is bracketed by
  //    non-word / non-`/` / non-`.` / non-`-` on both sides.
  const escaped = escapeRegex(targetKey);
  const absRe = new RegExp(`(^|[^\\w/.-])${escaped}(?=$|[^\\w/.-])`);
  if (absRe.test(cmd)) return true;

  // 2. Basename match with non-identifier boundaries: catches relative-path
  //    references like `cat data.json` when the produced file was at
  //    `data.json` or `/cwd/data.json`.
  const base = basename(targetPath).toLowerCase();
  if (!base) return false;
  const baseRe = new RegExp(`(?:^|[\\s/"\x27<>;])${escapeRegex(base)}(?=$|[\\s"\x27<>;&|])`);
  return baseRe.test(cmd);
}

/**
 * Returns every path produced by a step (file-tool input OR bash redirect
 * target). Bash redirect targets are included so that a step like
 * `python3 gen.py > out.json` correctly marks `out.json` as a produced
 * path that a later step may consume.
 *
 * Exported so the artifact candidate builder can also pick up bash
 * redirect targets as file-step candidates — e.g. `python3 gen.py >
 * report.html` exposes `report.html` in the artifact panel even though
 * `Bash` is not in `FILE_TOOL_NAMES` and the redirect path is nowhere in
 * `toolOutput`.
 */
export function stepProducesPaths(step: TraceStep): string[] {
  if (step.status !== 'completed') return [];
  const toolName = step.toolName;
  if (!toolName) return [];

  if (FILE_PRODUCER_TOOLS.has(toolName)) {
    const p = extractFilePathFromInput(step.toolInput);
    return p ? [p] : [];
  }

  if (BASH_LIKE_TOOLS.has(toolName)) {
    const cmd = extractBashCommand(step.toolInput);
    if (!cmd) return [];
    const results: string[] = [];
    // `\s*` between the redirect operator and the target handles
    // `> file` (with whitespace) and `>file` (without), the two forms
    // every real shell in production uses. Without `\s*` only the
    // no-space form was captured, so `python3 gen.py > out.html` was
    // silently dropped by the artifact candidate builder.
    const redirects = cmd.matchAll(/(?:>>?|tee\s+(?:-a\s+)?)\s*(\S+)/g);
    for (const m of redirects) {
      const target = m[1];
      if (
        target &&
        !target.startsWith('/dev/') &&
        !/^\d+$/.test(target) &&
        !target.startsWith('&')
      ) {
        results.push(target);
      }
    }
    return results;
  }

  return [];
}

/**
 * Compute the set of files in this trace that are "consumed" (i.e. used as
 * input by a later step that produces something else). Such files are
 * intermediates, not final deliverables, and should be hidden from the
 * artifacts panel.
 *
 * The check is asymmetric: only bash-like steps count as consumers.
 * Write→Edit on the same path is an update, not a consumption; Write→Write
 * on a different path is an independent deliverable. This avoids hiding
 * real deliverables that happen to be touched by multiple file tools.
 *
 * Returns keys in `pathToConsumedKey` form. Use `pathToConsumedKey` on the
 * candidate (from `shouldDisplayArtifactPath`) before membership testing.
 */
export function computeConsumedPaths(steps: TraceStep[]): Set<string> {
  const consumed = new Set<string>();
  // Record (stepIndex, targetPathKey) for every produced path.
  const produced: Array<{ stepIndex: number; key: string }> = [];

  for (let i = 0; i < steps.length; i++) {
    for (const p of stepProducesPaths(steps[i])) {
      const key = pathToConsumedKey(p);
      if (key) {
        produced.push({ stepIndex: i, key });
      }
    }
  }

  for (const { stepIndex, key: producedKey } of produced) {
    if (consumed.has(producedKey)) continue;
    for (let j = stepIndex + 1; j < steps.length; j++) {
      const later = steps[j];
      if (later.status !== 'completed') continue;
      const toolName = later.toolName;
      if (!toolName) continue;

      // Asymmetric rule: only bash-like steps count as consumers. The
      // consumed-path argument uses the original casing-agnostic key; the
      // command matcher is case-insensitive internally.
      if (BASH_LIKE_TOOLS.has(toolName)) {
        const cmd = extractBashCommand(later.toolInput);
        if (cmd && commandReferencesPath(cmd, producedKey)) {
          consumed.add(producedKey);
          break;
        }
      }
    }
  }

  return consumed;
}
