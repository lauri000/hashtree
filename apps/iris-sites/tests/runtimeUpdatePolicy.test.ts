import { describe, expect, it } from 'vitest';
import { classifyRuntimeUpdate } from '../src/lib/runtimeUpdatePolicy';

describe('runtime update policy', () => {
  it('treats the first resolved tree root as bootstrap state', () => {
    expect(classifyRuntimeUpdate('', 'abc:def', false)).toBe('bootstrap');
  });

  it('ignores identical tree root signatures', () => {
    expect(classifyRuntimeUpdate('abc:def', 'abc:def', false)).toBe('ignore');
  });

  it('notifies when a mutable site version changes without autoreload', () => {
    expect(classifyRuntimeUpdate('abc:def', '012:345', false)).toBe('notify');
  });

  it('reloads when a mutable site version changes with autoreload enabled', () => {
    expect(classifyRuntimeUpdate('abc:def', '012:345', true)).toBe('reload');
  });
});
