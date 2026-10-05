'use strict';
// Tiny Upstash Redis REST client (no npm packages needed).

function endpoint() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Redis is not connected: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  }
  return { url: url.replace(/\/$/, ''), token };
}

async function call(path, body) {
  const { url, token } = endpoint();
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json === null) {
    throw new Error('Redis HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 200));
  }
  return json;
}

async function cmd(...args) {
  const j = await call('', args.map(String));
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

async function hgetall(key) {
  const flat = (await cmd('HGETALL', key)) || [];
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

async function hset(key, pairs) {
  if (!pairs.length) return;
  await cmd('HSET', key, ...pairs);
}

async function hdel(key, fields) {
  if (!fields.length) return;
  await cmd('HDEL', key, ...fields);
}

/** @returns {Promise<[number, boolean]>} [timestamp, true if it was created just now] */
async function initBaseline(key) {
  const now = Math.floor(Date.now() / 1000);
  const r = await cmd('SET', key, now, 'NX');
  if (r === 'OK') return [now, true];
  const v = Number(await cmd('GET', key));
  return [v > 0 ? v : now, false];
}

/** True the first time an event id is seen (so it is announced only once). */
async function claim(id) {
  return (await cmd('SET', 'sent:' + id, '1', 'NX', 'EX', 60 * 60 * 24 * 30)) === 'OK';
}

async function pushRetry(payload) {
  await cmd('LPUSH', 'retry', JSON.stringify(payload));
  await cmd('LTRIM', 'retry', 0, 49);
}

async function popRetry() {
  const v = await cmd('RPOP', 'retry');
  return v ? JSON.parse(v) : null;
}

module.exports = { cmd, hgetall, hset, hdel, initBaseline, claim, pushRetry, popRetry };
