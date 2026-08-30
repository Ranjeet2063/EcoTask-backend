import { Router, Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { redisConnectionManager } from '../utils/redisConnectionManager.js';

const router = Router();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const checks: Record<string, string> = {};

    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 1500);
      checks.database = 'ok';
    } catch (err) {
      checks.database =
        err instanceof Error && err.message === 'timeout' ? 'timeout' : 'error';
    }

    const redis = await redisConnectionManager.healthCheck(1500);
    checks.redis = redis.healthy ? 'ok' : redis.status;

    const allOk = Object.values(checks).every((v) => v === 'ok');
    const status = allOk ? 200 : 503;

    res.status(status).json({
      status: allOk ? 'healthy' : 'degraded',
      service: 'ecotask-backend',
      timestamp: new Date().toISOString(),
      checks,
    });
  }),
);

export default router;
