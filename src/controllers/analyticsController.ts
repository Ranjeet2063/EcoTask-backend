import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { formatRewardAmount } from '../utils/reward.js';

export const getPlatformAnalytics = asyncHandler(async (_req: Request, res: Response) => {
  const [totalTasks, activeTasks, totalUsers, totalProofs, approvedStats] =
    await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count(),
      prisma.proof.count(),
      prisma.$queryRaw<Array<{ count: number; total_reward_micros: bigint }>>`
        SELECT COUNT(*)::int AS count,
               COALESCE(SUM("reward_amount_micros"), 0)::bigint AS total_reward_micros
        FROM "proofs" p
        JOIN "tasks" t ON p."task_id" = t.id
        WHERE p.status = 'APPROVED'
      `,
    ]);

  const approvedCount = approvedStats[0]?.count ?? 0;
  const totalRewardPaidMicros = approvedStats[0]?.total_reward_micros ?? 0n;
  const totalRewardPaid = formatRewardAmount(totalRewardPaidMicros);

  return res.json({
    totals: {
      tasks: totalTasks,
      activeTasks,
      users: totalUsers,
      proofs: totalProofs,
      approvedProofs: approvedCount,
      totalRewardPaid,
    },
    timestamp: new Date().toISOString(),
  });
});

export const getTrends = asyncHandler(async (req: Request, res: Response) => {
  const requestedDays = parseInt(req.query.days as string) || 30;
  const days = Math.min(Math.max(requestedDays, 1), 365);
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.$queryRaw<
    Array<{ day: Date; count: number; reward_micros: bigint }>
  >`
    SELECT DATE_TRUNC('day', p."created_at")::date AS day,
           COUNT(*)::int AS count,
           COALESCE(SUM(t."reward_amount_micros"), 0)::bigint AS reward_micros
    FROM "proofs" p
    JOIN "tasks" t ON p."task_id" = t.id
    WHERE p.status = 'APPROVED'
      AND p."created_at" >= ${from}
    GROUP BY day
    ORDER BY day ASC
  `;

  return res.json({
    days,
    points: rows.map((r: { day: Date; count: number; reward_micros: bigint }) => ({
      day: r.day.toISOString().slice(0, 10),
      approvedProofs: Number(r.count),
      totalReward: formatRewardAmount(r.reward_micros),
    })),
    timestamp: new Date().toISOString(),
  });
});
