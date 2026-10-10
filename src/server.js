require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const helmet = require('helmet');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const patientRoutes = require('./routes/patients');
const prescriptionRoutes = require('./routes/prescriptions');
const adminRoutes = require('./routes/admin');
const visitsRoutes = require('./routes/visits');
const pharmacyRoutes = require('./routes/pharmacy');
const dashboardRoutes = require('./routes/dashboard');
const reportsRoutes = require('./routes/reports');
const workflowRoutes = require('./routes/workflow');
const laboratoryRoutes = require('./routes/laboratory');
const { requireAuth, requirePermission } = require('./middleware/auth');

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 characters.');
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const PgSessionStore = connectPgSimple(session);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

if (isProduction) {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (!req.secure) {
      return res.status(400).json({ error: 'HTTPS is required.' });
    }
    return next();
  });
}

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '32kb', strict: true }));
app.use(session({
  name: 'kagando.sid',
  secret: process.env.SESSION_SECRET,
  store: new PgSessionStore({ pool, createTableIfMissing: false, pruneSessionInterval: 15 * 60 }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    maxAge: 30 * 60 * 1000
  }
}));

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, fallthrough: true }));
app.get('/', (req, res) => res.render('index'));
for (const [url, permission] of [
  ['/clerk/dashboard', 'dashboard.clerk'],
  ['/nursing/dashboard', 'dashboard.nursing'],
  ['/clinical/dashboard', 'dashboard.clinical'],
  ['/pharmacy/dashboard', 'dashboard.pharmacy'],
  ['/laboratory/dashboard', 'dashboard.laboratory'],
  ['/management/dashboard', 'dashboard.management'],
  ['/admin/dashboard', 'dashboard.administration'],
  ['/clinical/consultation', 'consultation.start']
]) {
  app.get(url, requireAuth, requirePermission(permission), (req, res) => res.render('index'));
}
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/visits', visitsRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/workflow', workflowRoutes);
app.use('/api/laboratory', laboratoryRoutes);
app.use('/api/workflow', laboratoryRoutes);
app.use('/api/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : error.type === 'entity.parse.failed' ? 400 : 500;
  if (status === 500) {
    console.error('Unhandled request error.', {
      requestId: res.getHeader('X-Request-Id'),
      method: req.method,
      errorType: error.name,
      code: error.code
    });
  }
  const message = status === 500
    ? 'Internal server error.'
    : error.type === 'entity.parse.failed' ? 'Invalid request body.' : error.message;
  return res.status(status).json({ error: message });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port);

  async function shutdown() {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
