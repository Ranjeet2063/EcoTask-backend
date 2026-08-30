import { Request, Response } from 'express';
import prisma from '../utils/prisma.js';
import { castValidatorVoteSchema } from '../utils/validation.js';
import { listPendingReviews, castVote } from '../services/validatorService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const listValidators = asyncHandler(async (_req: Request, res: Response) => {
  const validators = await prisma.user.findMany({
    where: { role: 'validator' },
    select: {
      id: true,
      wallet: true,
      name: true,
      validatorReputation: true,
      reviewCount: true,
      createdAt: true,
    },
    orderBy: [{ validatorReputation: 'desc' }, { reviewCount: 'desc' }],
  });

  return res.json({ data: validators, count: validators.length });
});

export const activateValidator = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, role: true },
  });
  if (!user) {
    return res.status(404).json({ error: 'user not found' });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: 'validator' },
    select: { id: true, wallet: true, role: true },
  });

  return res.json(updated);
});

export const deactivateValidator = asyncHandler(async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.userId },
    select: { id: true, role: true },
  });
  if (!user) {
    return res.status(404).json({ error: 'user not found' });
  }
  if (user.role === 'admin') {
    return res.status(400).json({ error: 'cannot demote an admin user' });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: 'user' },
    select: { id: true, wallet: true, role: true },
  });

  return res.json(updated);
});

export const getMyReviews = asyncHandler(async (req: Request, res: Response) => {
  const reviews = await listPendingReviews(req.user!.userId);
  return res.json({ data: reviews, count: reviews.length });
});

export const submitReview = asyncHandler(async (req: Request, res: Response) => {
  const parsed = castValidatorVoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  try {
    const outcome = await castVote(
      req.params.proofId,
      req.user!.userId,
      parsed.data.verdict,
      parsed.data.notes,
      req.requestId,
    );
    return res.json({ outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    const conflict = /already cast|awaiting validator review/.test(message);
    return res.status(conflict ? 409 : 404).json({ error: message });
  }
});
