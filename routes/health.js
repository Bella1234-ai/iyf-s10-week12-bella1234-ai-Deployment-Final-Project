// routes/health.js
'use strict';

const express  = require('express');
const mongoose = require('mongoose');
const os       = require('os');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────────────────
const MONGOOSE_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

const STATUS = {
  OK:       'ok',
  DEGRADED: 'degraded',   // running but some checks failed
  DOWN:     'down',       // critical failure — return 503
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const bytes = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const ms    = (hrDiff) => `${((hrDiff[0] * 1e9 + hrDiff[1]) / 1e6).toFixed(2)}ms`;

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Database — measures round-trip latency with a lightweight adminCommand.
 * Falls back gracefully if the DB is mid-reconnect.
 */
async function checkDatabase() {
  const start = process.hrtime();
  try {
    const state = mongoose.connection.readyState;
    if (state !== 1) {
      return {
        status: STATUS.DOWN,
        state:  MONGOOSE_STATES[state] ?? 'unknown',
        latency: null,
      };
    }
    // ping is lighter than {ping:1} aggregate — works on all MongoDB tiers
    await mongoose.connection.db.admin().ping();
    return {
      status:  STATUS.OK,
      state:   'connected',
      latency: ms(process.hrtime(start)),
    };
  } catch (err) {
    return {
      status:  STATUS.DOWN,
      state:   'error',
      latency: ms(process.hrtime(start)),
      error:   err.message,
    };
  }
}

/**
 * Memory — flags when heap usage exceeds a configurable threshold.
 */
function checkMemory(warnThresholdMb = 450) {
  const mem    = process.memoryUsage();
  const heapMb = mem.heapUsed / 1024 / 1024;
  return {
    status:     heapMb > warnThresholdMb ? STATUS.DEGRADED : STATUS.OK,
    heapUsed:   bytes(mem.heapUsed),
    heapTotal:  bytes(mem.heapTotal),
    rss:        bytes(mem.rss),
    external:   bytes(mem.external),
    threshold:  `${warnThresholdMb} MB`,
  };
}

/**
 * CPU — 1-second load average (Unix) or 'unavailable' (Windows).
 */
function checkCpu() {
  const load = os.loadavg();     // [1m, 5m, 15m]
  const cpus = os.cpus().length;
  const normalized = load[0] / cpus; // > 1.0 means overloaded per core
  return {
    status:        normalized > 0.9 ? STATUS.DEGRADED : STATUS.OK,
    loadAvg:       { '1m': load[0].toFixed(2), '5m': load[1].toFixed(2), '15m': load[2].toFixed(2) },
    cpuCount:      cpus,
    normalizedLoad: normalized.toFixed(2),
  };
}

/**
 * Disk — skipped on Windows where statfs is unavailable.
 */
async function checkDisk() {
  if (process.platform === 'win32') return { status: STATUS.OK, note: 'unavailable on Windows' };
  try {
    const { execFile } = require('child_process');
    const util = require('util');
    const execFileAsync = util.promisify(execFile);
    const { stdout } = await execFileAsync('df', ['-k', '/']);
    const line   = stdout.trim().split('\n')[1].split(/\s+/);
    const usePct = parseInt(line[4], 10);
    return {
      status:    usePct > 90 ? STATUS.DEGRADED : STATUS.OK,
      used:      `${line[2]} KB`,
      available: `${line[3]} KB`,
      usePercent: `${usePct}%`,
    };
  } catch {
    return { status: STATUS.OK, note: 'disk check unavailable' };
  }
}

/**
 * Process — general runtime info; always OK (informational only).
 */
function checkProcess() {
  const uptimeSec = process.uptime();
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = Math.floor(uptimeSec % 60);
  return {
    status:   STATUS.OK,
    pid:      process.pid,
    uptime:   `${h}h ${m}m ${s}s`,
    uptimeSec: Math.floor(uptimeSec),
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    env:      process.env.NODE_ENV || 'development',
  };
}

// ── Aggregate health ──────────────────────────────────────────────────────────
async function runChecks(opts = {}) {
  const start = process.hrtime();

  const [database, memory, cpu, disk] = await Promise.allSettled([
    checkDatabase(),
    Promise.resolve(checkMemory(opts.memThresholdMb)),
    Promise.resolve(checkCpu()),
    checkDisk(),
  ]).then((results) =>
    results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { status: STATUS.DOWN, error: r.reason?.message }
    )
  );

  const checks = { database, memory, cpu, disk, process: checkProcess() };

  // Overall status: any DOWN → down; any DEGRADED → degraded; else ok
  const statuses = Object.values(checks).map((c) => c.status);
  const overall = statuses.includes(STATUS.DOWN)
    ? STATUS.DOWN
    : statuses.includes(STATUS.DEGRADED)
      ? STATUS.DEGRADED
      : STATUS.OK;

  return {
    status:       overall,
    version:      process.env.npm_package_version || '0.0.0',
    timestamp:    new Date().toISOString(),
    responseTime: ms(process.hrtime(start)),
    checks,
  };
}

// ── Route: GET /api/health  (full report — internal / ops use) ────────────────
router.get('/', async (req, res) => {
  try {
    const report   = await runChecks();
    const httpCode = report.status === STATUS.DOWN ? 503
                   : report.status === STATUS.DEGRADED ? 200
                   : 200;

    // Prevent caching of health responses
    res.setHeader('Cache-Control', 'no-store');
    res.status(httpCode).json(report);
  } catch (err) {
    res.status(503).json({
      status:    STATUS.DOWN,
      timestamp: new Date().toISOString(),
      error:     err.message,
    });
  }
});

// ── Route: GET /api/health/live  (liveness — is the process alive?) ───────────
// Load balancers / k8s use this to decide whether to restart the container.
router.get('/live', (_, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: STATUS.OK, timestamp: new Date().toISOString() });
});

// ── Route: GET /api/health/ready  (readiness — can it serve traffic?) ─────────
// k8s uses this to decide whether to send traffic. Fails until DB is ready.
router.get('/ready', async (_, res) => {
  const db = await checkDatabase();
  const ready = db.status === STATUS.OK;
  res.setHeader('Cache-Control', 'no-store');
  res.status(ready ? 200 : 503).json({
    status:    ready ? STATUS.OK : STATUS.DOWN,
    timestamp: new Date().toISOString(),
    checks:    { database: db },
  });
});

// ── Route: GET /api/health/metrics  (numeric — Prometheus-style scraping) ─────
router.get('/metrics', (_, res) => {
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const lines = [
    '# HELP process_heap_bytes Heap memory used',
    '# TYPE process_heap_bytes gauge',
    `process_heap_bytes ${mem.heapUsed}`,
    '# HELP process_rss_bytes Resident set size',
    '# TYPE process_rss_bytes gauge',
    `process_rss_bytes ${mem.rss}`,
    '# HELP process_uptime_seconds Process uptime',
    '# TYPE process_uptime_seconds counter',
    `process_uptime_seconds ${Math.floor(process.uptime())}`,
    '# HELP node_load_avg_1m 1-minute load average',
    '# TYPE node_load_avg_1m gauge',
    `node_load_avg_1m ${load[0].toFixed(4)}`,
    '# HELP mongodb_connected MongoDB connection state (1=connected)',
    '# TYPE mongodb_connected gauge',
    `mongodb_connected ${mongoose.connection.readyState === 1 ? 1 : 0}`,
  ];
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.setHeader('Cache-Control', 'no-store');
  res.send(lines.join('\n') + '\n');
});

module.exports = router;