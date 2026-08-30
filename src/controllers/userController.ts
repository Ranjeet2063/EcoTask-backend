import { Request, Response } from 'express';
import { getUserById, updateUser, getUserImpact } from '../models/user.js';
import { updateUserSchema } from '../utils/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const getUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await getUserById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'user not found' });
  }
  return res.json(user);
});

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const user = await getUserById(req.user!.userId);
  if (!user) {
    return res.status(404).json({ error: 'user not found' });
  }
  return res.json(user);
});

export const updateUserProfile = asyncHandler(async (req: Request, res: Response) => {
  if (req.params.id !== req.user?.userId) {
    return res.status(403).json({ error: "cannot update another user's profile" });
  }

  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const user = await updateUser(req.params.id, parsed.data);
  return res.json(user);
});

export const getImpact = asyncHandler(async (req: Request, res: Response) => {
  if (req.params.id !== req.user?.userId) {
    return res.status(403).json({ error: "cannot view another user's impact" });
  }

  const impact = await getUserImpact(req.params.id);
  return res.json(impact);
});
