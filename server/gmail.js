// ── Gmail API helpers ────────────────────────────────────────────────────
// Uses the same Google OAuth token as server/google-calendar.js (stored in
// the integrations table). If the account was connected before Gmail scopes
// were added, the user will need to disconnect + reconnect to grant them.

const gcal = require('./google-calendar');

const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function hasGmailScope() {
  const t = gcal.loadTokens();
  if (!t || !t.scope) return false;
  return /gmail\.(readonly|modify|send)/.test(t.scope);
}

async function authFetch(url, opts = {}) {
  const token = await gcal.getAccessToken();
  if (!token) throw new Error('Google account not connected');
  opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ── Decode base64url (Gmail API uses URL-safe base64) ────────────────────
function b64urlDecode(str) {
  if (!str) return '';
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  try { return Buffer.from(str, 'base64').toString('utf8'); }
  catch (e) { return ''; }
}
function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Pull a plain-text + html body out of a Gmail payload (recursively) ───
function extractBody(payload) {
  if (!payload) return { text: '', html: '' };
  let text = '', html = '';

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const data = part.body && part.body.data ? b64urlDecode(part.body.data) : '';
    if (mime === 'text/plain' && !text) text = data;
    else if (mime === 'text/html' && !html) html = data;
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);
  return { text, html };
}

function headersToObj(list) {
  const h = {};
  (list || []).forEach(x => { if (x && x.name) h[x.name.toLowerCase()] = x.value || ''; });
  return h;
}

// ── List messages ────────────────────────────────────────────────────────
async function listMessages({ q, maxResults = 30, labelIds } = {}) {
  const params = new URLSearchParams();
  params.set('maxResults', String(maxResults));
  if (q) params.set('q', q);
  (labelIds || []).forEach(id => params.append('labelIds', id));

  const data = await authFetch(`${API_BASE}/messages?${params.toString()}`);
  const ids = (data.messages || []).map(m => m.id);

  // Fetch metadata for each (parallel, capped)
  const results = await Promise.all(ids.map(async id => {
    try {
      const m = await authFetch(`${API_BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`);
      const h = headersToObj(m.payload && m.payload.headers);
      return {
        id: m.id,
        threadId: m.threadId,
        snippet: m.snippet || '',
        unread: (m.labelIds || []).indexOf('UNREAD') !== -1,
        starred: (m.labelIds || []).indexOf('STARRED') !== -1,
        from: h.from || '',
        to: h.to || '',
        subject: h.subject || '(no subject)',
        date: h.date || '',
        internalDate: m.internalDate ? parseInt(m.internalDate, 10) : 0
      };
    } catch (e) { return null; }
  }));
  return results.filter(Boolean).sort((a, b) => b.internalDate - a.internalDate);
}

// ── Get a single full message ────────────────────────────────────────────
async function getMessage(id) {
  const m = await authFetch(`${API_BASE}/messages/${encodeURIComponent(id)}?format=full`);
  const h = headersToObj(m.payload && m.payload.headers);
  const body = extractBody(m.payload);
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    from: h.from || '',
    to: h.to || '',
    cc: h.cc || '',
    subject: h.subject || '(no subject)',
    date: h.date || '',
    messageId: h['message-id'] || '',
    references: h.references || '',
    inReplyTo: h['in-reply-to'] || '',
    text: body.text,
    html: body.html,
    snippet: m.snippet || ''
  };
}

// ── Mark read / unread ───────────────────────────────────────────────────
async function modifyLabels(id, { add = [], remove = [] } = {}) {
  await authFetch(`${API_BASE}/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove })
  });
  return true;
}
const markRead   = id => modifyLabels(id, { remove: ['UNREAD'] });
const markUnread = id => modifyLabels(id, { add: ['UNREAD'] });

// ── Build an RFC 822 message ─────────────────────────────────────────────
function buildRfc822({ from, to, subject, html, text, inReplyTo, references }) {
  const boundary = 'wph_' + Date.now().toString(36);
  const headers = [];
  if (from) headers.push('From: ' + from);
  headers.push('To: ' + to);
  headers.push('Subject: ' + encodeHeader(subject || ''));
  headers.push('MIME-Version: 1.0');
  if (inReplyTo)  headers.push('In-Reply-To: ' + inReplyTo);
  if (references) headers.push('References: ' + references);
  headers.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');

  const body = [
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    (text || stripHtml(html || '')),
    '',
    '--' + boundary,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    (html || '<p>' + escapeHtml(text || '') + '</p>'),
    '',
    '--' + boundary + '--',
    ''
  ].join('\r\n');

  return headers.join('\r\n') + '\r\n' + body;
}

function encodeHeader(v) {
  // Encode non-ASCII subjects per RFC 2047
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(v)) {
    return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
  }
  return v;
}
function stripHtml(s) { return (s || '').replace(/<[^>]+>/g, ''); }
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── Send / reply ─────────────────────────────────────────────────────────
async function sendMessage({ to, subject, html, text, replyTo, threadId, inReplyTo, references }) {
  if (!to) throw new Error('recipient required');
  const tokens = gcal.loadTokens();
  const from = (tokens && tokens.account_email) ? tokens.account_email : undefined;
  const raw = buildRfc822({ from, to, subject, html, text, inReplyTo, references });
  const body = { raw: b64urlEncode(raw) };
  if (threadId) body.threadId = threadId;
  const data = await authFetch(`${API_BASE}/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return data;
}

// ── Trash a message (moves to Gmail Trash, recoverable for 30 days) ──────
async function trashMessage(messageId) {
  return authFetch(`${API_BASE}/messages/${encodeURIComponent(messageId)}/trash`, { method: 'POST' });
}

module.exports = {
  hasGmailScope,
  listMessages,
  getMessage,
  markRead,
  markUnread,
  sendMessage,
  trashMessage
};
