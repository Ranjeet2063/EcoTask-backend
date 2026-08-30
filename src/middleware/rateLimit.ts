import { Request, Response, NextFunction } from 'express';
import { rateLimiter } from '../services/rateLimitService.js';
import config from '../config/default.js';
import logger from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export interface PerUserLimitOptions {
  windowMs: number;
  max: number;
  scope: string;
  keyFn?: (req: Request) => string;
  errorMessage?: string;
  failClosed?: boolean;
}

/**
 * Per-user (or per-IP for anonymous callers) fixed-window limiter backed by
 * Redis. Can fail open or closed if Redis is unreachable.
 */
export function perUserLimiter(options: PerUserLimitOptions) {
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const clientId = options.keyFn
      ? options.keyFn(req)
      : req.user?.userId || req.ip || 'unknown';
    const key = `rl:${options.scope}:${clientId}`;

    try {
      const result = await rateLimiter.check(key, options.max, options.windowMs);
      res.setHeader('RateLimit-Limit', String(options.max));
      res.setHeader('RateLimit-Remaining', String(result.remaining));
      res.setHeader('RateLimit-Reset', String(result.retryAfterSeconds));

      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        return res
          .status(429)
          .json({
            error: options.errorMessage || 'Too many requests, please try again later',
          });
      }

      next();
    } catch (err) {
      if (options.failClosed) {
        logger.error('Rate limiter unavailable, failing closed', { err });
        return res.status(500).json({ error: 'Internal server error' });
      }
      logger.warn('Per-user rate limiter unavailable, allowing request', { err });
      next();
    }
  });
}

export const apiLimiter = perUserLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
  scope: 'api',
});

export const authLimiter = perUserLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  scope: 'auth',
  failClosed: true,
  errorMessage: 'Too many login attempts',
});

export const proofLimiter = perUserLimiter({
  windowMs: 60 * 60 * 1000,
  max: 50,
  scope: 'proof',
  failClosed: true,
  errorMessage: 'Too many proof submissions',
});

export const proofSubmissionLimiter = perUserLimiter({
  windowMs: config.rateLimit.proofWindowMs,
  max: config.rateLimit.proofMax,
  scope: 'proof-submit',
});

export const claimLimiter = perUserLimiter({
  windowMs: config.rateLimit.claimWindowMs,
  max: config.rateLimit.claimMax,
  scope: 'task-claim',
});

export const challengeIssueLimiter = perUserLimiter({
  windowMs: config.auth.challengeIssueWindowMs,
  max: config.auth.challengeIssueMax,
  scope: 'challenge-issue',
  keyFn: (req) =>
    typeof req.query.wallet === 'string' ? req.query.wallet : req.ip || 'unknown',
});
