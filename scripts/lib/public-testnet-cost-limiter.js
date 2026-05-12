"use strict";

class PublicTestnetCostLimiter {
  constructor({
    ipLimitPerMinute = 12,
    globalLimitPerMinute = 60,
    recipientLimitPerHour = 6
  } = {}) {
    this.ip = new FixedWindowCounter({ limit: ipLimitPerMinute, windowMs: 60_000 });
    this.global = new FixedWindowCounter({ limit: globalLimitPerMinute, windowMs: 60_000 });
    this.recipient = new FixedWindowCounter({ limit: recipientLimitPerHour, windowMs: 60 * 60_000 });
  }

  allowDeposit({ ip, recipient, now = Date.now() }) {
    const checks = [
      [this.global, "global"],
      [this.ip, `ip:${ip || "unknown"}`],
      [this.recipient, `recipient:${String(recipient || "").toLowerCase()}`]
    ];
    for (const [counter, key] of checks) {
      if (!counter.allow(key, now)) {
        return false;
      }
    }
    return true;
  }
}

class FixedWindowCounter {
  constructor({ limit, windowMs }) {
    this.limit = Number(limit);
    this.windowMs = Number(windowMs);
    this.buckets = new Map();
  }

  allow(key, now = Date.now()) {
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0) {
      return false;
    }
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
}

module.exports = {
  FixedWindowCounter,
  PublicTestnetCostLimiter
};
