// ── Gmail inbox routes ───────────────────────────────────────────────────
// Mounted at /api/gmail under the protected auth middleware.

const express = require('express');
const gmail = require('./gmail');
const gcal = require('./google-calendar');

const router = express.Router();

function requireStaff(req, res, next) {
  if (req.auth && ['admin', 'owner'].includes(req.auth.role)) return next();
  return res.status(403).json({ error: 'Access denied' });
}

function requireConnected(req, res, next) {
  const t = gcal.loadTokens();
  if (!t || !t.refresh_token) return res.status(400).json({ error: 'not_connected' });
  if (!gmail.hasGmailScope()) return res.status(400).json({ error: 'gmail_scope_missing', hint: 'Disconnect and reconnect Google to grant Gmail access.' });
  next();
}

// ── GET /api/gmail/status ────────────────────────────────────────────────
router.get('/status', requireStaff, (req, res) => {
  const t = gcal.loadTokens();
  res.json({
    ok: true,
    connected: !!(t && t.refresh_token),
    email: t ? t.account_email : null,
    gmailScope: gmail.hasGmailScope()
  });
});

// ── GET /api/gmail/messages?q=...&limit=... ──────────────────────────────
router.get('/messages', requireStaff, requireConnected, async (req, res) => {
  try {
    const q = req.query.q ? String(req.query.q) : '';
    const folder = (req.query.folder || 'inbox').toString();
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const labelIds = [];
    if (folder === 'inbox') labelIds.push('INBOX');
    else if (folder === 'sent') labelIds.push('SENT');
    else if (folder === 'unread') labelIds.push('INBOX', 'UNREAD');
    const messages = await gmail.listMessages({ q, labelIds, maxResults: limit });
    res.json({ ok: true, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/gmail/messages/:id ──────────────────────────────────────────
router.get('/messages/:id', requireStaff, requireConnected, async (req, res) => {
  try {
    const msg = await gmail.getMessage(req.params.id);
    // Auto-mark-read on first open (fire and forget)
    gmail.markRead(req.params.id).catch(() => {});
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/gmail/messages/:id/read ────────────────────────────────────
router.post('/messages/:id/read', requireStaff, requireConnected, async (req, res) => {
  try {
    if (req.body && req.body.unread) await gmail.markUnread(req.params.id);
    else await gmail.markRead(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/gmail/messages/:id — trash a message ────────────────────
router.delete('/messages/:id', requireStaff, requireConnected, async (req, res) => {
  try {
    await gmail.trashMessage(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/gmail/send ────────────────────────────────────────────────
router.post('/send', requireStaff, requireConnected, async (req, res) => {
  try {
    const { to, subject, html, text, threadId, inReplyTo, references } = req.body || {};
    if (!to) return res.status(400).json({ error: 'recipient required' });
    const result = await gmail.sendMessage({ to, subject, html, text, threadId, inReplyTo, references });
    res.json({ ok: true, id: result && result.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
