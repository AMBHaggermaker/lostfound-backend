const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const pool       = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TIP_LABELS = {
  sighting:        'SIGHTING',
  contact:         'CONTACT',
  document:        'DOCUMENT',
  media:           'MEDIA/EVIDENCE',
  official_report: 'OFFICIAL REPORT',
  other:           'OTHER',
  official:        'OFFICIAL SOURCE',
  resource:        'RESOURCE',
};

// GET /api/cases/:id/briefing  — structured AI briefing for new volunteers
router.get('/', authenticate, async (req, res, next) => {
  try {
    const caseResult = await pool.query(
      `SELECT c.*, u.username FROM lf_cases c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (!caseResult.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const lostCase = caseResult.rows[0];

    const tipsResult = await pool.query(
      `SELECT t.*, u.username FROM lf_tips t JOIN users u ON u.id = t.user_id
       WHERE t.case_id = $1 ORDER BY t.is_pinned DESC, t.created_at`,
      [req.params.id]
    );
    const tips = tipsResult.rows;

    if (tips.length === 0) {
      return res.json({
        summary: 'No tips have been submitted for this case yet.',
        known: [], unknown: ['No information has been submitted to the thread yet.'],
        geographic_patterns: 'No sightings have been reported, so no geographic pattern can be established.',
        next_steps: ['Share this case to gather initial sightings and information.'],
        generated_at: new Date().toISOString(), tip_count: 0,
      });
    }

    const caseContext = [
      `CASE: ${lostCase.title}`,
      `Subject: ${lostCase.subject_name || 'Unknown'} (${lostCase.subject_type})`,
      `Status: ${lostCase.status}`,
      `Last seen: ${lostCase.last_seen_location || 'Unknown location'}${lostCase.last_seen_at ? ` on ${new Date(lostCase.last_seen_at).toLocaleDateString()}` : ''}`,
      `Description: ${lostCase.description}`,
      '',
      `INFORMATION THREAD (${tips.length} tips):`,
      ...tips.map((t, i) => {
        const loc = t.location_description || t.location;
        const coords = (t.location_lat && t.location_lng) ? ` [${t.location_lat}, ${t.location_lng}]` : '';
        return `[${i + 1}] ${TIP_LABELS[t.tip_type] || t.tip_type} — ${new Date(t.created_at).toLocaleDateString()}${t.occurred_at ? ` (event: ${new Date(t.occurred_at).toLocaleDateString()})` : ''}${loc ? ` — ${loc}${coords}` : ''}${t.is_pinned ? ' [PINNED]' : ''}${t.is_verified ? ' [VERIFIED]' : ''}\n    ${t.content}${t.source_url ? `\n    Source: ${t.source_url}` : ''}`;
      }),
    ].join('\n');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1400,
      messages: [{
        role: 'user',
        content: `You are an analyst preparing a factual briefing to orient a new volunteer joining the search for this lost/missing case. Be concise and objective. Do not speculate beyond what is in the tips. Do not offer emotional commentary. Prioritize pinned and verified tips.

${caseContext}

Respond in JSON with exactly these fields:
{
  "summary": "2-3 sentence overview of the case and current state of the search",
  "known": ["array of facts that are confirmed or corroborated by the tips"],
  "unknown": ["array of important open questions / gaps a volunteer should help fill"],
  "geographic_patterns": "1-3 sentences describing any geographic pattern in the sightings (clustering, direction of travel, last confirmed location). Say so plainly if there is no clear pattern.",
  "next_steps": ["array of concrete, actionable suggestions for a volunteer"]
}`,
      }],
    });

    let briefing;
    try {
      const text = message.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      briefing = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      briefing = {
        summary: message.content[0].text, known: [], unknown: [],
        geographic_patterns: '', next_steps: [],
      };
    }

    res.json({ ...briefing, generated_at: new Date().toISOString(), tip_count: tips.length });
  } catch (err) { next(err); }
});

module.exports = router;
