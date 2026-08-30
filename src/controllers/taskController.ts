import { Request, Response } from 'express';
import * as taskModel from '../models/task.js';
import {
  createTaskSchema,
  updateTaskSchema,
  listTasksQuerySchema,
} from '../utils/validation.js';
import { InvalidCursorError } from '../utils/cursor.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { formatRewardAmount } from '../utils/reward.js';

export const listTasks = asyncHandler(async (req: Request, res: Response) => {
  const parsed = listTasksQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const { swLat, swLng, neLat, neLng, minReward, maxReward, ...rest } = parsed.data;
  const filters: taskModel.TaskFilters = {
    ...rest,
    ...(minReward != null
      ? { minRewardMicros: BigInt(Math.round(minReward * 10000000)) }
      : {}),
    ...(maxReward != null
      ? { maxRewardMicros: BigInt(Math.round(maxReward * 10000000)) }
      : {}),
    swLat,
    swLng,
    neLat,
    neLng,
  };

  try {
    const { items, nextCursor } = await taskModel.listTasks(filters);
    return res.json({ data: items.map(formatTaskForApi), nextCursor });
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      return res.status(400).json({ error: 'invalid cursor' });
    }
    throw err;
  }
});

export const getTask = asyncHandler(async (req: Request, res: Response) => {
  const task = await taskModel.getTaskById(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'task not found' });
  }
  return res.json(formatTaskForApi(task));
});

export const createTask = asyncHandler(async (req: Request, res: Response) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const { expiresAt, rewardAmount, ...rest } = parsed.data;
  const data: Parameters<typeof taskModel.createTask>[0] = {
    ...rest,
    rewardAmountMicros: BigInt(Math.round(rewardAmount * 10000000)),
    ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
  };

  const task = await taskModel.createTask(data);
  return res.status(201).json(formatTaskForApi(task));
});

export const updateTask = asyncHandler(async (req: Request, res: Response) => {
  const parsed = updateTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const existing = await taskModel.getTaskById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'task not found' });
  }

  const { expiresAt, rewardAmount, ...rest } = parsed.data;
  const data: Parameters<typeof taskModel.updateTask>[1] = {
    ...rest,
    ...(rewardAmount != null
      ? { rewardAmountMicros: BigInt(Math.round(rewardAmount * 10000000)) }
      : {}),
    ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
  };

  const task = await taskModel.updateTask(req.params.id, data);
  return res.json(formatTaskForApi(task));
});

export const deleteTask = asyncHandler(async (req: Request, res: Response) => {
  const existing = await taskModel.getTaskById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'task not found' });
  }

  await taskModel.deleteTask(req.params.id);
  return res.status(204).send();
});

function formatTaskForApi(
  task: Record<string, unknown> & { rewardAmountMicros?: bigint | null },
) {
  if (!task) return task;
  const { rewardAmountMicros, ...rest } = task;
  return {
    ...rest,
    ...(rewardAmountMicros != null
      ? { rewardAmount: formatRewardAmount(rewardAmountMicros) }
      : {}),
  };
}
