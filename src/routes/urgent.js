const express = require('express');
const pool    = require('../db');

const router = express.Router();
const BASE_URL = process.env.LF_BASE_URL || 'https://lostfound.unprecedentedtimes.org';

// GET /api/urgent  —  SPI endpoint: 5 most urgent active cases for Mycelium strip
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id, c.title, c.subject_name, c.subject_type,
        c.last_seen_location, c.last_seen_at, c.created_at,
        (SELECT COUNT(*)::int FROM lf_tips t WHERE t.case_id = c.id) AS tip_count,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_seen_at, c.created_at))) / 3600 AS hours_missing,
        (SELECT cp.url FROM lf_case_photos cp WHERE cp.case_id = c.id AND cp.is_primary = TRUE LIMIT 1) AS primary_photo
      FROM lf_cases c
      WHERE c.status = 'searching'
      ORDER BY
        (c.subject_type = 'person') DESC,
        c.last_seen_at ASC NULLS LAST,
        c.created_at ASC
      LIMIT 5
    `);

    const cases = result.rows.map(c => ({
      id:                 c.id,
      title:              c.title,
      subject_name:       c.subject_name,
      subject_type:       c.subject_type,
      last_seen_location: c.last_seen_location,
      last_seen_at:       c.last_seen_at,
      tip_count:          c.tip_count,
      hours_missing:      Math.round(c.hours_missing ?? 0),
      url:                `${BASE_URL}/cases/${c.id}`,
      photo_url:          c.primary_photo ? `${BASE_URL}${c.primary_photo}` : null,
    }));

    res.json(cases);
  } catch (err) { next(err); }
});

module.exports = router;
