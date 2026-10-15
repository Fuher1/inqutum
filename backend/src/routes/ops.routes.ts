import { Router } from 'express';
import type { JobStore } from '../jobs/job-types';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { metrics } from '../observability/telemetry';
import { buildOpsHealthReport } from '../ops/ops-health';
import { requireAdmin } from './jobs.routes';
import {
  ImpersonationService,
  impersonationService,
  IMPERSONATION_PERMISSIONS,
  type ImpersonationPermission,
} from '../audit/impersonation';
import { stellarPublicKeySchema } from '../utils/validation';
import { simulatePolicyChange } from '../domain/policy-simulation';
import { loadPolicy } from '../domain/policy';
import { staleProjectionService } from '../ops/stale-projections.service';
import { defaultSearchIndex } from '../services/search-index.service';
import { SyntheticJourneyMonitor } from '../ops/synthetic-journey-monitor';
import { verifySnapshotRestore } from '../db/snapshot-restore-verification';

export interface OpsRouterOptions {
  storage: InvoiceStorage;
  jobs?: JobStore;
  /** Same bearer token as /jobs (JOBS_ADMIN_TOKEN). When empty, the route is disabled (403). */
  adminToken?: string;
  /** Overridable for tests. */
  impersonation?: ImpersonationService;
}

const durationOf = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Mount under `/api`.
 *   GET  /ops/health  maintainer summary of unresolved failures and drift
 *
 *   POST /ops/impersonation           start a scoped, time-limited session
 *   POST /ops/impersonation/end       close a session
 *   GET  /ops/impersonation           list sessions / read the banner state
 */
export function createOpsRouter(options: OpsRouterOptions): Router {
  const router = Router();
  const impersonation = options.impersonation ?? impersonationService;
  const admin = requireAdmin(options.adminToken);

  router.get('/ops/health', admin, async (req, res, next) => {
    try {
      const report = await buildOpsHealthReport({
        storage: options.storage,
        jobs: options.jobs,
        recentLogs: () => metrics.getRecentLogs(200),
      });
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Policy simulation preview before committing changes (Issue #267)
  router.post('/ops/policy/simulate', admin, async (req, res, next) => {
    try {
      const invoices = options.storage.getAllInvoices ? await options.storage.getAllInvoices() : [];
      const current = loadPolicy();
      const simulation = simulatePolicyChange(invoices, req.body?.proposedPolicy || {}, current);
      res.json({ success: true, data: simulation, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Stale projection detection and repair recommendations (Issue #269)
  router.get('/ops/stale-projections/detect', admin, async (req, res, next) => {
    try {
      const report = await staleProjectionService.detect(options.storage);
      res.json({ success: true, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ops/stale-projections/repair', admin, async (req, res, next) => {
    try {
      const mode = req.body?.mode === 'queued' ? 'queued' : 'immediate';
      const evidence = await staleProjectionService.repair(options.storage, defaultSearchIndex, { mode });
      res.json({ success: true, data: evidence, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Synthetic journey monitor for critical workflow (Issue #264)
  router.post('/ops/synthetic-journey/run', admin, async (req, res, next) => {
    try {
      const monitor = new SyntheticJourneyMonitor({ storage: options.storage });
      const report = await monitor.runJourney();
      res.status(report.success ? 200 : 503).json({ success: report.success, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // Snapshot restore verification for critical data and derived indexes (Issue #263)
  router.post('/ops/snapshot-restore/verify', admin, async (req, res, next) => {
    try {
      const snapshotPkg = req.body?.snapshotPackage || {
        invoices: options.storage.getAllInvoices ? await options.storage.getAllInvoices() : [],
        metadata: { exportedAt: new Date().toISOString(), source: 'api' },
      };
      const report = verifySnapshotRestore(snapshotPkg);
      res.status(report.ok ? 200 : 422).json({ success: report.ok, data: report, correlationId: req.correlationId });
    } catch (err) {
      next(err);
    }
  });

  // -- Scoped maintainer impersonation (#76) --------------------------------

  router.get('/ops/impersonation', admin, (req, res) => {
    const maintainerId = String(req.query.maintainerId ?? '');
    const includeClosed = req.query.includeClosed !== 'false';
    res.json({
      success: true,
      data: {
        indicator: maintainerId
          ? impersonation.indicator(maintainerId)
          : { active: false },
        sessions: impersonation.listSessions(includeClosed),
        permissions: IMPERSONATION_PERMISSIONS,
      },
      correlationId: req.correlationId,
    });
  });

  router.post('/ops/impersonation', admin, (req, res) => {
    const target = stellarPublicKeySchema.safeParse(req.body?.targetId);
    if (!target.success) {
      return res.status(400).json({
        success: false,
        code: 'TARGET_INVALID',
        error: 'targetId must be a valid Stellar public key',
        correlationId: req.correlationId,
      });
    }

    const permissions = (req.body?.permissions ?? ['read']) as ImpersonationPermission[];

    try {
      const session = impersonation.startSession({
        maintainerId: String(req.body?.maintainerId ?? ''),
        targetId: target.data,
        permissions,
        reason: String(req.body?.reason ?? ''),
        durationMs: durationOf(req.body?.durationMs),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      return res.status(201).json({
        success: true,
        data: { session, indicator: impersonation.indicator(session.maintainerId) },
        correlationId: req.correlationId,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        code: 'IMPERSONATION_REJECTED',
        error: err instanceof Error ? err.message : 'Impersonation session rejected',
        correlationId: req.correlationId,
      });
    }
  });

  router.post('/ops/impersonation/end', admin, (req, res) => {
    const sessionId = String(req.body?.sessionId ?? '');
    const closed = impersonation.endSession(
      sessionId,
      req.body?.maintainerId ? String(req.body.maintainerId) : undefined,
    );
    if (!closed) {
      return res.status(404).json({
        success: false,
        code: 'SESSION_NOT_FOUND',
        error: 'No active session with that id for this maintainer',
        correlationId: req.correlationId,
      });
    }
    return res.json({ success: true, data: { sessionId, closed: true }, correlationId: req.correlationId });
  });

  return router;
}

export default createOpsRouter;
