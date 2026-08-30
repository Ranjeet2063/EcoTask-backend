import { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import prisma from '../utils/prisma.js';
import {
  submitProofSchema,
  listProofsQuerySchema,
  listPendingProofsQuerySchema,
  reviewProofSchema,
  MAX_PAGINATION_LIMIT,
} from '../utils/validation.js';
import { uploadToIPFS, removeFromIPFS } from '../services/ipfsService.js';
import { isWithinZone } from '../services/geoService.js';
import { hashFile, extractPhotoMetadata } from '../services/photoService.js';
import { notifyProofStatus } from '../services/notificationService.js';
import { enqueueVerification } from '../workers/verificationWorker.js';
import { claimCompletionSlot } from '../models/task.js';
import {
  MANUAL_REVIEW_VERIFIER_ID,
  NO_VALIDATORS_REVIEW_MARKER,
} from '../services/validatorService.js';
import logger from '../utils/logger.js';
import { cleanupUploadedFiles } from '../middleware/upload.js';
import { asyncHandler } from '../utils/asyncHandler.js';

type SubmissionEligibility =
  | { status: 404 | 400 | 403 | 409; error: string }
  | {
      status: 200;
      task: {
        id: string;
        lat: number;
        lng: number;
        radiusMeters: number;
      };
      claimId: string;
    };

async function checkSubmissionEligibility(
  tx: Prisma.TransactionClient,
  taskId: string,
  userId: string,
): Promise<SubmissionEligibility> {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task) {
    return { status: 404, error: 'task not found' };
  }
  if (task.status !== 'ACTIVE') {
    return { status: 400, error: 'task is not active' };
  }

  const claim = await tx.taskClaim.findFirst({
    where: {
      taskId,
      userId,
      status: 'active',
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!claim) {
    return {
      status: 403,
      error: 'active claim required to submit proof for this task',
    };
  }

  if (task.maxCompletions != null && task.completedCount >= task.maxCompletions) {
    return { status: 409, error: 'task has reached maximum completions' };
  }

  return { status: 200, task, claimId: claim.id };
}

export const submitProof = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    const files = req.files as Express.Multer.File[] | undefined;
    let filesCleaned = false;
    const cleanupFiles = async () => {
      if (filesCleaned) return;
      filesCleaned = true;
      await cleanupUploadedFiles(files);
    };
    // CIDs newly uploaded to IPFS during this request. IPFS lives outside the
    // DB transaction, so any path that ends without a committed proof (a
    // failed upload batch, a failed commit, or a failed post-commit enqueue)
    // must reclaim them instead of leaving them permanently orphaned.
    const uploadedCids: string[] = [];
    let cidsCleaned = false;
    const cleanupUploadedCids = async () => {
      if (cidsCleaned) return;
      cidsCleaned = true;
      if (!uploadedCids.length) return;
      await Promise.all(uploadedCids.map((cid) => removeFromIPFS(cid)));
    };
    const respond = async (status: number, body: unknown) => {
      await cleanupFiles();
      return res.status(status).json(body);
    };

    try {
      const parsed = submitProofSchema.safeParse(req.body);
      if (!parsed.success) {
        return respond(400, {
          error: 'invalid request body',
          details: parsed.error.flatten(),
        });
      }

      const { taskId, lat: bodyLat, lng: bodyLng, notes } = parsed.data;
      const userId = req.user!.userId;
      const preflight = await prisma.$transaction((tx) =>
        checkSubmissionEligibility(tx, taskId, userId),
      );
      if (preflight.status !== 200) {
        return respond(preflight.status, { error: preflight.error });
      }

      const preparedPhotos: Array<{
        cid: string;
        filename: string;
        sha256: string | null;
        width: number | null;
        height: number | null;
        capturedAt: Date | null;
        gpsLat: number | null;
        gpsLng: number | null;
      }> = [];
      try {
        // Hashing/metadata extraction is cheap and local; safe to run fully
        // in parallel before touching IPFS or the DB.
        const hashedFiles = await Promise.all(
          (files ?? []).map(async (file) => {
            const [sha256, metadata] = await Promise.all([
              hashFile(file.path),
              extractPhotoMetadata(file.path),
            ]);
            return { file, sha256, metadata };
          }),
        );

        // Content-address dedup: a photo whose bytes already exist under a
        // previously-committed CID reuses that CID instead of re-uploading.
        // proof_photos.sha256 is unique, so only the row that already owns a
        // hash may store it — a reused row's sha256 is left null.
        const hashes = [...new Set(hashedFiles.map((h) => h.sha256))];
        const existingPhotos = hashes.length
          ? await prisma.proofPhoto.findMany({
              where: { sha256: { in: hashes } },
              select: { sha256: true, cid: true },
            })
          : [];
        const cidByHash = new Map(existingPhotos.map((p) => [p.sha256 as string, p.cid]));

        // IPFS is external to the database transaction. Prepare every CID first;
        // if any preparation fails, no proof or photo row becomes visible, and
        // whatever was newly uploaded before the failure is reclaimed below.
        const photoResults = await Promise.allSettled(
          hashedFiles.map(async ({ file, sha256, metadata }) => {
            const existingCid = cidByHash.get(sha256);
            const cid = existingCid ?? (await uploadToIPFS(file.path, file.filename));
            if (!existingCid) uploadedCids.push(cid);
            return {
              cid,
              filename: file.originalname,
              sha256: existingCid ? null : sha256,
              width: metadata.width,
              height: metadata.height,
              capturedAt: metadata.capturedAt,
              gpsLat: metadata.gpsLat,
              gpsLng: metadata.gpsLng,
            };
          }),
        );

        for (const result of photoResults) {
          if (result.status === 'rejected') throw result.reason;
          preparedPhotos.push(result.value);
        }
      } catch (err) {
        logger.error('Proof photo processing failed', {
          err,
          taskId,
          userId,
          requestId: req.requestId,
        });
        await cleanupUploadedCids();
        return respond(500, { error: 'failed to process proof photos' });
      }

      let gpsFromPhoto: { lat: number; lng: number } | null = null;
      for (const photo of preparedPhotos) {
        if (photo.gpsLat != null && photo.gpsLng != null) {
          gpsFromPhoto = { lat: photo.gpsLat, lng: photo.gpsLng };
          break;
        }
      }

      let gpsMismatch = false;
      if (bodyLat != null && bodyLng != null && gpsFromPhoto) {
        gpsMismatch = !isWithinZone(
          gpsFromPhoto.lat,
          gpsFromPhoto.lng,
          preflight.task.lat,
          preflight.task.lng,
          preflight.task.radiusMeters / 1000,
        );
      }

      const effectiveLat = bodyLat ?? gpsFromPhoto?.lat;
      const effectiveLng = bodyLng ?? gpsFromPhoto?.lng;
      const commitResult = await prisma.$transaction(async (tx) => {
        const eligibility = await checkSubmissionEligibility(tx, taskId, userId);
        if (eligibility.status !== 200) return eligibility;

        const proof = await tx.proof.create({
          data: {
            userId,
            taskId,
            claimId: eligibility.claimId,
            status: 'PENDING',
            notes: gpsMismatch ? 'gps_photo_mismatch' : notes,
            ...(effectiveLat != null && effectiveLng != null
              ? { lat: effectiveLat, lng: effectiveLng }
              : {}),
            photos: {
              create: preparedPhotos.map(
                ({ gpsLat: _gpsLat, gpsLng: _gpsLng, ...photo }) => photo,
              ),
            },
          },
          include: { photos: true, verifications: true },
        });
        return { status: 201 as const, proof };
      });

      if (commitResult.status !== 201) {
        await cleanupUploadedCids();
        return respond(commitResult.status, { error: commitResult.error });
      }

      if (gpsMismatch) {
        logger.warn('Photo EXIF GPS is outside the task radius', {
          proofId: commitResult.proof.id,
          bodyLat,
          bodyLng,
          photoLat: gpsFromPhoto?.lat,
          photoLng: gpsFromPhoto?.lng,
          taskLat: preflight.task.lat,
          taskLng: preflight.task.lng,
          radiusMeters: preflight.task.radiusMeters,
        });
      }

      try {
        await enqueueVerification(commitResult.proof.id, req.requestId);
      } catch (err) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.proofPhoto.deleteMany({
              where: { proofId: commitResult.proof.id },
            });
            await tx.proof.delete({ where: { id: commitResult.proof.id } });
          });
        } catch (cleanupErr) {
          logger.error('Failed to roll back proof after verification enqueue error', {
            cleanupErr,
            proofId: commitResult.proof.id,
            requestId: req.requestId,
          });
        }
        await cleanupUploadedCids();
        throw err;
      }

      return respond(201, commitResult.proof);
    } catch (err) {
      await cleanupFiles();
      await cleanupUploadedCids();
      return next(err);
    } finally {
      await cleanupFiles();
    }
  },
);

export const getProof = asyncHandler(async (req: Request, res: Response) => {
  const proof = await prisma.proof.findUnique({
    where: { id: req.params.id },
    include: { photos: true, verifications: true },
  });

  if (!proof) {
    return res.status(404).json({ error: 'proof not found' });
  }

  if (proof.userId !== req.user!.userId && !(await isAdmin(req.user!.userId))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  return res.json(proof);
});

async function isAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return user?.role === 'admin';
}

export const listPendingProofs = asyncHandler(async (req: Request, res: Response) => {
  const parsed = listPendingProofsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const page = parsed.data.page;
  const limit = Math.min(parsed.data.limit, MAX_PAGINATION_LIMIT);
  const skip = (page - 1) * limit;

  const where: Prisma.ProofWhereInput = {
    status: parsed.data.status
      ? parsed.data.status
      : { in: ['PENDING' as const, 'VERIFYING' as const] },
    ...(parsed.data.reviewReason === 'no_validators'
      ? {
          verifications: {
            some: {
              verifierId: MANUAL_REVIEW_VERIFIER_ID,
              verdict: 'inconclusive',
              notes: { contains: NO_VALIDATORS_REVIEW_MARKER },
            },
          },
        }
      : {}),
  };

  const [proofs, total] = await Promise.all([
    prisma.proof.findMany({
      where,
      include: {
        photos: true,
        user: { select: { id: true, wallet: true, name: true } },
        task: { select: { id: true, title: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: limit,
    }),
    prisma.proof.count({ where }),
  ]);

  return res.json({
    data: proofs,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

export const reviewProof = asyncHandler(async (req: Request, res: Response) => {
  const parsed = reviewProofSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid request body', details: parsed.error.flatten() });
  }

  const proof = await prisma.proof.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, taskId: true, status: true },
  });
  if (!proof) {
    return res.status(404).json({ error: 'proof not found' });
  }
  if (proof.status === 'APPROVED' || proof.status === 'REJECTED') {
    return res.status(409).json({ error: 'proof already has a final verdict' });
  }

  const requestedStatus = parsed.data.verdict === 'approved' ? 'APPROVED' : 'REJECTED';

  const result = await prisma.$transaction(async (tx) => {
    let finalStatus: 'APPROVED' | 'REJECTED' = requestedStatus;
    let taskCompleted = false;
    let notes = parsed.data.notes;

    if (requestedStatus === 'APPROVED') {
      const slot = await claimCompletionSlot(tx, proof.taskId);
      if (!slot.claimed) {
        finalStatus = 'REJECTED';
        notes = `${notes ?? ''} [auto-rejected: task reached max completions]`.trim();
      } else {
        taskCompleted = slot.taskCompleted;
      }
    }

    const { count } = await tx.proof.updateMany({
      where: { id: proof.id, status: { in: ['PENDING', 'VERIFYING'] } },
      data: { status: finalStatus },
    });
    if (count === 0) return null;

    await tx.verification.create({
      data: {
        proofId: proof.id,
        verifierId: req.user!.userId,
        verdict: parsed.data.verdict,
        notes,
      },
    });

    if (req.requestId) {
      await notifyProofStatus(proof.userId, proof.id, finalStatus, tx, req.requestId);
    } else {
      await notifyProofStatus(proof.userId, proof.id, finalStatus, tx);
    }

    if (finalStatus === 'APPROVED') {
      await tx.rewardPayout.create({
        data: {
          proofId: proof.id,
          ...(req.requestId ? { requestId: req.requestId } : {}),
        },
      });
    }

    return { finalStatus, taskCompleted };
  });

  if (!result) {
    return res.status(409).json({ error: 'proof already has a final verdict' });
  }

  if (result.finalStatus === 'APPROVED' && result.taskCompleted) {
    logger.info('Task reached capacity and was completed', { taskId: proof.taskId });
  }

  const updated = await prisma.proof.findUnique({
    where: { id: proof.id },
    include: { photos: true, verifications: true },
  });
  return res.json(updated);
});

export const getUserProofs = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.userId;

  if (userId !== req.user!.userId && !(await isAdmin(req.user!.userId))) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const parsed = listProofsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid query parameters', details: parsed.error.flatten() });
  }

  const page = parsed.data.page;
  const limit = Math.min(parsed.data.limit, MAX_PAGINATION_LIMIT);
  const skip = (page - 1) * limit;

  const [proofs, total] = await Promise.all([
    prisma.proof.findMany({
      where: { userId },
      include: { photos: true, task: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.proof.count({ where: { userId } }),
  ]);

  return res.json({
    data: proofs,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});
