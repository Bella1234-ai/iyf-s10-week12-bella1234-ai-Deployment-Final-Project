// server.js — clean, no inline static logic
'use strict';

const express             = require('express');
const { validateEnv }     = require('./config/validateEnv');
const { applyCors }       = require('./config/cors');
const { serveStatic }     = require('./config/static');

validateEnv();

const app = express();

applyCors(app);
app.use(express.json());

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/health', require('./routes/health'));
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/posts',  require('./routes/posts'));

// ── Static + SPA (must be last) ───────────────────────────────────────────────
serveStatic(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`[server] ${process.env.NODE_ENV} · http://localhost:${PORT}`)
);