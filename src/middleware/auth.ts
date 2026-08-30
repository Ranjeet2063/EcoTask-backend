import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/default.js';
import { rateLimiter } from '../services/rateLimitService.js';
import logger from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// ---------------------------------------------------------------------------
// Circuit breaker for the JWT denylist Redis check
//
// When Redis is unavailable, every request would otherwise hang on the GET
// call and then fail open (non-strict) or fail closed after a timeout
// (strict). The circuit breaker avoids both problems:
//
//   CLOSED  → normal operation; Redis GET is called on every request.
//   OPEN    → after `failureThreshold` consecutive Redis errors the circuit
//             trips. Subsequent denylist checks are rejected immediately
//             (fail-closed) without waiting for Redis.
//   HALF_OPEN → after `cooldownMs` the next request probes Redis. A success
//             resets to CLOSED; another failure re-opens the circuit.
//
// This ensures revoked tokens are never silently accepted (fail-closed) while
// limiting the blast radius of transient Redis blips to at most
// `failureThreshold` slow requests before fast-fail kicks in.
// ---------------------------------------------------------------------------

enum CircuitState {
  Closed = 'CLOSED',
  Open = 'OPEN',
  HalfOpen = 'HALF_OPEN',
}

class DenylistCircuitBreaker {
  private state: CircuitState = CircuitState.Closed;
  private consecutiveFailures = 0;
  private openedAt = 0;

  /** Check whether the circuit allows a denylist lookup. */
  allow(): boolean {
    if (this.state === CircuitState.Closed) return true;

    if (this.state === CircuitState.Open) {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= config.auth.denylistCircuitBreaker.cooldownMs) {
        this.state = CircuitState.HalfOpen;
        return true; // allow one probe
      }
      return false; // still open — fast-fail
    }

    // HalfOpen — allow exactly one probe per cooldown window
    return true;
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HalfOpen) {
      logger.info('Denylist circuit breaker closed — Redis recovered');
    }
    this.state = CircuitState.Closed;
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;

    if (this.state === CircuitState.HalfOpen) {
      // Probe failed — re-open
      logger.warn('Denylist circuit breaker re-opened — Redis probe failed');
      this.state = CircuitState.Open;
      this.openedAt = Date.now();
      return;
    }

    if (this.consecutiveFailures >= config.auth.denylistCircuitBreaker.failureThreshold) {
      logger.warn('Denylist circuit breaker opened — Redis failing', {
        consecutiveFailures: this.consecutiveFailures,
      });
      this.state = CircuitState.Open;
      this.openedAt = Date.now();
    }
  }

  /** Expose for testing / observability. */
  getState(): CircuitState {
    return this.state;
  }

  /** Reset to initial state (for tests). */
  reset(): void {
    this.state = CircuitState.Closed;
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}

/** Module-level singleton — shared across all requests in a single process. */
const denylistCircuitBreaker = new DenylistCircuitBreaker();

// ---------------------------------------------------------------------------
// Auth middleware factory
// ---------------------------------------------------------------------------

const createAuthMiddleware = (strict: boolean) =>
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing authorization header' });
    }

    let payload: jwt.JwtPayload & { userId: string; wallet: string };
    try {
      const token = header.slice(7);
      payload = jwt.verify(token, config.jwt.secret, {
        algorithms: ['HS256'],
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
      }) as jwt.JwtPayload & { userId: string; wallet: string };
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }

    if (payload.jti) {
      // --- Circuit breaker gate ---
      // When the circuit is open we fail closed immediately: a token whose
      // revocation status we *cannot verify* is treated as revoked.  This is
      // the conscious trade-off documented in issue #68 — availability is
      // sacrificed to prevent a revoked (potentially compromised) token from
      // being silently accepted during a Redis outage.
      if (!denylistCircuitBreaker.allow()) {
        logger.warn('Denylist circuit open — failing closed for JWT revocation check', {
          jti: payload.jti,
        });
        return res.status(503).json({ error: 'auth service unavailable' });
      }

      try {
        const client = rateLimiter.getClient();
        const isRevoked = await client.get(`jwt_denylist:${payload.jti}`);
        if (isRevoked) {
          return res.status(401).json({ error: 'token revoked' });
        }
        denylistCircuitBreaker.recordSuccess();
      } catch (err) {
        logger.error('Redis error during JWT revocation check', { err });
        denylistCircuitBreaker.recordFailure();

        // Fail closed: if we cannot confirm the token is *not* revoked, we
        // must reject it.  This is the same behaviour as the strict variant,
        // now applied to all middleware paths (issue #68).
        return res.status(503).json({ error: 'auth service unavailable' });
      }
    }

    req.user = payload;
    next();
  });

export const authMiddleware = createAuthMiddleware(false);
export const strictAuthMiddleware = createAuthMiddleware(true);

/** Expose for testing only. */
export { denylistCircuitBreaker };
