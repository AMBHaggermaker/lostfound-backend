const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const pool     = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const tipUploadDir = path.resolve('uploads/tips');
fs.mkdirSync(tipUploadDir, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const tipStorage = multer.diskStorage({
  destination: tipUploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadTipMedia = multer({
  storage: tipStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
}).array('media', 5);

const TIP_TYPES = ['sighting', 'contact', 'media', 'official', 'resource'];

// POST /api/cases/:id/tips
router.post('/', authenticate, (req, res, next) => {
  uploadTipMedia(req, res, async (err) => {
    if (err) return next(err);
    try {
      const caseRow = await pool.query('SELECT id FROM lf_cases WHERE id = $1', [req.params.id]);
      if (!caseRow.rows[0]) {
        req.files?.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: 'Case not found' });
      }

      const { tip_type, content, location, occurred_at, source_url } = req.body;

      if (!TIP_TYPES.includes(tip_type))
        return res.status(400).json({ error: `tip_type must be one of: ${TIP_TYPES.join(', ')}` });
      if (!content?.trim())
        return res.status(400).json({ error: 'content is required' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tipResult = await client.query(
          `INSERT INTO lf_tips (case_id, user_id, tip_type, content, location, occurred_at, source_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [req.params.id, req.user.id, tip_type, content.trim(),
           location?.trim() || null, occurred_at || null, source_url?.trim() || null]
        );
        const tip = tipResult.rows[0];

        const mediaRows = await Promise.all((req.files || []).map(f =>
          client.query(
            `INSERT INTO lf_tip_media (tip_id, url, mime_type, original_name, size_bytes)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [tip.id, `/api/uploads/tips/${f.filename}`, f.mimetype, f.originalname, f.size]
          ).then(r => r.rows[0])
        ));

        await client.query(
          'UPDATE lf_cases SET updated_at = NOW() WHERE id = $1',
          [req.params.id]
        );
        await client.query('COMMIT');

        // Return full tip with username and media
        const userRow = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
        res.status(201).json({ ...tip, username: userRow.rows[0]?.username, media: mediaRows });
      } catch (e) {
        await client.query('ROLLBACK');
        req.files?.forEach(f => fs.unlink(f.path, () => {}));
        throw e;
      } finally {
        client.release();
      }
    } catch (err) { next(err); }
  });
});

// DELETE /api/cases/:id/tips/:tipId
router.delete('/:tipId', authenticate, async (req, res, next) => {
  try {
    const tip = await pool.query(
      'SELECT t.user_id, c.user_id AS case_owner FROM lf_tips t JOIN lf_cases c ON c.id = t.case_id WHERE t.id = $1 AND t.case_id = $2',
      [req.params.tipId, req.params.id]
    );
    if (!tip.rows[0]) return res.status(404).json({ error: 'Tip not found' });
    const { user_id, case_owner } = tip.rows[0];
    if (req.user.id !== user_id && req.user.id !== case_owner)
      return res.status(403).json({ error: 'Forbidden' });

    const media = await pool.query('SELECT url FROM lf_tip_media WHERE tip_id = $1', [req.params.tipId]);
    await pool.query('DELETE FROM lf_tips WHERE id = $1', [req.params.tipId]);
    media.rows.forEach(m => {
      const filePath = path.resolve(m.url.replace('/api/', ''));
      fs.unlink(filePath, () => {});
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

// PATCH /api/cases/:id/tips/:tipId/verify  (case owner only)
router.patch('/:tipId/verify', authenticate, async (req, res, next) => {
  try {
    const caseRow = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [req.params.id]);
    if (!caseRow.rows[0]) return res.status(404).json({ error: 'Case not found' });
    if (caseRow.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Only case owner can verify tips' });

    const result = await pool.query(
      'UPDATE lf_tips SET is_verified = NOT is_verified WHERE id = $1 AND case_id = $2 RETURNING *',
      [req.params.tipId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tip not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
