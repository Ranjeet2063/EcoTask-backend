import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const CLAIM_DURATION_MS = 24 * 60 * 60 * 1000;

export const claimTask = asyncHandler(async (req: Request, res: Response) => {
  const { id: taskId } = req.params;
  const userId = req.user!.userId;

  const result = await prisma.$transaction(async (tx) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) {
      return { status: 404 as const, body: { error: 'task not found' } };
    }
    if (task.status !== 'ACTIVE') {
      return { status: 400 as const, body: { error: 'task is not active' } };
    }

    const existingClaim = await tx.taskClaim.findUnique({
      where: { taskId_userId: { taskId, userId } },
    });

    if (
      existingClaim &&
      existingClaim.status === 'active' &&
      existingClaim.expiresAt > new Date()
    ) {
      return { status: 409 as const, body: { error: 'task already claimed by you' } };
    }

    if (existingClaim) {
      const updated = await tx.taskClaim.update({
        where: { id: existingClaim.id },
        data: {
          status: 'active',
          claimedAt: new Date(),
          expiresAt: new Date(Date.now() + CLAIM_DURATION_MS),
        },
      });
      return { status: 200 as const, body: { claim: updated } };
    }

    const claim = await tx.taskClaim.create({
      data: {
        userId,
        taskId,
        status: 'active',
        expiresAt: new Date(Date.now() + CLAIM_DURATION_MS),
      },
    });

    return { status: 201 as const, body: { claim } };
  });

  return res.status(result.status).json(result.body);
});

export const releaseClaim = asyncHandler(async (req: Request, res: Response) => {
  const { id: taskId } = req.params;
  const userId = req.user!.userId;

  const claim = await prisma.taskClaim.findUnique({
    where: { taskId_userId: { taskId, userId } },
  });

  if (!claim || claim.status !== 'active') {
    return res.status(404).json({ error: 'no active claim found' });
  }

  await prisma.taskClaim.update({
    where: { id: claim.id },
    data: { status: 'released' },
  });

  return res.status(204).send();
});

export const getTaskClaims = asyncHandler(async (req: Request, res: Response) => {
  const { id: taskId } = req.params;

  const claims = await prisma.taskClaim.findMany({
    where: {
      taskId,
      status: 'active',
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { id: true, wallet: true, name: true } } },
  });

  return res.json({ claims });
});
