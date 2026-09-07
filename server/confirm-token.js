/**
 * A CLICK THE MAIL SERVER CANNOT MAKE FOR YOU.
 *
 * WHAT HAPPENED. A customer's booking flipped itself to "pay the driver"
 * repeatedly — 07:55, then again at 17:24 — each time recorded as
 * payment_cash_chosen from the tokenised email link, user_id 0. Every time the
 * owner restored the card option and re-sent the payment email, it flipped back
 * and shut the card door again.
 *
 * Nothing was wrong with the GET: opening the link only ever rendered a page.
 * The hole was the page itself. It carried
 *
 *     <form method="POST"><button>Confirm — Pay on the Day</button></form>
 *
 * with no action, so it posted to the same URL — token and all — and the POST
 * asked for nothing the URL had not already supplied. Anything that fetched the
 * page and submitted its form chose cash on the customer's behalf, and
 * corporate mail-security scanners submit forms as a matter of routine.
 *
 * SO THERE IS NO FORM ANY MORE. The choice is sent by a fetch() that runs on a
 * real click, carrying a token minted when the page was rendered and signed by
 * this server. A scanner that follows the link gets a page. A scanner that
 * submits forms finds none. A scanner that runs the JavaScript still has to
 * decide to press the button.
 *
 * Stateless on purpose: the signature carries its own expiry, so nothing has to
 * be stored, expired or cleaned up, and a restart mid-decision does not strand
 * a customer with a dead button.
 *
 * GUARDRAIL: server/tests/cash-confirm.test.js
 */
'use strict';

const crypto = require('crypto');
const { getDb } = require('./db');

const TTL_MS = 60 * 60 * 1000;   // an hour is longer than anyone reads an email for

let _secret = null;
function secret() {
  if (_secret) return _secret;
  if (process.env.JWT_SECRET) { _secret = process.env.JWT_SECRET; return _secret; }
  /* The same server secret the sessions are signed with, read the same way
     (server/auth.js) so there is one secret to rotate, not two. */
  try {
    const row = getDb().prepare("SELECT value FROM integrations WHERE key = 'jwt_secret'").get();
    if (row && row.value) { _secret = row.value; return _secret; }
  } catch (_) {}
  /* No secret yet — sign with a per-process one. It survives as long as the
     process does, which is longer than the page is open. */
  _secret = 'wph_ephemeral_' + crypto.randomBytes(32).toString('hex');
  return _secret;
}

function sign(ref, expiry) {
  return crypto.createHmac('sha256', secret())
    .update(String(ref).toUpperCase() + '.' + expiry).digest('hex');
}

/** A token for this booking, good for an hour. */
function mint(ref, now) {
  const expiry = (now || Date.now()) + TTL_MS;
  return expiry + '.' + sign(ref, expiry);
}

/** Is this a token this server minted for this booking, and is it still valid? */
function verify(ref, value, now) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2) return false;
  const expiry = Number(parts[0]);
  if (!Number.isFinite(expiry) || expiry < (now || Date.now())) return false;
  const expected = Buffer.from(sign(ref, parts[0]), 'utf8');
  const given = Buffer.from(String(parts[1]), 'utf8');
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { mint, verify, TTL_MS };
