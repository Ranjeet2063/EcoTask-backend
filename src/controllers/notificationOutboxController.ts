import { Request, Response } from 'express';
import { listDeadLetteredNotifications } from '../services/notificationOutboxService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const MAX_LIMIT = 200;

export const getDeadLetteredNotifications = asyncHandler(
  async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, MAX_LIMIT);
    const offset = parseInt(req.query.offset as string) || 0;

    const { items, total } = await listDeadLetteredNotifications(limit, offset);

    return res.json({
      data: items,
      meta: { limit, offset, total },
    });
  },
);
