import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryForwardingMachine, type ForwardTimeoutEvent } from '../src/p2p/queryForwardingMachine.js';

describe('QueryForwardingMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('notifies timeout cleanup for in-flight forwards', async () => {
    const timeoutEvents: ForwardTimeoutEvent[] = [];
    const machine = new QueryForwardingMachine({
      requestTimeoutMs: 500,
      maxForwardsPerPeerWindow: 100,
      onForwardTimeout: (event) => {
        timeoutEvents.push(event);
      },
    });

    const decision = machine.beginForward('hash-timeout', 'peer-a', ['peer-b']);
    expect(decision.kind).toBe('forward');

    await vi.advanceTimersByTimeAsync(499);
    expect(timeoutEvents).toHaveLength(0);
    expect(machine.isInFlight('hash-timeout')).toBe(true);

    await vi.advanceTimersByTimeAsync(1);

    expect(timeoutEvents).toHaveLength(1);
    expect(timeoutEvents[0]).toEqual({
      hashKey: 'hash-timeout',
      requesterIds: ['peer-a'],
    });
    expect(machine.isInFlight('hash-timeout')).toBe(false);
  });

  it('cleans in-flight state when a requester peer disconnects', () => {
    const machine = new QueryForwardingMachine({
      requestTimeoutMs: 1000,
      maxForwardsPerPeerWindow: 100,
    });

    expect(machine.beginForward('hash-a', 'peer-a', ['peer-b']).kind).toBe('forward');
    expect(machine.isInFlight('hash-a')).toBe(true);

    machine.removePeer('peer-a');

    expect(machine.isInFlight('hash-a')).toBe(false);
    expect(machine.getInFlightCount()).toBe(0);
  });
});
