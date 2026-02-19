import { describe, expect, it } from 'vitest';
import { QueryForwardingMachine } from '../src/p2p/queryForwardingMachine.js';

type RequestMessage = {
  type: 'request';
  from: string;
  to: string;
  hashKey: string;
  htl: number;
};

type ResponseMessage = {
  type: 'response';
  from: string;
  to: string;
  hashKey: string;
};

type SimMessage = RequestMessage | ResponseMessage;

interface NodeStats {
  requestsSent: number;
  requestsReceived: number;
  responsesSent: number;
  responsesReceived: number;
  suppressed: number;
  rateLimited: number;
}

interface SimNode {
  id: string;
  neighbors: string[];
  localHashes: Set<string>;
  machine: QueryForwardingMachine;
  stats: NodeStats;
}

const CLIENT_PREFIX = 'client:';

function clientRequester(nodeId: string): string {
  return `${CLIENT_PREFIX}${nodeId}`;
}

function isClientRequester(requesterId: string): boolean {
  return requesterId.startsWith(CLIENT_PREFIX);
}

class QueryForwardingSimulator {
  private readonly nodes = new Map<string, SimNode>();
  private readonly queue: SimMessage[] = [];
  private readonly resolvedClients = new Set<string>();
  private requestCount = 0;
  private responseCount = 0;

  addNode(id: string, neighbors: string[], localHashes: string[] = []): void {
    this.nodes.set(id, {
      id,
      neighbors: [...neighbors],
      localHashes: new Set(localHashes),
      machine: new QueryForwardingMachine({
        requestTimeoutMs: 60000,
        maxForwardsPerPeerWindow: 1000,
      }),
      stats: {
        requestsSent: 0,
        requestsReceived: 0,
        responsesSent: 0,
        responsesReceived: 0,
        suppressed: 0,
        rateLimited: 0,
      },
    });
  }

  startLookup(originId: string, hashKey: string, htl: number): boolean {
    const origin = this.nodes.get(originId);
    if (!origin) {
      throw new Error(`Unknown origin node: ${originId}`);
    }

    const decision = origin.machine.beginForward(hashKey, clientRequester(originId), origin.neighbors);
    if (decision.kind !== 'forward') {
      return false;
    }

    for (const target of decision.targets) {
      this.enqueueRequest(originId, target, hashKey, htl);
    }
    return true;
  }

  run(maxSteps = 1000): { steps: number; requests: number; responses: number } {
    let steps = 0;
    while (this.queue.length > 0) {
      if (steps >= maxSteps) {
        throw new Error(`Simulation exceeded ${maxSteps} steps`);
      }
      const msg = this.queue.shift()!;
      if (msg.type === 'request') {
        this.handleRequest(msg);
      } else {
        this.handleResponse(msg);
      }
      steps++;
    }
    return {
      steps,
      requests: this.requestCount,
      responses: this.responseCount,
    };
  }

  wasClientResolved(originId: string, hashKey: string): boolean {
    return this.resolvedClients.has(`${originId}:${hashKey}`);
  }

  totalSuppressed(): number {
    let total = 0;
    for (const node of this.nodes.values()) {
      total += node.stats.suppressed;
    }
    return total;
  }

  shutdown(): void {
    for (const node of this.nodes.values()) {
      node.machine.stop();
    }
  }

  private enqueueRequest(from: string, to: string, hashKey: string, htl: number): void {
    if (htl <= 0) return;
    const sender = this.nodes.get(from);
    if (sender) {
      sender.stats.requestsSent++;
    }
    this.requestCount++;
    this.queue.push({ type: 'request', from, to, hashKey, htl });
  }

  private enqueueResponse(from: string, to: string, hashKey: string): void {
    const sender = this.nodes.get(from);
    if (sender) {
      sender.stats.responsesSent++;
    }
    this.responseCount++;
    this.queue.push({ type: 'response', from, to, hashKey });
  }

  private handleRequest(msg: RequestMessage): void {
    const node = this.nodes.get(msg.to);
    if (!node) {
      throw new Error(`Unknown node: ${msg.to}`);
    }

    node.stats.requestsReceived++;
    if (node.localHashes.has(msg.hashKey)) {
      this.enqueueResponse(node.id, msg.from, msg.hashKey);
      return;
    }

    if (msg.htl <= 1) {
      return;
    }

    const targets = node.neighbors.filter(peerId => peerId !== msg.from);
    const decision = node.machine.beginForward(msg.hashKey, msg.from, targets);
    if (decision.kind === 'suppressed') {
      node.stats.suppressed++;
      return;
    }
    if (decision.kind === 'rate_limited') {
      node.stats.rateLimited++;
      return;
    }
    if (decision.kind !== 'forward') {
      return;
    }

    const nextHtl = msg.htl - 1;
    for (const target of decision.targets) {
      this.enqueueRequest(node.id, target, msg.hashKey, nextHtl);
    }
  }

  private handleResponse(msg: ResponseMessage): void {
    const node = this.nodes.get(msg.to);
    if (!node) {
      throw new Error(`Unknown node: ${msg.to}`);
    }

    node.stats.responsesReceived++;
    const requesters = node.machine.resolveForward(msg.hashKey);
    for (const requesterId of requesters) {
      if (isClientRequester(requesterId)) {
        this.resolvedClients.add(`${node.id}:${msg.hashKey}`);
        continue;
      }
      this.enqueueResponse(node.id, requesterId, msg.hashKey);
    }
  }
}

describe('Query forwarding simulation', () => {
  it('resolves across a three-node chain without recursive forwarding', () => {
    const simulator = new QueryForwardingSimulator();
    simulator.addNode('A', ['B'], ['hash-x']);
    simulator.addNode('B', ['A', 'C']);
    simulator.addNode('C', ['B']);

    expect(simulator.startLookup('C', 'hash-x', 6)).toBe(true);
    const summary = simulator.run();
    simulator.shutdown();

    expect(simulator.wasClientResolved('C', 'hash-x')).toBe(true);
    expect(summary.requests).toBe(2);
    expect(summary.responses).toBe(2);
    expect(simulator.totalSuppressed()).toBe(0);
  });

  it('keeps three-peer miss traffic bounded with duplicate suppression', () => {
    const simulator = new QueryForwardingSimulator();
    simulator.addNode('A', ['B', 'C']);
    simulator.addNode('B', ['A', 'C']);
    simulator.addNode('C', ['A', 'B']);

    expect(simulator.startLookup('C', 'hash-missing', 8)).toBe(true);
    const summary = simulator.run();
    simulator.shutdown();

    expect(simulator.wasClientResolved('C', 'hash-missing')).toBe(false);
    expect(summary.requests).toBe(4);
    expect(summary.responses).toBe(0);
    expect(simulator.totalSuppressed()).toBe(2);
  });
});
