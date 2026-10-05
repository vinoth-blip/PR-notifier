'use strict';

const API = 'https://api.bitbucket.org/2.0';

function authHeader() {
  const email = process.env.BITBUCKET_EMAIL;
  const token = process.env.BITBUCKET_API_TOKEN;
  if (!email || !token) return null;
  return 'Basic ' + Buffer.from(email + ':' + token).toString('base64');
}

/** @returns {Promise<{code:number,data:object|null,err:string}>} */
async function get(url, timeoutMs = 15000) {
  const auth = authHeader();
  if (!auth) return { code: 0, data: null, err: 'Set BITBUCKET_EMAIL and BITBUCKET_API_TOKEN' };
  try {
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || text.slice(0, 200);
      return { code: res.status, data: null, err: 'HTTP ' + res.status + ': ' + msg };
    }
    return { code: res.status, data: data || {}, err: '' };
  } catch (e) {
    return { code: 0, data: null, err: String((e && e.message) || e) };
  }
}

module.exports = { API, get };
