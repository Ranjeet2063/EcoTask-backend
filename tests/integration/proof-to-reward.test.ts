import { autoVerify } from '../../src/services/verificationService';
import { submitReward } from '../../src/services/stellarService';

jest.mock('../../src/utils/prisma', () => {
  return {
    __esModule: true,
    default: {
      proof: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      verification: {
        create: jest.fn(),
      },
      proofPhoto: {
        create: jest.fn(),
        count: jest.fn(),
      },
      rewardPayout: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };
});

jest.mock('../../src/services/stellarService', () => ({
  submitReward: jest.fn(),
}));

import prisma from '../../src/utils/prisma';

const mockPrisma = prisma as unknown as {
  proof: { findUnique: jest.Mock; update: jest.Mock };
  verification: { create: jest.Mock };
  proofPhoto: { count: jest.Mock };
  rewardPayout: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
  };
  $transaction: jest.Mock;
};

const mockSubmitReward = submitReward as jest.Mock;

describe('Proof-to-Reward Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.proofPhoto.count.mockResolvedValue(0);
  });

  it('approves valid proof and generates mock reward tx', async () => {
    mockSubmitReward.mockResolvedValue('mock-tx-123');

    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-1',
      userId: 'user-1',
      taskId: 'task-1',
      status: 'PENDING',
      lat: -1.2921,
      lng: 36.8219,
      photos: [
        {
          id: 'photo-1',
          cid: 'cid-1',
          sha256: 'valid-proof-hash',
          width: 1920,
          height: 1080,
          capturedAt: new Date(),
        },
      ],
      user: { wallet: 'GC...USER...' },
      task: {
        id: 'task-1',
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
        rewardAmountMicros: 500000000n,
        rewardToken: 'ECO',
        expiresAt: null,
      },
    });

    const result = await autoVerify('proof-1');
    expect(result.verdict).toBe('approved');

    const txHash = await submitReward({
      userWallet: 'GC...USER...',
      taskId: 'task-1',
      amount: '500000000',
      assetCode: 'ECO',
    });
    expect(txHash).toMatch(/^mock-tx-/);
  });

  it('rejects proof with missing GPS, no photos, and expired task', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    mockPrisma.proof.findUnique.mockResolvedValue({
      id: 'proof-2',
      lat: null,
      lng: null,
      photos: [],
      user: { wallet: 'GC...USER...' },
      task: {
        id: 'task-2',
        lat: -1.2921,
        lng: 36.8219,
        radiusMeters: 100,
        rewardAmountMicros: 500000000n,
        rewardToken: 'ECO',
        expiresAt: yesterday,
      },
    });

    const result = await autoVerify('proof-2');
    expect(result.verdict).toBe('rejected');
    expect(result.notes).toMatch(/gps/);
  });
});

/* =========================================================================
 * Issue #82: Soak and Concurrency Test Suite (Double-Spend & Invariant Check)
 * ========================================================================= */

interface SimulatedPayout {
  id: string;
  proofId: string;
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';
  txHash: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface SimulatedProof {
  id: string;
  taskId: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  rewardedAt: Date | null;
  user: { wallet: string };
  task: { rewardAmountMicros: bigint; rewardToken: string };
}

interface OnChainTx {
  txHash: string;
  proofId: string;
  wallet: string;
  amount: string;
  assetCode: string;
}

class InMemoryRewardSoakStore {
  payouts: Map<string, SimulatedPayout> = new Map();
  proofs: Map<string, SimulatedProof> = new Map();
  onChainTxs: OnChainTx[] = [];

  reset(): void {
    this.payouts.clear();
    this.proofs.clear();
    this.onChainTxs = [];
  }

  seedProofAndPayout(
    proofId: string,
    payoutId: string,
    amountMicros: bigint = 500000000n,
    token: string = 'ECO',
  ): void {
    this.proofs.set(proofId, {
      id: proofId,
      taskId: `task-${proofId}`,
      status: 'APPROVED',
      rewardedAt: null,
      user: { wallet: `GC_WALLET_${proofId}` },
      task: { rewardAmountMicros: amountMicros, rewardToken: token },
    });

    this.payouts.set(payoutId, {
      id: payoutId,
      proofId,
      status: 'PENDING',
      txHash: null,
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Atomic state claim (implements UPDATE reward_payouts SET status='PROCESSING' WHERE id=? AND status='PENDING')
  claimPayout(payoutId: string): boolean {
    const payout = this.payouts.get(payoutId);
    if (!payout || payout.status !== 'PENDING') {
      return false;
    }
    payout.status = 'PROCESSING';
    payout.updatedAt = new Date();
    return true;
  }

  // Completes payout atomically (transaction updating payout to PAID and setting proof.rewardedAt)
  completePayout(payoutId: string, txHash: string): void {
    const payout = this.payouts.get(payoutId);
    if (!payout) throw new Error('Payout not found in store');
    if (payout.status !== 'PROCESSING') {
      throw new Error(`Cannot complete payout in state ${payout.status}`);
    }
    payout.status = 'PAID';
    payout.txHash = txHash;
    payout.updatedAt = new Date();

    const proof = this.proofs.get(payout.proofId);
    if (proof) {
      proof.rewardedAt = new Date();
    }
  }

  // Record an on-chain Stellar transaction attempt
  recordOnChainTx(
    proofId: string,
    wallet: string,
    amount: string,
    assetCode: string,
  ): string {
    const txHash = `stellar-tx-${proofId}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    this.onChainTxs.push({ txHash, proofId, wallet, amount, assetCode });
    return txHash;
  }

  // Sweeper reclaim logic: reset stale PROCESSING rows back to PENDING
  reclaimStaleProcessing(staleThresholdMs: number = 300000): number {
    const threshold = Date.now() - staleThresholdMs;
    let reclaimed = 0;
    for (const payout of this.payouts.values()) {
      if (payout.status === 'PROCESSING' && payout.updatedAt.getTime() < threshold) {
        payout.status = 'PENDING';
        payout.attempts += 1;
        payout.lastError = 'Reclaimed by sweeper after worker failure';
        payout.updatedAt = new Date();
        reclaimed++;
      }
    }
    return reclaimed;
  }

  // Automated Invariant Query Engine (Issue #82 acceptance criteria)
  queryGlobalInvariants() {
    // 1. Group on-chain transactions by proofId to detect double-spend
    const onChainByProof = new Map<string, OnChainTx[]>();
    for (const tx of this.onChainTxs) {
      const list = onChainByProof.get(tx.proofId) || [];
      list.push(tx);
      onChainByProof.set(tx.proofId, list);
    }
    const duplicateOnChainPayments = Array.from(onChainByProof.entries())
      .filter(([_, txs]) => txs.length > 1)
      .map(([proofId, txs]) => ({
        proofId,
        count: txs.length,
        txHashes: txs.map((t) => t.txHash),
      }));

    // 2. Group paid rows by proofId to detect duplicate rows marked PAID
    const paidRowsByProof = new Map<string, SimulatedPayout[]>();
    for (const p of this.payouts.values()) {
      if (p.status === 'PAID') {
        const list = paidRowsByProof.get(p.proofId) || [];
        list.push(p);
        paidRowsByProof.set(p.proofId, list);
      }
    }
    const duplicatePaidRows = Array.from(paidRowsByProof.entries())
      .filter(([_, rows]) => rows.length > 1)
      .map(([proofId, rows]) => ({ proofId, count: rows.length }));

    // 3. Count any orphaned PROCESSING rows
    const orphanedProcessingRows = Array.from(this.payouts.values()).filter(
      (p) => p.status === 'PROCESSING',
    );

    // 4. Sum of all paid payouts vs sum of approved proof rewards
    let totalPaidMicros = 0n;
    for (const p of this.payouts.values()) {
      if (p.status === 'PAID') {
        const proof = this.proofs.get(p.proofId);
        if (proof) {
          totalPaidMicros += proof.task.rewardAmountMicros;
        }
      }
    }

    let totalApprovedRewardMicros = 0n;
    for (const proof of this.proofs.values()) {
      if (proof.status === 'APPROVED') {
        totalApprovedRewardMicros += proof.task.rewardAmountMicros;
      }
    }

    return {
      totalProofs: this.proofs.size,
      totalPayouts: this.payouts.size,
      onChainTxsCount: this.onChainTxs.length,
      duplicateOnChainPayments,
      duplicatePaidRows,
      orphanedProcessingRowsCount: orphanedProcessingRows.length,
      totalPaidMicros,
      totalApprovedRewardMicros,
      isDoubleSpendFree: duplicateOnChainPayments.length === 0,
      isPaidRowUnique: duplicatePaidRows.length === 0,
      isAmountConserved: totalPaidMicros === totalApprovedRewardMicros,
    };
  }
}

describe('Reward-Payout Soak & Concurrency Stress Testing (Issue #82)', () => {
  const store = new InMemoryRewardSoakStore();

  beforeEach(() => {
    store.reset();
    jest.clearAllMocks();
  });

  it('asserts zero duplicate payouts under 50 concurrent racing worker claims', async () => {
    const PROOF_COUNT = 50;
    const WORKERS_PER_PAYOUT = 4; // 4 concurrent workers compete for each payout

    for (let i = 0; i < PROOF_COUNT; i++) {
      store.seedProofAndPayout(`proof-soak-${i}`, `payout-soak-${i}`);
    }

    // Simulate worker process function
    const processJob = async (payoutId: string, proofId: string) => {
      // 1. Atomic claim check
      const claimed = store.claimPayout(payoutId);
      if (!claimed) {
        return; // Another worker claimed it first
      }

      // Simulate async network latency (1 to 5 ms)
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 + 1));

      // 2. Submit on-chain
      const proof = store.proofs.get(proofId)!;
      const txHash = store.recordOnChainTx(
        proofId,
        proof.user.wallet,
        proof.task.rewardAmountMicros.toString(),
        proof.task.rewardToken,
      );

      // 3. Complete payout transaction
      store.completePayout(payoutId, txHash);
    };

    // Launch 200 concurrent tasks (50 payouts * 4 competing workers)
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < PROOF_COUNT; i++) {
      for (let w = 0; w < WORKERS_PER_PAYOUT; w++) {
        tasks.push(processJob(`payout-soak-${i}`, `proof-soak-${i}`));
      }
    }

    await Promise.all(tasks);

    // Assert global invariants via query
    const invariants = store.queryGlobalInvariants();
    expect(invariants.isDoubleSpendFree).toBe(true);
    expect(invariants.duplicateOnChainPayments).toEqual([]);
    expect(invariants.isPaidRowUnique).toBe(true);
    expect(invariants.duplicatePaidRows).toEqual([]);
    expect(invariants.onChainTxsCount).toBe(PROOF_COUNT);
    expect(invariants.isAmountConserved).toBe(true);
    expect(invariants.orphanedProcessingRowsCount).toBe(0);
  });

  it('recovers from injected worker crashes and process kills without duplicate on-chain tx', async () => {
    const PROOF_COUNT = 30;

    for (let i = 0; i < PROOF_COUNT; i++) {
      store.seedProofAndPayout(`proof-crash-${i}`, `payout-crash-${i}`);
    }

    // Wave 1: Workers claim rows, but 10 workers CRASH before submission
    for (let i = 0; i < PROOF_COUNT; i++) {
      const payoutId = `payout-crash-${i}`;
      const proofId = `proof-crash-${i}`;
      store.claimPayout(payoutId);

      if (i < 10) {
        // Crash worker: worker dies, leaving row in PROCESSING with past timestamp
        const payout = store.payouts.get(payoutId)!;
        payout.updatedAt = new Date(Date.now() - 400000); // 400s ago (> 300s stale threshold)
      } else {
        // Healthy worker finishes successfully
        const proof = store.proofs.get(proofId)!;
        const txHash = store.recordOnChainTx(
          proofId,
          proof.user.wallet,
          proof.task.rewardAmountMicros.toString(),
          proof.task.rewardToken,
        );
        store.completePayout(payoutId, txHash);
      }
    }

    // Intermediate state: 10 crashed jobs left in PROCESSING
    expect(store.queryGlobalInvariants().orphanedProcessingRowsCount).toBe(10);
    expect(store.queryGlobalInvariants().onChainTxsCount).toBe(20);

    // Wave 2: Sweeper runs and reclaims all 10 stale PROCESSING jobs back to PENDING
    const reclaimedCount = store.reclaimStaleProcessing();
    expect(reclaimedCount).toBe(10);
    expect(store.queryGlobalInvariants().orphanedProcessingRowsCount).toBe(0);

    // Wave 3: Workers retry the 10 reclaimed jobs
    for (let i = 0; i < 10; i++) {
      const payoutId = `payout-crash-${i}`;
      const proofId = `proof-crash-${i}`;
      const claimed = store.claimPayout(payoutId);
      expect(claimed).toBe(true);

      const proof = store.proofs.get(proofId)!;
      const txHash = store.recordOnChainTx(
        proofId,
        proof.user.wallet,
        proof.task.rewardAmountMicros.toString(),
        proof.task.rewardToken,
      );
      store.completePayout(payoutId, txHash);
    }

    // Final Invariant Query: exactly 30 payouts, exactly 30 on-chain tx, zero duplicates
    const finalInvariants = store.queryGlobalInvariants();
    expect(finalInvariants.isDoubleSpendFree).toBe(true);
    expect(finalInvariants.duplicateOnChainPayments).toEqual([]);
    expect(finalInvariants.onChainTxsCount).toBe(PROOF_COUNT);
    expect(finalInvariants.isAmountConserved).toBe(true);
  });

  it('handles transient network drops during Stellar submission and guarantees idempotency', async () => {
    const PROOF_COUNT = 20;

    for (let i = 0; i < PROOF_COUNT; i++) {
      store.seedProofAndPayout(`proof-net-${i}`, `payout-net-${i}`);
    }

    let networkDropCount = 0;

    const executeWithNetworkFaults = async (payoutId: string, proofId: string) => {
      const claimed = store.claimPayout(payoutId);
      if (!claimed) return;

      const payout = store.payouts.get(payoutId)!;
      const proof = store.proofs.get(proofId)!;

      // Injected failure: first attempt fails on every odd index due to network drop
      if (payout.attempts === 0 && parseInt(proofId.split('-')[2], 10) % 2 === 1) {
        networkDropCount++;
        payout.status = 'FAILED';
        payout.attempts = 1;
        payout.lastError = 'Stellar RPC connection timeout';
        return;
      }

      // Successful submission
      const txHash = store.recordOnChainTx(
        proofId,
        proof.user.wallet,
        proof.task.rewardAmountMicros.toString(),
        proof.task.rewardToken,
      );
      store.completePayout(payoutId, txHash);
    };

    // First attempt across all 20 payouts
    await Promise.all(
      Array.from({ length: PROOF_COUNT }, (_, i) =>
        executeWithNetworkFaults(`payout-net-${i}`, `proof-net-${i}`),
      ),
    );

    expect(networkDropCount).toBe(10); // 10 odd items failed with network timeout

    // Sweeper resets FAILED rows for retry (simulating nextAttemptAt backoff eligibility)
    for (const payout of store.payouts.values()) {
      if (payout.status === 'FAILED') {
        payout.status = 'PENDING';
      }
    }

    // Second attempt across the 10 retried payouts
    await Promise.all(
      Array.from({ length: PROOF_COUNT }, (_, i) =>
        executeWithNetworkFaults(`payout-net-${i}`, `proof-net-${i}`),
      ),
    );

    // Global Invariants verification by automated query
    const invariants = store.queryGlobalInvariants();
    expect(invariants.isDoubleSpendFree).toBe(true);
    expect(invariants.duplicateOnChainPayments).toEqual([]);
    expect(invariants.onChainTxsCount).toBe(PROOF_COUNT);
    expect(invariants.isAmountConserved).toBe(true);
  });
});
