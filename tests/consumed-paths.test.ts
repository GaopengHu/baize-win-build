import { describe, it, expect } from 'vitest';
import { stepProducesPaths, computeConsumedPaths } from '../src/shared/consumed-paths';
import type { TraceStep } from '../src/renderer/types';

function makeStep(overrides: Partial<TraceStep>): TraceStep {
  return {
    id: 's',
    type: 'tool_call',
    status: 'completed',
    title: 'Bash',
    toolName: 'Bash',
    toolInput: {},
    toolOutput: '',
    timestamp: 0,
    ...overrides,
  };
}

describe('stepProducesPaths', () => {
  it('returns toolInput.path for file tools', () => {
    expect(
      stepProducesPaths(makeStep({ toolName: 'Write', toolInput: { path: '/tmp/x.html' } }))
    ).toEqual(['/tmp/x.html']);
  });

  it('captures `>` redirect target with surrounding whitespace', () => {
    expect(
      stepProducesPaths(
        makeStep({
          toolInput: { command: 'python3 gen.py > /tmp/report.html' },
        })
      )
    ).toEqual(['/tmp/report.html']);
  });

  it('captures `>` redirect target without surrounding whitespace', () => {
    expect(
      stepProducesPaths(makeStep({ toolInput: { command: 'echo data >/tmp/x.txt' } }))
    ).toEqual(['/tmp/x.txt']);
  });

  it('captures `>>` append targets', () => {
    expect(
      stepProducesPaths(makeStep({ toolInput: { command: 'cat hosts >> /tmp/hosts.bak' } }))
    ).toEqual(['/tmp/hosts.bak']);
  });

  it('captures `tee` and `tee -a` targets', () => {
    expect(
      stepProducesPaths(makeStep({ toolInput: { command: 'echo data | tee /tmp/log.txt' } }))
    ).toEqual(['/tmp/log.txt']);
    expect(
      stepProducesPaths(makeStep({ toolInput: { command: 'echo data | tee -a /tmp/log.txt' } }))
    ).toEqual(['/tmp/log.txt']);
  });

  it('skips /dev/, numeric file descriptors, and &-prefixed targets', () => {
    expect(
      stepProducesPaths(makeStep({ toolInput: { command: 'cmd > /dev/null 2>&1 1>/tmp/out.txt' } }))
    ).toEqual(['/tmp/out.txt']);
  });

  it('returns [] for non-completed steps', () => {
    expect(
      stepProducesPaths(
        makeStep({
          status: 'failed',
          toolInput: { command: 'echo x > /tmp/x.txt' },
        })
      )
    ).toEqual([]);
  });

  it('returns [] for unknown tool names', () => {
    expect(
      stepProducesPaths(
        makeStep({
          toolName: 'random_tool',
          toolInput: { command: 'echo x > /tmp/x.txt' },
        })
      )
    ).toEqual([]);
  });
});

describe('computeConsumedPaths', () => {
  it('flags a file produced earlier when a later bash step references it', () => {
    const steps: TraceStep[] = [
      makeStep({
        id: 'w',
        toolName: 'Write',
        toolInput: { path: '/tmp/data.json' },
      }),
      makeStep({
        id: 'b',
        toolName: 'Bash',
        toolInput: { command: 'cat /tmp/data.json | process' },
      }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has('/tmp/data.json')).toBe(true);
  });

  it('does not flag a file when no later step references it', () => {
    const steps: TraceStep[] = [
      makeStep({
        id: 'w',
        toolName: 'Write',
        toolInput: { path: '/tmp/data.json' },
      }),
    ];
    expect(computeConsumedPaths(steps).size).toBe(0);
  });

  it('Write→Edit on the same path is an update, not a consumption', () => {
    const steps: TraceStep[] = [
      makeStep({
        id: 'w1',
        toolName: 'Write',
        toolInput: { path: '/tmp/data.json' },
      }),
      makeStep({
        id: 'e1',
        toolName: 'Edit',
        toolInput: { path: '/tmp/data.json' },
      }),
    ];
    expect(computeConsumedPaths(steps).size).toBe(0);
  });
});
