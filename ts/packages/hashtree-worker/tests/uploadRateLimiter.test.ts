import { describe, expect, it } from 'vitest';
import { UploadRateLimiter } from '../src/p2p/uploadRateLimiter.js';

describe('UploadRateLimiter', () => {
  it('allows unlimited reservations when no cap is configured', () => {
    const limiter = new UploadRateLimiter();
    expect(limiter.reserve(4_000)).toEqual({ allowed: true, delayMs: 0 });
    expect(limiter.reserve(40_000)).toEqual({ allowed: true, delayMs: 0 });
  });

  it('enforces the configured byte budget and replenishes over time', () => {
    let nowMs = 0;
    const limiter = new UploadRateLimiter({
      bytesPerSecond: 1_000,
      now: () => nowMs,
    });

    expect(limiter.reserve(1_000)).toEqual({ allowed: true, delayMs: 0 });
    expect(limiter.reserve(250)).toEqual({ allowed: false, delayMs: 250 });

    nowMs = 250;
    expect(limiter.reserve(250)).toEqual({ allowed: true, delayMs: 0 });
    expect(limiter.reserve(100)).toEqual({ allowed: false, delayMs: 100 });
  });

  it('applies updated caps without keeping an unlimited budget', () => {
    let nowMs = 0;
    const limiter = new UploadRateLimiter({
      now: () => nowMs,
    });

    expect(limiter.reserve(10_000)).toEqual({ allowed: true, delayMs: 0 });

    limiter.setBytesPerSecond(500);
    expect(limiter.reserve(500)).toEqual({ allowed: true, delayMs: 0 });
    expect(limiter.reserve(1)).toEqual({ allowed: false, delayMs: 4 });

    nowMs = 500;
    expect(limiter.reserve(250)).toEqual({ allowed: true, delayMs: 0 });
  });
});
