type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface ForwardTimeoutEvent {
  hashKey: string;
  requesterIds: string[];
}

export type ForwardDecision =
  | { kind: 'forward'; targets: string[] }
  | { kind: 'suppressed' }
  | { kind: 'rate_limited' }
  | { kind: 'no_targets' };

export interface QueryForwardingMachineConfig {
  requestTimeoutMs: number;
  maxForwardsPerPeerWindow?: number;
  forwardRateLimitWindowMs?: number;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearScheduledTimeout?: (timeoutId: TimeoutHandle) => void;
  onForwardTimeout?: (event: ForwardTimeoutEvent) => void;
}

interface InFlightForward {
  requesters: Set<string>;
  timeoutId: TimeoutHandle;
}

class SlidingWindowRateLimiter {
  private readonly maxEvents: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly eventsByPeer = new Map<string, number[]>();

  constructor(maxEvents: number, windowMs: number, now: () => number) {
    this.maxEvents = maxEvents;
    this.windowMs = windowMs;
    this.now = now;
  }

  allow(peerId: string): boolean {
    const now = this.now();
    const events = this.eventsByPeer.get(peerId) ?? [];
    let firstActiveIndex = 0;
    while (firstActiveIndex < events.length && now - events[firstActiveIndex] >= this.windowMs) {
      firstActiveIndex++;
    }
    if (firstActiveIndex > 0) {
      events.splice(0, firstActiveIndex);
    }

    if (events.length >= this.maxEvents) {
      this.eventsByPeer.set(peerId, events);
      return false;
    }

    events.push(now);
    this.eventsByPeer.set(peerId, events);
    return true;
  }

  resetPeer(peerId: string): void {
    this.eventsByPeer.delete(peerId);
  }

  clear(): void {
    this.eventsByPeer.clear();
  }
}

export class QueryForwardingMachine {
  private readonly requestTimeoutMs: number;
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => TimeoutHandle;
  private readonly clearScheduledTimeout: (timeoutId: TimeoutHandle) => void;
  private readonly onForwardTimeout?: (event: ForwardTimeoutEvent) => void;
  private readonly hashesByRequester = new Map<string, Set<string>>();
  private readonly inFlightByHash = new Map<string, InFlightForward>();
  private readonly rateLimiter: SlidingWindowRateLimiter;

  constructor(config: QueryForwardingMachineConfig) {
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.scheduleTimeout = config.scheduleTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduledTimeout = config.clearScheduledTimeout ?? ((timeoutId) => clearTimeout(timeoutId));
    this.onForwardTimeout = config.onForwardTimeout;

    const now = config.now ?? (() => Date.now());
    const maxForwardsPerPeerWindow = config.maxForwardsPerPeerWindow ?? 64;
    const forwardRateLimitWindowMs = config.forwardRateLimitWindowMs ?? 1000;
    this.rateLimiter = new SlidingWindowRateLimiter(maxForwardsPerPeerWindow, forwardRateLimitWindowMs, now);
  }

  beginForward(hashKey: string, requesterId: string, candidateTargets: string[]): ForwardDecision {
    const targets = candidateTargets.filter(target => target !== requesterId);
    if (targets.length === 0) {
      return { kind: 'no_targets' };
    }

    const existing = this.inFlightByHash.get(hashKey);
    if (existing) {
      this.trackRequester(hashKey, existing.requesters, requesterId);
      return { kind: 'suppressed' };
    }

    if (!this.rateLimiter.allow(requesterId)) {
      return { kind: 'rate_limited' };
    }

    const requesters = new Set<string>();
    this.trackRequester(hashKey, requesters, requesterId);
    const timeoutId = this.scheduleTimeout(() => {
      this.handleForwardTimeout(hashKey);
    }, this.requestTimeoutMs);

    this.inFlightByHash.set(hashKey, { requesters, timeoutId });
    return { kind: 'forward', targets };
  }

  resolveForward(hashKey: string): string[] {
    return this.clearForward(hashKey, false);
  }

  cancelForward(hashKey: string): string[] {
    return this.clearForward(hashKey, false);
  }

  removePeer(peerId: string): void {
    const hashes = this.hashesByRequester.get(peerId);
    if (hashes) {
      for (const hashKey of Array.from(hashes)) {
        const inFlight = this.inFlightByHash.get(hashKey);
        if (!inFlight) continue;

        inFlight.requesters.delete(peerId);
        if (inFlight.requesters.size === 0) {
          this.clearForward(hashKey, false);
        }
      }
    }

    this.hashesByRequester.delete(peerId);
    this.rateLimiter.resetPeer(peerId);
  }

  stop(): void {
    for (const hashKey of Array.from(this.inFlightByHash.keys())) {
      this.clearForward(hashKey, false);
    }
    this.hashesByRequester.clear();
    this.rateLimiter.clear();
  }

  isInFlight(hashKey: string): boolean {
    return this.inFlightByHash.has(hashKey);
  }

  getInFlightCount(): number {
    return this.inFlightByHash.size;
  }

  private handleForwardTimeout(hashKey: string): void {
    this.clearForward(hashKey, true);
  }

  private clearForward(hashKey: string, notifyTimeout: boolean): string[] {
    const inFlight = this.inFlightByHash.get(hashKey);
    if (!inFlight) return [];

    this.clearScheduledTimeout(inFlight.timeoutId);
    this.inFlightByHash.delete(hashKey);

    const requesterIds = Array.from(inFlight.requesters);
    for (const requesterId of requesterIds) {
      const hashes = this.hashesByRequester.get(requesterId);
      if (!hashes) continue;
      hashes.delete(hashKey);
      if (hashes.size === 0) {
        this.hashesByRequester.delete(requesterId);
      }
    }

    if (notifyTimeout && this.onForwardTimeout) {
      this.onForwardTimeout({ hashKey, requesterIds });
    }

    return requesterIds;
  }

  private trackRequester(hashKey: string, requesters: Set<string>, requesterId: string): void {
    requesters.add(requesterId);
    let hashes = this.hashesByRequester.get(requesterId);
    if (!hashes) {
      hashes = new Set<string>();
      this.hashesByRequester.set(requesterId, hashes);
    }
    hashes.add(hashKey);
  }
}
