/// <reference path="./types/express.d.ts" />

import './config/startup.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import taskRoutes from './routes/tasks.js';
import taskClaimRoutes from './routes/taskClaims.js';
import proofRoutes from './routes/proofs.js';
import healthRoutes from './routes/health.js';
import leaderboardRoutes from './routes/leaderboard.js';
import analyticsRoutes from './routes/analytics.js';
import auditRoutes from './routes/audit.js';
import notificationRoutes from './routes/notifications.js';
import adminNotificationRoutes from './routes/adminNotifications.js';
import adminQueueRoutes from './routes/adminQueues.js';
import validatorRoutes from './routes/validators.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiLimiter, authLimiter, proofLimiter } from './middleware/rateLimit.js';
import { sanitizeInput } from './middleware/sanitize.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import prisma from './utils/prisma.js';
import logger from './utils/logger.js';
import config from './config/default.js';
import { shutdownVerificationWorker } from './workers/verificationWorker.js';
import { shutdownRewardWorker } from './workers/rewardWorker.js';
import { shutdownNotificationWorker } from './workers/notificationWorker.js';
import { stopExpirySweeper } from './workers/expiryWorker.js';
import { stopOutboxSweeper } from './workers/notificationOutboxSweeper.js';
import { stopRewardPayoutSweeper } from './services/rewardPayoutSweeper.js';
import { closeAdminQueues } from './services/queueAdminService.js';
import { redisConnectionManager } from './utils/redisConnectionManager.js';

if (process.env.NODE_ENV !== 'test') {
  import('./workers/verificationWorker.js');
  import('./workers/rewardWorker.js').then(({ startRewardWorker }) => {
    startRewardWorker();
  });
  import('./workers/expiryWorker.js').then(({ startExpirySweeper }) => {
    startExpirySweeper();
  });
  import('./workers/notificationWorker.js').then(({ startNotificationWorker }) => {
    startNotificationWorker();
  });
  import('./workers/notificationOutboxSweeper.js').then(({ startOutboxSweeper }) => {
    startOutboxSweeper();
  });
  import('./services/rewardPayoutSweeper.js').then(({ startRewardPayoutSweeper }) => {
    startRewardPayoutSweeper();
  });
}

const app = express();

app.use(requestIdMiddleware);
app.use(helmet());
app.use(
  cors({
    origin:
      config.corsOrigin === '*' ? '*' : config.corsOrigin.split(',').map((o) => o.trim()),
    exposedHeaders: ['X-Request-Id'],
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(sanitizeInput);

app.use('/api', apiLimiter);

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'ecotask-backend' });
});

app.use('/health', healthRoutes);
app.use('/auth', authLimiter, authRoutes);
app.use('/users', userRoutes);
app.use('/tasks', taskRoutes);
app.use('/tasks', taskClaimRoutes);
app.use('/proofs', proofLimiter, proofRoutes);
app.use('/leaderboard', leaderboardRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/audit', auditRoutes);
app.use('/notifications', notificationRoutes);
app.use('/admin', adminNotificationRoutes);
app.use('/admin', adminQueueRoutes);
app.use(validatorRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(errorHandler);

let httpServer: ReturnType<typeof app.listen> | undefined;

async function safeStep(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error(`Failed to ${label} during shutdown`, { err });
  }
}

async function drainWorkersAndDb(): Promise<void> {
  await safeStep('shut down verification worker', () => shutdownVerificationWorker());
  await safeStep('shut down reward worker', () => shutdownRewardWorker());
  logger.info('Background workers shut down');

  await safeStep('shut down notification worker', () => shutdownNotificationWorker());
  logger.info('Notification dispatch worker shut down');

  await safeStep('close admin queue connections', () => closeAdminQueues());
  logger.info('Admin queue connections closed');

  await safeStep('close redis connection', () => redisConnectionManager.close());
  logger.info('Redis connection closed');

  await safeStep('stop expiry sweeper', () => stopExpirySweeper());
  logger.info('Expiry sweeper stopped');

  await safeStep('stop notification outbox sweeper', () => stopOutboxSweeper());
  logger.info('Notification outbox sweeper stopped');

  await safeStep('stop reward payout sweeper', () => stopRewardPayoutSweeper());
  logger.info('Reward payout sweeper stopped');

  await safeStep('disconnect prisma client', () => prisma.$disconnect());
  logger.info('Prisma client disconnected');
}

/**
 * Shared drain path for both operator-initiated shutdown (SIGTERM/SIGINT)
 * and fatal in-process errors (unhandledRejection/uncaughtException). In
 * test env there is no real process to exit, so we drain state but skip
 * process.exit — the test harness owns the process lifecycle.
 */
async function gracefulShutdown(reason: string, exitCode: number): Promise<void> {
  logger.info(`${reason}, starting graceful shutdown`);

  const forceTimer = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    if (process.env.NODE_ENV !== 'test') process.exit(1);
  }, 10000);
  forceTimer.unref();

  try {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      logger.info('HTTP server closed');
    }
    await drainWorkersAndDb();
  } finally {
    clearTimeout(forceTimer);
  }

  if (process.env.NODE_ENV !== 'test') {
    process.exit(exitCode);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { reason, promise, pid: process.pid });
  void gracefulShutdown('Unhandled promise rejection', 1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err, pid: process.pid });
  void gracefulShutdown('Uncaught exception', 1);
});

if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3000;
  httpServer = app.listen(PORT, () => {
    logger.info(`EcoTask backend running on http://localhost:${PORT}`);
  });

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM received', 0));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT received', 0));
}

export default app;
