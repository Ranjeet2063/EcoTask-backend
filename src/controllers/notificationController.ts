import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import {
  listNotificationsQuerySchema,
  updateNotificationPrefsSchema,
  MAX_PAGINATION_LIMIT,
} from '../utils/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const listNotifications = asyncHandler(async (req: Request, res: Response) => {
  const parsed = listNotificationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const userId = req.user!.userId;
  const page = parsed.data.page;
  const limit = Math.min(parsed.data.limit, MAX_PAGINATION_LIMIT);
  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: { userId } }),
  ]);

  return res.json({
    data: notifications,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

export const getUnreadCount = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const count = await prisma.notification.count({ where: { userId, readAt: null } });
  return res.json({ count });
});

export const markNotificationRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const notification = await prisma.notification.findUnique({
    where: { id: req.params.id },
  });
  if (!notification || notification.userId !== userId) {
    return res.status(404).json({ error: 'notification not found' });
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: notification.readAt ?? new Date() },
  });
  return res.json(updated);
});

export const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return res.json({ updated: result.count });
});

export const updateNotificationPrefs = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = updateNotificationPrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid request body', details: parsed.error.flatten() });
    }

    const user = await prisma.user.update({
      where: { id: req.user!.userId },
      data: parsed.data,
      select: { id: true, email: true, webhookUrl: true },
    });

    return res.json({ preferences: user });
  },
);
