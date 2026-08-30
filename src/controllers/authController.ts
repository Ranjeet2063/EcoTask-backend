import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { rateLimiter } from '../services/rateLimitService.js';
import config from '../config/default.js';
import { generateChallenge, verifyStellarSignature } from '../services/stellarService.js';
import { findOrCreateUser } from '../models/user.js';
import { loginSchema } from '../utils/validation.js';
import logger from '../utils/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const CHALLENGE_KEY_PREFIX = 'login_challenge:';

export const getChallenge = asyncHandler(async (req: Request, res: Response) => {
  const wallet = req.query.wallet as string;
  if (!wallet || wallet.length !== 56) {
    return res.status(400).json({ error: 'invalid wallet address' });
  }

  const challenge = generateChallenge();
  try {
    const client = rateLimiter.getClient();
    await client.set(
      `${CHALLENGE_KEY_PREFIX}${wallet}`,
      challenge,
      'PX',
      config.auth.challengeTtlMs,
    );
  } catch (err) {
    logger.error('Redis error while storing login challenge', { err });
    return res.status(503).json({ error: 'auth service unavailable' });
  }
  return res.json({ challenge });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const { wallet, signature, challenge } = parsed.data;
  const key = `${CHALLENGE_KEY_PREFIX}${wallet}`;

  // GETDEL atomically reads and deletes the stored challenge in one round
  // trip, so concurrent logins racing on the same challenge can never both
  // observe it: at most one caller gets the value back, every other caller
  // gets null and falls through to the 401 below.
  let stored: string | null;
  try {
    const client = rateLimiter.getClient();
    stored = await client.getdel(key);
  } catch (err) {
    logger.error('Redis error while consuming login challenge', { err });
    return res.status(503).json({ error: 'auth service unavailable' });
  }

  if (!stored || stored !== challenge) {
    return res.status(401).json({ error: 'invalid or expired challenge' });
  }

  const message = `EcoTask login: ${challenge}`;
  const isValid = verifyStellarSignature(wallet, message, signature);
  if (!isValid) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const user = await findOrCreateUser(wallet);
  const token = jwt.sign({ userId: user.id, wallet: user.wallet }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    algorithm: 'HS256',
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    jwtid: crypto.randomUUID(),
  } as SignOptions);

  return res.json({ token, user });
});

export function verify(req: Request, res: Response) {
  return res.json({ user: req.user });
}

export const logout = asyncHandler(async (req: Request, res: Response) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing authorization header' });
    }
    const token = header.slice(7);
    const decoded = jwt.decode(token) as jwt.JwtPayload | null;

    if (!decoded || !decoded.jti || !decoded.exp) {
      return res.status(400).json({ error: 'invalid token payload' });
    }

    const ttlSeconds = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
    if (ttlSeconds > 0) {
      const client = rateLimiter.getClient();
      await client.set(`jwt_denylist:${decoded.jti}`, '1', 'EX', ttlSeconds);
    }

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: 'logout failed' });
  }
});
