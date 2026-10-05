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
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/prescriptions', prescriptionRoutes);
app.use('/api/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  const status = error.type === 'entity.parse.failed' ? 400 : 500;
  return res.status(status).json({ error: status === 400 ? 'Invalid request body.' : 'Internal server error.' });
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
