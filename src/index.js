require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const pool    = require('./db');
const errorHandler = require('./middleware/errorHandler');

const DIST = path.resolve('C:\\lostfound-app\\dist');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

app.use('/api/cases',   require('./routes/cases'));
app.use('/api/cases/:id/tips',     require('./routes/tips'));
app.use('/api/cases/:id/briefing', require('./routes/briefing'));
app.use('/api/cases/:id/export',   require('./routes/export'));
app.use('/api/urgent',  require('./routes/urgent'));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

app.use('/api/uploads', express.static(path.resolve('uploads')));
app.use(express.static(DIST));
app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Lost & Found API running on http://localhost:${PORT}`);
});
