import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { formatRewardAmount } from '../utils/reward.js';

export const getLeaderboard = asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const period = (req.query.period as string) || 'all';

  let dateFilter: Date | undefined;
  if (period === 'week') {
    dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'month') {
    dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  const where = {
    status: 'APPROVED' as const,
    ...(dateFilter ? { createdAt: { gte: dateFilter } } : {}),
  };

  const proofs = await prisma.proof.findMany({
    where,
    select: { userId: true, task: { select: { rewardAmountMicros: true } } },
  });

  const aggregates = new Map<string, { count: number; rewardMicros: bigint }>();
  for (const proof of proofs) {
    const agg = aggregates.get(proof.userId) ?? { count: 0, rewardMicros: 0n };
    agg.count += 1;
    agg.rewardMicros += proof.task.rewardAmountMicros;
    aggregates.set(proof.userId, agg);
  }

  const ranked = [...aggregates.entries()].sort(
    (a, b) => b[1].count - a[1].count || Number(b[1].rewardMicros - a[1].rewardMicros),
  );

  const userIds = ranked.slice(0, limit).map(([userId]) => userId);
  const users =
    userIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, wallet: true, name: true, avatarUrl: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u]));

  const leaderboard = ranked.slice(0, limit).map(([userId, agg], index) => ({
    rank: index + 1,
    userId,
    wallet: userMap.get(userId)?.wallet || '',
    name: userMap.get(userId)?.name || null,
    avatarUrl: userMap.get(userId)?.avatarUrl || null,
    approvedProofs: agg.count,
    totalReward: formatRewardAmount(agg.rewardMicros),
  }));

  res.json({ leaderboard, period });
});
