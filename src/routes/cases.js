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
              c.location_lat, c.location_lng,
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
              last_seen_location, last_seen_at, contact_info, tags,
              location_lat, location_lng } = req.body;

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
        const lat = location_lat ? parseFloat(location_lat) : null;
        const lng = location_lng ? parseFloat(location_lng) : null;
        const caseResult = await client.query(
          `INSERT INTO lf_cases (user_id, title, description, subject_name, subject_type,
            last_seen_location, last_seen_at, contact_info, tags, location_lat, location_lng)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [req.user.id, title.trim(), description.trim(),
           subject_name?.trim() || null, subject_type,
           last_seen_location?.trim() || null, last_seen_at || null,
           contact_info?.trim() || null, parsedTags, lat, lng]
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

        // Mesh broadcast for new person searches (fire-and-forget)
        if (subject_type === 'person') {
          const meshKey = process.env.MESH_BRIDGE_KEY;
          const meshApi = (process.env.MESH_API_URL || 'http://localhost:3001').replace(/\/$/, '');
          if (meshKey) {
            const loc  = lostCase.last_seen_location ? ` — last seen ${lostCase.last_seen_location}` : '';
            const name = lostCase.subject_name ? ` ${lostCase.subject_name}` : '';
            const text = `[LOST & FOUND]${name}${loc} — ${lostCase.title}. Tips: lostfound.unprecedentedtimes.org/cases/${lostCase.id}`;
            fetch(`${meshApi}/api/mesh/broadcast`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${meshKey}` },
              body: JSON.stringify({ text, source: 'lostfound' }),
            }).catch(() => {});
          }
        }

        // Geocode asynchronously if no coords but location text provided
        if (!lat && lostCase.last_seen_location) {
          const https = require('https');
          const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(lostCase.last_seen_location)}&format=json&limit=1&countrycodes=us`;
          https.get(geocodeUrl, { headers: { 'User-Agent': 'LostFoundPlatform/1.0' } }, gRes => {
            let d = '';
            gRes.on('data', c => d += c);
            gRes.on('end', () => {
              try {
                const r = JSON.parse(d);
                if (r.length) {
                  pool.query('UPDATE lf_cases SET location_lat=$1, location_lng=$2 WHERE id=$3',
                    [parseFloat(r[0].lat), parseFloat(r[0].lon), lostCase.id]).catch(()=>{});
                }
              } catch {}
            });
          }).on('error', () => {});
        }
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

// GET /api/cases/map  — all cases with location data for map
router.get('/map', async (req, res, next) => {
  try {
    const { status } = req.query;
    const where = status ? `WHERE c.status = $1` : `WHERE c.status != 'resolved'`;
    const params = status ? [status] : [];
    const result = await pool.query(
      `SELECT c.id, c.title, c.subject_name, c.subject_type, c.last_seen_location,
              c.last_seen_at, c.status, c.location_lat, c.location_lng, c.created_at,
              u.username,
              (SELECT cp.url FROM lf_case_photos cp WHERE cp.case_id=c.id AND cp.is_primary=TRUE LIMIT 1) AS primary_photo
       FROM lf_cases c
       JOIN users u ON u.id = c.user_id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/cases/clusters  — geographic clusters of active cases:
// 3+ cases within 10 miles of each other filed within 30 days of each other.
// Documented community-awareness pattern only — not an accusation.
const CLUSTER_RADIUS_MI = 10;
const CLUSTER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function haversineMiles(aLat, aLng, bLat, bLng) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 3958.8; // earth radius in miles
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat), lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

router.get('/clusters', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.subject_name, c.subject_type, c.status,
              c.location_lat, c.location_lng, c.created_at, c.last_seen_location
       FROM lf_cases c
       WHERE c.status != 'resolved'
         AND c.location_lat IS NOT NULL AND c.location_lng IS NOT NULL
       ORDER BY c.created_at DESC
       LIMIT 500`
    );
    const cases = result.rows.map(c => ({
      ...c,
      location_lat: parseFloat(c.location_lat),
      location_lng: parseFloat(c.location_lng),
      _t: new Date(c.created_at).getTime(),
    }));

    // Union-Find over the proximity+recency graph
    const parent = cases.map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    for (let i = 0; i < cases.length; i++) {
      for (let j = i + 1; j < cases.length; j++) {
        if (Math.abs(cases[i]._t - cases[j]._t) > CLUSTER_WINDOW_MS) continue;
        const dist = haversineMiles(
          cases[i].location_lat, cases[i].location_lng,
          cases[j].location_lat, cases[j].location_lng
        );
        if (dist <= CLUSTER_RADIUS_MI) union(i, j);
      }
    }

    const groups = new Map();
    cases.forEach((c, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(c);
    });

    const clusters = [];
    for (const members of groups.values()) {
      if (members.length < 3) continue;
      const lat = members.reduce((s, m) => s + m.location_lat, 0) / members.length;
      const lng = members.reduce((s, m) => s + m.location_lng, 0) / members.length;
      const radius = Math.max(
        1,
        ...members.map(m => haversineMiles(lat, lng, m.location_lat, m.location_lng))
      );
      const times = members.map(m => m._t);
      clusters.push({
        center_lat: lat,
        center_lng: lng,
        radius_miles: Math.round(radius * 10) / 10,
        case_count: members.length,
        earliest: new Date(Math.min(...times)).toISOString(),
        latest: new Date(Math.max(...times)).toISOString(),
        cases: members.map(m => ({
          id: m.id, title: m.title, subject_name: m.subject_name,
          subject_type: m.subject_type, last_seen_location: m.last_seen_location,
          location_lat: m.location_lat, location_lng: m.location_lng, created_at: m.created_at,
        })),
      });
    }

    res.json(clusters);
  } catch (err) { next(err); }
});

// Public-facing tip presenter: account identity (username) is revealed ONLY to the
// case owner and admins. Everyone else sees submitter_display, or "Anonymous".
function presentTip(t, canSeeIdentity) {
  const base = {
    id: t.id, tip_type: t.tip_type, content: t.content,
    location: t.location, location_description: t.location_description,
    location_lat: t.location_lat, location_lng: t.location_lng,
    occurred_at: t.occurred_at, source_url: t.source_url,
    is_verified: t.is_verified, is_pinned: t.is_pinned, created_at: t.created_at,
    submitter_display: t.submitter_display || null,
    display_name: t.submitter_display?.trim() || 'Anonymous',
    media: t.media || [],
  };
  if (canSeeIdentity) {
    base.username = t.username;
    base.user_id = t.user_id;
    base.identity_visible = true;
  } else {
    base.identity_visible = false;
  }
  return base;
}

// GET /api/cases/:id
router.get('/:id', authenticate.optional, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.username, u.id AS poster_id, u.reliability_score, ${PHOTOS_SQL}
       FROM lf_cases c
       JOIN users u ON u.id = c.user_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const lostCase = result.rows[0];

    const tipsResult = await pool.query(
      `SELECT t.*, tu.username,
              (SELECT COALESCE(json_agg(tm ORDER BY tm.created_at), '[]'::json)
               FROM lf_tip_media tm WHERE tm.tip_id = t.id) AS media
       FROM lf_tips t JOIN users tu ON tu.id = t.user_id
       WHERE t.case_id = $1
       ORDER BY t.is_pinned DESC, t.created_at ASC`,
      [req.params.id]
    );

    const canSeeIdentity = !!req.user &&
      (req.user.role === 'admin' || req.user.id === lostCase.user_id);
    lostCase.tips = tipsResult.rows.map(t => presentTip(t, canSeeIdentity));
    res.json(lostCase);
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
