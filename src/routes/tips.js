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

// OSINT thread accepts photos, video, and documents (PDF / office docs / text)
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const DOC_MIME   = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);
const ALLOWED_MIME = new Set([...IMAGE_MIME, ...VIDEO_MIME, ...DOC_MIME]);

function fileKind(mime) {
  if (IMAGE_MIME.has(mime)) return 'image';
  if (VIDEO_MIME.has(mime)) return 'video';
  return 'document';
}

const tipStorage = multer.diskStorage({
  destination: tipUploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadTipFiles = multer({
  storage: tipStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
}).array('files', 8);

// OSINT taxonomy. Legacy 'official'/'resource' still accepted for back-compat.
const TIP_TYPES = new Set([
  'sighting', 'contact', 'document', 'media', 'official_report', 'other',
  'official', 'resource',
]);

// Resolve which tips reveal real account identity for this viewer.
// Submitter identity (account username) is shown ONLY to the case owner and admins.
// Everyone else sees the optional submitter_display, or "Anonymous".
function presentTip(tip, canSeeIdentity) {
  const base = {
    id: tip.id,
    case_id: tip.case_id,
    tip_type: tip.tip_type,
    content: tip.content,
    location: tip.location,
    location_lat: tip.location_lat,
    location_lng: tip.location_lng,
    location_description: tip.location_description,
    occurred_at: tip.occurred_at,
    source_url: tip.source_url,
    is_verified: tip.is_verified,
    is_pinned: tip.is_pinned,
    created_at: tip.created_at,
    submitter_display: tip.submitter_display || null,
    media: tip.media || [],
    // Public-facing name: chosen display name, else Anonymous
    display_name: tip.submitter_display?.trim() || 'Anonymous',
  };
  if (canSeeIdentity) {
    base.username = tip.username;
    base.user_id = tip.user_id;
    base.identity_visible = true;
  } else {
    base.identity_visible = false;
  }
  return base;
}

async function viewerCanSeeIdentity(caseId, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const owner = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [caseId]);
  return owner.rows[0]?.user_id === user.id;
}

// GET /api/cases/:id/tips  — full OSINT thread (pinned first, then chronological)
router.get('/', authenticate.optional, async (req, res, next) => {
  try {
    const caseRow = await pool.query('SELECT id FROM lf_cases WHERE id = $1', [req.params.id]);
    if (!caseRow.rows[0]) return res.status(404).json({ error: 'Case not found' });

    const result = await pool.query(
      `SELECT t.*, u.username,
              (SELECT COALESCE(json_agg(tm ORDER BY tm.created_at), '[]'::json)
               FROM lf_tip_media tm WHERE tm.tip_id = t.id) AS media
       FROM lf_tips t JOIN users u ON u.id = t.user_id
       WHERE t.case_id = $1
       ORDER BY t.is_pinned DESC, t.created_at ASC`,
      [req.params.id]
    );

    const canSeeIdentity = await viewerCanSeeIdentity(req.params.id, req.user);
    res.json(result.rows.map(t => presentTip(t, canSeeIdentity)));
  } catch (err) { next(err); }
});

// POST /api/cases/:id/tips  — account required to submit
router.post('/', authenticate, (req, res, next) => {
  uploadTipFiles(req, res, async (err) => {
    if (err) return next(err);
    try {
      const caseRow = await pool.query('SELECT id FROM lf_cases WHERE id = $1', [req.params.id]);
      if (!caseRow.rows[0]) {
        req.files?.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: 'Case not found' });
      }

      const { tip_type, content, location_description, location, occurred_at,
              source_url, location_lat, location_lng, submitter_display } = req.body;

      if (!TIP_TYPES.has(tip_type)) {
        req.files?.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: 'Invalid tip_type' });
      }
      if (!content?.trim()) {
        req.files?.forEach(f => fs.unlink(f.path, () => {}));
        return res.status(400).json({ error: 'content is required' });
      }

      const lat = location_lat !== undefined && location_lat !== '' ? parseFloat(location_lat) : null;
      const lng = location_lng !== undefined && location_lng !== '' ? parseFloat(location_lng) : null;
      const locDesc = (location_description ?? location)?.trim() || null;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tipResult = await client.query(
          `INSERT INTO lf_tips
             (case_id, user_id, tip_type, content, location, location_description,
              location_lat, location_lng, occurred_at, source_url, submitter_display)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [req.params.id, req.user.id, tip_type, content.trim(),
           locDesc, locDesc, lat, lng, occurred_at || null,
           source_url?.trim() || null, submitter_display?.trim() || null]
        );
        const tip = tipResult.rows[0];

        const mediaRows = await Promise.all((req.files || []).map(f =>
          client.query(
            `INSERT INTO lf_tip_media (tip_id, url, mime_type, original_name, size_bytes, file_kind)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [tip.id, `/api/uploads/tips/${f.filename}`, f.mimetype, f.originalname, f.size, fileKind(f.mimetype)]
          ).then(r => r.rows[0])
        ));

        await client.query('UPDATE lf_cases SET updated_at = NOW() WHERE id = $1', [req.params.id]);
        await client.query('COMMIT');

        const userRow = await pool.query('SELECT username FROM users WHERE id = $1', [req.user.id]);
        // The submitter always sees their own identity on the returned tip.
        res.status(201).json(presentTip(
          { ...tip, username: userRow.rows[0]?.username, media: mediaRows }, true
        ));
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

// PATCH /api/cases/:id/tips/:tipId/pin  — case owner or admin pins critical tips
router.patch('/:tipId/pin', authenticate, async (req, res, next) => {
  try {
    const caseRow = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [req.params.id]);
    if (!caseRow.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const isOwner = caseRow.rows[0].user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin)
      return res.status(403).json({ error: 'Only the case owner or an admin can pin tips' });

    const result = await pool.query(
      'UPDATE lf_tips SET is_pinned = NOT is_pinned WHERE id = $1 AND case_id = $2 RETURNING *',
      [req.params.tipId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tip not found' });
    res.json({ id: result.rows[0].id, is_pinned: result.rows[0].is_pinned });
  } catch (err) { next(err); }
});

// PATCH /api/cases/:id/tips/:tipId/verify  — case owner or admin
router.patch('/:tipId/verify', authenticate, async (req, res, next) => {
  try {
    const caseRow = await pool.query('SELECT user_id FROM lf_cases WHERE id = $1', [req.params.id]);
    if (!caseRow.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const isOwner = caseRow.rows[0].user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin)
      return res.status(403).json({ error: 'Only the case owner or an admin can verify tips' });

    const result = await pool.query(
      'UPDATE lf_tips SET is_verified = NOT is_verified WHERE id = $1 AND case_id = $2 RETURNING *',
      [req.params.tipId, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tip not found' });
    res.json({ id: result.rows[0].id, is_verified: result.rows[0].is_verified });
  } catch (err) { next(err); }
});

// DELETE /api/cases/:id/tips/:tipId  — tip author, case owner, or admin
router.delete('/:tipId', authenticate, async (req, res, next) => {
  try {
    const tip = await pool.query(
      'SELECT t.user_id, c.user_id AS case_owner FROM lf_tips t JOIN lf_cases c ON c.id = t.case_id WHERE t.id = $1 AND t.case_id = $2',
      [req.params.tipId, req.params.id]
    );
    if (!tip.rows[0]) return res.status(404).json({ error: 'Tip not found' });
    const { user_id, case_owner } = tip.rows[0];
    if (req.user.id !== user_id && req.user.id !== case_owner && req.user.role !== 'admin')
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

module.exports = router;
