import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryForwardingMachine, type ForwardTimeoutEvent } from '../src/p2p/queryForwardingMachine.js';

describe('QueryForwardingMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses duplicate forwarding while a hash is in flight', () => {
    const machine = new QueryForwardingMachine({
      requestTimeoutMs: 1000,
      maxForwardsPerPeerWindow: 100,
    });

    const first = machine.beginForward('hash-a', 'peer-a', ['peer-b', 'peer-c']);
    const second = machine.beginForward('hash-a', 'peer-d', ['peer-b']);

    expect(first).toEqual({ kind: 'forward', targets: ['peer-b', 'peer-c'] });
    expect(second).toEqual({ kind: 'suppressed' });
    expect(machine.isInFlight('hash-a')).toBe(true);

    const requesters = machine.resolveForward('hash-a').sort();
    expect(requesters).toEqual(['peer-a', 'peer-d']);
    expect(machine.isInFlight('hash-a')).toBe(false);
  });

  it('rate-limits new forwards per requester in a rolling window', async () => {
    const machine = new QueryForwardingMachine({
      requestTimeoutMs: 1000,
      maxForwardsPerPeerWindow: 2,
      forwardRateLimitWindowMs: 1000,
    });

    expect(machine.beginForward('hash-1', 'peer-a', ['peer-b']).kind).toBe('forward');
    machine.cancelForward('hash-1');

    expect(machine.beginForward('hash-2', 'peer-a', ['peer-b']).kind).toBe('forward');
    machine.cancelForward('hash-2');

    expect(machine.beginForward('hash-3', 'peer-a', ['peer-b']).kind).toBe('rate_limited');

    await vi.advanceTimersByTimeAsync(1001);

    expect(machine.beginForward('hash-4', 'peer-a', ['peer-b']).kind).toBe('forward');
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
