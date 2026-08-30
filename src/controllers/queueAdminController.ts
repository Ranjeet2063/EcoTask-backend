import { Request, Response } from 'express';
import {
  ADMIN_QUEUE_NAMES,
  getQueueCounts,
  isAdminQueueName,
  JobNotFoundError,
  JobNotFailedError,
  listFailedJobs,
  retryFailedJob,
} from '../services/queueAdminService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const MAX_LIMIT = 100;

/**
 * Reports waiting/active/completed/failed (plus delayed/paused) counts for
 * the verification and reward-payout queues in a single call — the backlog
 * visibility surface for those pipelines.
 */
export const getQueueOverview = asyncHandler(async (_req: Request, res: Response) => {
  const data = await Promise.all(
    ADMIN_QUEUE_NAMES.map((queueName) => getQueueCounts(queueName)),
  );
  return res.json({ data });
});

export const getFailedJobs = asyncHandler(async (req: Request, res: Response) => {
  const { queueName } = req.params;
  if (!isAdminQueueName(queueName)) {
    return res.status(400).json({ error: `unknown queue '${queueName}'` });
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, MAX_LIMIT);
  const offset = parseInt(req.query.offset as string) || 0;

  const { items, total } = await listFailedJobs(queueName, limit, offset);

  return res.json({
    data: items,
    meta: { queue: queueName, limit, offset, total },
  });
});

export const retryJob = asyncHandler(async (req: Request, res: Response) => {
  const { queueName, jobId } = req.params;
  if (!isAdminQueueName(queueName)) {
    return res.status(400).json({ error: `unknown queue '${queueName}'` });
  }

  try {
    const data = await retryFailedJob(queueName, jobId);
    return res.json({ data });
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    if (err instanceof JobNotFailedError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
});
