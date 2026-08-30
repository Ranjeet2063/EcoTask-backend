import request from 'supertest';

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
  listTasks: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  getTaskById: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
}));

const loggerErrorMock = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => loggerErrorMock(...args),
  },
}));

const prismaDisconnectMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/utils/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    $disconnect: (...args: unknown[]) => prismaDisconnectMock(...args),
  },
}));

describe('process-level fatal error handlers', () => {
  let app: import('express').Express;
  let processExitSpy: jest.SpyInstance;
  const registeredListeners: Array<{
    event: 'unhandledRejection' | 'uncaughtException';
    fn: (...args: unknown[]) => void;
  }> = [];

  beforeAll(() => {
    const originalOn = process.on.bind(process);
    const onSpy = jest.spyOn(process, 'on').mockImplementation((event, fn) => {
      if (event === 'unhandledRejection' || event === 'uncaughtException') {
        registeredListeners.push({ event, fn: fn as (...args: unknown[]) => void });
      }
      return originalOn(event, fn as never);
    });

    // Loaded after the mocks above (and while the process.on spy is active)
    // so app.ts (and everything it pulls in) observes the mocked
    // logger/prisma/workers and its listener registration is captured.
    // A synchronous require() inside isolateModules is used deliberately:
    // native dynamic import() is rejected by Jest's CJS runtime here
    // ("without --experimental-vm-modules"), and require() lets this run
    // (and finish) inside the same synchronous beforeAll tick as the spy.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      app = (require('../../src/app') as { default: import('express').Express }).default;
    });

    onSpy.mockRestore();
  });

  afterAll(() => {
    // Avoid leaking these listeners into other test files that share this
    // Jest worker process.
    for (const { event, fn } of registeredListeners) {
      process.removeListener(event, fn as never);
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('logs an unhandledRejection with full context and does not kill the process', async () => {
    const err = new Error('detached rejection from a fire-and-forget promise');
    const rejectedPromise = Promise.reject(err);
    rejectedPromise.catch(() => {});

    process.emit('unhandledRejection', err, rejectedPromise);

    // Let the async gracefulShutdown path (prisma.$disconnect etc.) settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Unhandled promise rejection',
      expect.objectContaining({ reason: err, pid: process.pid }),
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('logs an uncaughtException with full context and does not kill the process', async () => {
    const err = new Error('escaped synchronous throw');

    process.emit('uncaughtException', err, 'uncaughtException');

    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Uncaught exception',
      expect.objectContaining({ err, pid: process.pid }),
    );
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('still serves requests on the same process after a detached rejection fires mid-flight', async () => {
    const inFlight = request(app).get('/tasks');

    process.emit(
      'unhandledRejection',
      new Error('unrelated background failure'),
      Promise.reject('unrelated').catch(() => {}),
    );

    const res = await inFlight;
    expect(res.status).toBe(200);

    const followUp = await request(app).get('/tasks');
    expect(followUp.status).toBe(200);
  });

  it('exercises the graceful-shutdown path (prisma disconnect) instead of a hard crash', async () => {
    process.emit(
      'uncaughtException',
      new Error('trigger shutdown path'),
      'uncaughtException',
    );

    await new Promise((resolve) => setImmediate(resolve));

    expect(prismaDisconnectMock).toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
