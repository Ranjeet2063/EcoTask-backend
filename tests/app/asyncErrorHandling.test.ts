import request from 'supertest';
import app from '../../src/app';

jest.mock('../../src/services/auditService', () => ({
  logAudit: jest.fn(),
}));

jest.mock('../../src/workers/verificationWorker', () => ({
  enqueueVerification: jest.fn(),
}));

jest.mock('../../src/services/rateLimitService', () => ({
  rateLimiter: {
    getClient: () => ({
      get: jest.fn().mockResolvedValue(null),
    }),
  },
}));

jest.mock('../../src/models/task', () => ({
  listTasks: jest.fn(),
  getTaskById: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
}));

jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

import * as taskModel from '../../src/models/task';

const mockTask = taskModel as unknown as {
  listTasks: jest.Mock;
  getTaskById: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('async route handler crash safety', () => {
  it('maps a rejected controller promise to a 500 without hanging the request', async () => {
    mockTask.getTaskById.mockRejectedValueOnce(new Error('db timeout'));

    const res = await request(app).get('/tasks/task-1');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('keeps serving requests on the same process after a handler rejects', async () => {
    mockTask.getTaskById.mockRejectedValueOnce(new Error('db timeout'));
    const failing = await request(app).get('/tasks/task-1');
    expect(failing.status).toBe(500);

    mockTask.getTaskById.mockResolvedValueOnce({ id: 'task-1', title: 'still alive' });
    const ok = await request(app).get('/tasks/task-1');

    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('still alive');
  });

  it('maps a Zod validation failure to 400 through the wrapped handler', async () => {
    const res = await request(app).get('/tasks').query({ minReward: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('maps a not-found controller result to 404 through the wrapped handler', async () => {
    mockTask.getTaskById.mockResolvedValueOnce(null);
    const res = await request(app).get('/tasks/missing');
    expect(res.status).toBe(404);
  });

  it('propagates a rejection from a list handler as 500 and recovers on the next call', async () => {
    mockTask.listTasks.mockRejectedValueOnce(new Error('connection reset'));
    const failing = await request(app).get('/tasks');
    expect(failing.status).toBe(500);

    mockTask.listTasks.mockResolvedValueOnce({ items: [], nextCursor: null });
    const ok = await request(app).get('/tasks');
    expect(ok.status).toBe(200);
  });
});
