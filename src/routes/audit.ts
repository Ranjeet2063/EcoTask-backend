import { Router } from 'express';
import { getAuditLogs } from '../services/auditService.js';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.get(
  '/',
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const result = await getAuditLogs({
      userId: req.query.userId as string | undefined,
      resource: req.query.resource as string | undefined,
      resourceId: req.query.resourceId as string | undefined,
      limit: parseInt(req.query.limit as string) || 50,
      offset: parseInt(req.query.offset as string) || 0,
    });
    res.json(result);
  }),
);

export default router;
