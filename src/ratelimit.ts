/**
 * 令牌桶限流器：容量 = ratePerSec，按秒匀速回补。
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = refillPerSec;
    this.last = now();
  }

  /** 取一枚令牌；不足则返回 false（调用方丢弃该帧）。 */
  tryTake(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.refillPerSec, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
