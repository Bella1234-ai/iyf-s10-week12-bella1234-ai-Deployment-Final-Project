// config/static.js  ← replaces the inline server.js block
'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const express = require('express');

// ── Config ────────────────────────────────────────────────────────────────────
const DIST_DIR   = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(__dirname, '..', 'frontend', 'dist');

const INDEX_HTML = path.join(DIST_DIR, 'index.html');

// Hashed asset filenames (e.g. main.a1b2c3d4.js) → cache forever
const HASHED = /\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpe?g|svg|ico|webp)$/i;

// Routes that should never fall through to the SPA
const SERVER_PATHS = ['/api/', '/health', '/metrics'];

// ── Cache-control per file type ───────────────────────────────────────────────
const setCacheHeaders = (res, filePath) => {
  if (HASHED.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
};

// ── Security headers ──────────────────────────────────────────────────────────
const securityHeaders = (_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('Referrer-Policy',        'strict-origin-when-cross-origin');
  next();
};

// ── ETag for index.html (recomputed on file change) ───────────────────────────
let _etag = null, _mtime = null;
const getEtag = () => {
  try {
    const { mtimeMs } = fs.statSync(INDEX_HTML);
    if (mtimeMs !== _mtime) {
      _etag  = `"${crypto.createHash('md5').update(fs.readFileSync(INDEX_HTML)).digest('hex')}"`;
      _mtime = mtimeMs;
    }
    return _etag;
  } catch { return null; }
};

// ── SPA fallback ──────────────────────────────────────────────────────────────
const spaFallback = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (SERVER_PATHS.some((p) => req.path.startsWith(p)))  return next();
  if (req.headers.upgrade === 'websocket')               return next();

  if (!fs.existsSync(INDEX_HTML)) {
    return res.status(503).json({
      error: 'Frontend not built — run `node scripts/build.js`',
    });
  }

  const etag = getEtag();
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
  }

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(INDEX_HTML, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'Failed to serve app.' });
  });
};

// ── Mount helper ──────────────────────────────────────────────────────────────
const serveStatic = (app) => {
  const shouldServe =
    process.env.NODE_ENV === 'production' ||
    process.env.FORCE_STATIC === 'true';

  if (!shouldServe) {
    console.log('[static] Skipped (non-production). Set FORCE_STATIC=true to override.');
    return;
  }
  if (!fs.existsSync(DIST_DIR)) {
    console.warn(`[static] dist not found: ${DIST_DIR} — run \`node scripts/build.js\``);
    return;
  }

  console.log(`[static] Serving from ${DIST_DIR}`);

  app.use(securityHeaders);
  app.use(express.static(DIST_DIR, {
    index:       false,       // spaFallback owns index.html
    etag:        true,
    lastModified: true,
    setHeaders:  setCacheHeaders,
  }));
  app.use(spaFallback);
};

module.exports = { serveStatic };