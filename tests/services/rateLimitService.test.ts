import { RedisRateLimiter, rateLimiter } from '../../src/services/rateLimitService';

jest.mock('ioredis', () => {
  const store = new Map<string, { count: number; ttlMs: number }>();
  return {
    __esModule: true,
    default: class FakeRedis {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _store: any = store;

      on() {
        return this;
      }
      async eval(
        script: string,
        numKeys: number,
        key: string,
        windowMs: string | number,
      ) {
        const entry = store.get(key) || { count: 0, ttlMs: 0 };
        entry.count += 1;
        if (entry.count === 1 || entry.ttlMs <= 0) {
          entry.ttlMs = Number(windowMs);
        }
        store.set(key, entry);
        return [entry.count, entry.ttlMs];
      }
      async expire(key: string, seconds: number) {
        const entry = store.get(key) || { count: 0, ttlMs: 0 };
        entry.ttlMs = seconds * 1000;
        store.set(key, entry);
        return 1;
      }
      async del(key: string) {
        store.delete(key);
        return 1;
      }
    },
  };
});

jest.mock('../../src/config/default', () => ({
  redis: { url: 'redis://localhost:6379' },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const clientStore = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (rateLimiter.getClient() as any)._store as Map<
    string,
    { count: number; ttlMs: number }
  >;

describe('RedisRateLimiter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clientStore().clear();
  });

  it('allows requests within the limit and reports remaining capacity', async () => {
    const limiter = new RedisRateLimiter();
    const first = await limiter.check('k', 3, 60000);
    const second = await limiter.check('k', 3, 60000);

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);
  });

  it('denies requests once the window limit is exceeded', async () => {
    const limiter = new RedisRateLimiter();
    await limiter.check('hot', 2, 60000);
    await limiter.check('hot', 2, 60000);
    const third = await limiter.check('hot', 2, 60000);

    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('sets an expiry on the key for the first request in a window', async () => {
    const limiter = new RedisRateLimiter();
    const result = await limiter.check('fresh', 5, 60000);

    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(clientStore().get('fresh')?.ttlMs).toBeGreaterThan(0);
  });

  it('isolates counters across distinct keys', async () => {
    const limiter = new RedisRateLimiter();
    await limiter.check('user-a', 1, 60000);
    const forB = await limiter.check('user-b', 1, 60000);
    expect(forB.allowed).toBe(true);
  });

  it('resets a key so the limit applies again', async () => {
    const limiter = new RedisRateLimiter();
    await limiter.check('r', 1, 60000);
    await limiter.check('r', 1, 60000);
    await limiter.reset('r');

    const afterReset = await limiter.check('r', 1, 60000);
    expect(afterReset.allowed).toBe(true);
  });

  it('surfaces Redis failures for the middleware to fail open', async () => {
    const limiter = new RedisRateLimiter();
    const client = limiter.getClient();
    const originalEval = client.eval.bind(client);
    client.eval = () => {
      throw new Error('connection refused');
    };

    await expect(limiter.check('broken', 5, 60000)).rejects.toThrow('connection refused');

    client.eval = originalEval;
  });
});
