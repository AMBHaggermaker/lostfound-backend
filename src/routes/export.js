const express = require('express');
const PDFDocument = require('pdfkit');
const path    = require('path');
const fs      = require('fs');
const pool    = require('../db');

const router = express.Router({ mergeParams: true });

const BASE_URL = process.env.LF_BASE_URL || 'https://lostfound.unprecedentedtimes.org';

const TIP_LABELS = {
  sighting: 'SIGHTING',
  contact:  'CONTACT REPORT',
  media:    'MEDIA / EVIDENCE',
  official: 'OFFICIAL SOURCE',
  resource: 'RESOURCE',
};

const STATUS_COLORS = {
  searching: [220, 53, 69],
  found:     [40, 167, 69],
  resolved:  [108, 117, 125],
};

// GET /api/cases/:id/export.pdf
router.get('/', async (req, res, next) => {
  try {
    const caseResult = await pool.query(
      `SELECT c.*, u.username,
              (SELECT COALESCE(json_agg(cp ORDER BY cp.is_primary DESC, cp.created_at), '[]')
               FROM lf_case_photos cp WHERE cp.case_id = c.id) AS photos
       FROM lf_cases c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!caseResult.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const lostCase = caseResult.rows[0];

    const tipsResult = await pool.query(
      `SELECT t.*, u.username,
              (SELECT COALESCE(json_agg(tm ORDER BY tm.created_at), '[]')
               FROM lf_tip_media tm WHERE tm.tip_id = t.id) AS media
       FROM lf_tips t JOIN users u ON u.id = t.user_id
       WHERE t.case_id = $1 ORDER BY t.created_at`,
      [req.params.id]
    );
    const tips = tipsResult.rows;

    const doc = new PDFDocument({ margin: 50, size: 'A4', compress: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="case-${lostCase.id.slice(0, 8)}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(22).fillColor('#111').text('LOST & FOUND CASE REPORT', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#888').text(`${BASE_URL}/cases/${lostCase.id}`, { align: 'center' });
    doc.moveDown(0.5);

    // Status badge area
    const [sr, sg, sb] = STATUS_COLORS[lostCase.status] || [108, 117, 125];
    doc.roundedRect(50, doc.y, 100, 20, 4).fill(`rgb(${sr},${sg},${sb})`);
    doc.fillColor('#fff').fontSize(10).text(lostCase.status.toUpperCase(), 55, doc.y - 17, { width: 90, align: 'center' });
    doc.moveDown(1.5);

    // Case details
    doc.fillColor('#111').fontSize(18).text(lostCase.title);
    doc.moveDown(0.3);
    if (lostCase.subject_name) {
      doc.fontSize(12).fillColor('#333').text(`Subject: ${lostCase.subject_name} (${lostCase.subject_type})`);
    }
    if (lostCase.last_seen_location) {
      doc.fontSize(11).fillColor('#555').text(`Last seen: ${lostCase.last_seen_location}${lostCase.last_seen_at ? ' on ' + new Date(lostCase.last_seen_at).toLocaleDateString() : ''}`);
    }
    doc.fontSize(10).fillColor('#666').text(`Posted by: ${lostCase.username}  |  ${new Date(lostCase.created_at).toLocaleDateString()}`);
    doc.moveDown(0.5);

    // Description
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#222').text(lostCase.description, { align: 'left' });
    doc.moveDown(0.5);

    if (lostCase.contact_info) {
      doc.fontSize(10).fillColor('#333').text(`Contact: ${lostCase.contact_info}`);
      doc.moveDown(0.5);
    }

    // Primary photo (if it can be found on disk)
    const primaryPhoto = lostCase.photos?.find(p => p.is_primary) || lostCase.photos?.[0];
    if (primaryPhoto) {
      const filePath = path.resolve(primaryPhoto.url.replace('/api/', ''));
      if (fs.existsSync(filePath)) {
        try {
          const maxW = 300, maxH = 200;
          doc.image(filePath, { fit: [maxW, maxH], align: 'center' });
          doc.moveDown(0.5);
        } catch {}
      }
    }

    // Tips thread
    doc.addPage();
    doc.fontSize(16).fillColor('#111').text(`INFORMATION THREAD  (${tips.length} tips)`);
    doc.moveDown(0.5);

    if (tips.length === 0) {
      doc.fontSize(11).fillColor('#888').text('No tips have been submitted yet.');
    }

    for (const tip of tips) {
      if (doc.y > 720) doc.addPage();

      const label = TIP_LABELS[tip.tip_type] || tip.tip_type.toUpperCase();
      const verifiedSuffix = tip.is_verified ? '  ✓ VERIFIED' : '';

      doc.rect(50, doc.y, 495, 18).fill('#f5f5f5');
      doc.fillColor('#333').fontSize(9).text(
        `${label}${verifiedSuffix}  —  ${tip.username}  —  ${new Date(tip.created_at).toLocaleDateString()}`,
        55, doc.y - 14, { width: 485 }
      );
      doc.moveDown(0.6);

      if (tip.location || tip.occurred_at) {
        doc.fontSize(9).fillColor('#666').text(
          [tip.location && `📍 ${tip.location}`, tip.occurred_at && `🕐 ${new Date(tip.occurred_at).toLocaleDateString()}`]
            .filter(Boolean).join('  ')
        );
        doc.moveDown(0.2);
      }

      doc.fontSize(10).fillColor('#111').text(tip.content, { indent: 10, align: 'left' });

      if (tip.source_url) {
        doc.fontSize(9).fillColor('#0066cc').text(`Source: ${tip.source_url}`, { indent: 10 });
      }
      doc.moveDown(0.8);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#eee').stroke();
      doc.moveDown(0.4);
    }

    // Footer
    doc.moveDown(1);
    doc.fontSize(8).fillColor('#999').text(
      `Generated ${new Date().toUTCString()}  |  ${BASE_URL}`,
      { align: 'center' }
    );

    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;
