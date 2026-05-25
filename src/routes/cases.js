const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const pool     = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

const caseUploadDir = path.resolve('uploads/cases');
fs.mkdirSync(caseUploadDir, { recursive: true });

const PHOTO_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

const photoStorage = multer.diskStorage({
  destination: caseUploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadPhotos = multer({
  storage: photoStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, PHOTO_MIME.has(file.mimetype)),
}).array('photos', 10);

const PHOTOS_SQL = `
  (SELECT COALESCE(json_agg(cp ORDER BY cp.is_primary DESC, cp.created_at), '[]'::json)
   FROM lf_case_photos cp WHERE cp.case_id = c.id) AS photos`;

const TIPS_COUNT_SQL = `
  (SELECT COUNT(*)::int FROM lf_tips t WHERE t.case_id = c.id) AS tip_count`;

// GET /api/cases
router.get('/', authenticate.optional, async (req, res, next) => {
  try {
    const { status, subject_type, search, page = 1, limit = 24 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (status)       { params.push(status);            conditions.push(`c.status = $${params.length}`); }
    if (subject_type) { params.push(subject_type);      conditions.push(`c.subject_type = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      const n = params.length;
      conditions.push(`(c.title ILIKE $${n} OR c.subject_name ILIKE $${n} OR c.last_seen_location ILIKE $${n})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT c.id, c.title, c.subject_name, c.subject_type, c.last_seen_location,
              c.last_seen_at, c.status, c.tags, c.created_at, c.updated_at,
              u.username, u.id AS poster_id,
              ${PHOTOS_SQL}, ${TIPS_COUNT_SQL}
       FROM lf_cases c
       JOIN users u ON u.id = c.user_id
       ${where}
       ORDER BY c.status = 'searching' DESC, c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/cases  (multipart: fields + photos[])
router.post('/', authenticate, (req, res, next) => {
  uploadPhotos(req, res, async (err) => {
    if (err) return next(err);
    try {
      const { title, description, subject_name, subject_type = 'person',
              last_seen_location, last_seen_at, contact_info, tags } = req.body;

      if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
      if (!description?.trim()) return res.status(400).json({ error: 'description is required' });
      if (!['person', 'pet', 'item'].includes(subject_type))
        return res.status(400).json({ error: 'subject_type must be person, pet, or item' });
      if (!req.files?.length)
        return res.status(400).json({ error: 'At least one photo is required' });

      const parsedTags = tags
        ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim()).filter(Boolean))
        : [];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const caseResult = await client.query(
          `INSERT INTO lf_cases (user_id, title, description, subject_name, subject_type,
            last_seen_location, last_seen_at, contact_info, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [req.user.id, title.trim(), description.trim(),
           subject_name?.trim() || null, subject_type,
           last_seen_location?.trim() || null, last_seen_at || null,
           contact_info?.trim() || null, parsedTags]
        );
        const lostCase = caseResult.rows[0];

        for (let i = 0; i < req.files.length; i++) {
          const f = req.files[i];
          const url = `/api/uploads/cases/${f.filename}`;
          await client.query(
            `INSERT INTO lf_case_photos (case_id, url, mime_type, original_name, size_bytes, is_primary)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [lostCase.id, url, f.mimetype, f.originalname, f.size, i === 0]
          );
        }
        await client.query('COMMIT');
        res.status(201).json({ ...lostCase, photos: req.files.map((f, i) => ({
          url: `/api/uploads/cases/${f.filename}`, mime_type: f.mimetype, is_primary: i === 0,
        })), tip_count: 0 });
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

// GET /api/cases/:id
router.get('/:id', authenticate.optional, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.username, u.id AS poster_id, u.reliability_score,
              ${PHOTOS_SQL},
              (SELECT COALESCE(json_agg(
                json_build_object(
                  'id', t.id, 'tip_type', t.tip_type, 'content', t.content,
                  'location', t.location, 'occurred_at', t.occurred_at,
                  'source_url', t.source_url, 'is_verified', t.is_verified,
                  'created_at', t.created_at, 'user_id', t.user_id,
                  'username', tu.username,
                  'media', (SELECT COALESCE(json_agg(tm ORDER BY tm.created_at), '[]'::json)
                            FROM lf_tip_media tm WHERE tm.tip_id = t.id)
                ) ORDER BY t.created_at
              ), '[]'::json)
               FROM lf_tips t JOIN users tu ON tu.id = t.user_id
               WHERE t.case_id = c.id) AS tips
       FROM lf_cases c
       JOIN users u ON u.id = c.user_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Case not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/cases/:id/status
router.patch('/:id/status', authenticate, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['searching', 'found', 'resolved'].includes(status))
      return res.status(400).json({ error: 'status must be searching, found, or resolved' });

    const existing = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Case not found' });
    if (existing.rows[0].user_id !== req.user.id)
      return res.status(403).json({ error: 'Only the case poster can update status' });

    const result = await pool.query(
      `UPDATE lf_cases SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/cases/:id/photos  (add more photos)
router.post('/:id/photos', authenticate, (req, res, next) => {
  uploadPhotos(req, res, async (err) => {
    if (err) return next(err);
    try {
      const existing = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [req.params.id]);
      if (!existing.rows[0]) { req.files?.forEach(f => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Case not found' }); }
      if (existing.rows[0].user_id !== req.user.id) { req.files?.forEach(f => fs.unlink(f.path, () => {})); return res.status(403).json({ error: 'Forbidden' }); }
      if (!req.files?.length) return res.status(400).json({ error: 'No photos provided' });

      const inserted = await Promise.all(req.files.map(f =>
        pool.query(
          `INSERT INTO lf_case_photos (case_id, url, mime_type, original_name, size_bytes, is_primary)
           VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING *`,
          [req.params.id, `/api/uploads/cases/${f.filename}`, f.mimetype, f.originalname, f.size]
        ).then(r => r.rows[0])
      ));
      res.status(201).json(inserted);
    } catch (err) { req.files?.forEach(f => fs.unlink(f.path, () => {})); next(err); }
  });
});

// DELETE /api/cases/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Case not found' });
    if (existing.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM lf_cases WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
