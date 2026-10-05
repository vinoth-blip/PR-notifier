'use strict';
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

/** Accepts  ?key=SECRET  or  Authorization: Bearer SECRET  (POLL_KEY or Vercel's CRON_SECRET). */
function authorized(req) {
  const secret = process.env.POLL_KEY || process.env.CRON_SECRET;
  if (!secret) return false;
  const header = (req.headers && req.headers.authorization) || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  let key = '';
  try { key = new URL(req.url, 'http://localhost').searchParams.get('key') || ''; } catch (e) { /* ignore */ }
  return safeEqual(bearer, secret) || safeEqual(key, secret);
}

function flag(req, name) {
  try { return new URL(req.url, 'http://localhost').searchParams.get(name) === '1'; } catch (e) { return false; }
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json');
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

module.exports = { authorized, flag, send };
