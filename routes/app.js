// app.js — mount after other middleware, before static handler
const healthRouter = require('./routes/health');

// No auth middleware on health routes — monitoring must always get through
app.use('/api/health', healthRouter);