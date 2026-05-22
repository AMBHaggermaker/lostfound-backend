const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const pool       = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TIP_LABELS = {
  sighting: 'SIGHTING',
  contact:  'CONTACT',
  media:    'MEDIA/EVIDENCE',
  official: 'OFFICIAL SOURCE',
  resource: 'RESOURCE',
};

// GET /api/cases/:id/briefing
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
       WHERE t.case_id = $1 ORDER BY t.created_at`,
      [req.params.id]
    );
    const tips = tipsResult.rows;

    if (tips.length === 0) {
      return res.json({
        summary: 'No tips have been submitted for this case yet.',
        key_facts: [],
        contradictions: [],
        urgency: 'Unknown — no information submitted.',
        generated_at: new Date().toISOString(),
      });
    }

    // Build structured context for the AI
    const caseContext = [
      `CASE: ${lostCase.title}`,
      `Subject: ${lostCase.subject_name || 'Unknown'} (${lostCase.subject_type})`,
      `Status: ${lostCase.status}`,
      `Last seen: ${lostCase.last_seen_location || 'Unknown location'}${lostCase.last_seen_at ? ` on ${new Date(lostCase.last_seen_at).toLocaleDateString()}` : ''}`,
      `Description: ${lostCase.description}`,
      '',
      `INFORMATION THREAD (${tips.length} tips):`,
      ...tips.map((t, i) =>
        `[${i + 1}] ${TIP_LABELS[t.tip_type]} — ${t.username} — ${new Date(t.created_at).toLocaleDateString()}${t.occurred_at ? ` (event: ${new Date(t.occurred_at).toLocaleDateString()})` : ''}${t.location ? ` — ${t.location}` : ''}${t.is_verified ? ' [VERIFIED]' : ''}\n    ${t.content}${t.source_url ? `\n    Source: ${t.source_url}` : ''}`
      ),
    ].join('\n');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are an analyst preparing a factual briefing for a lost/missing case. Be concise and objective. Do not speculate beyond what is in the tips. Do not offer emotional commentary.

${caseContext}

Respond in JSON with exactly these fields:
{
  "summary": "2-3 sentence overview of what is known",
  "key_facts": ["array of confirmed or corroborated facts"],
  "contradictions": ["array of inconsistencies or conflicting information, or empty array if none"],
  "urgency": "one sentence on urgency level and reasoning based on available information"
}`,
      }],
    });

    let briefing;
    try {
      const text = message.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      briefing = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      briefing = { summary: message.content[0].text, key_facts: [], contradictions: [], urgency: '' };
    }

    res.json({ ...briefing, generated_at: new Date().toISOString(), tip_count: tips.length });
  } catch (err) { next(err); }
});

module.exports = router;
