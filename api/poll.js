'use strict';
const { runPoll } = require('../lib/poll');
const { authorized, send } = require('../lib/auth');

// Call this URL every 1-2 minutes:  https://YOUR-APP.vercel.app/api/poll?key=YOUR_POLL_KEY
module.exports = async (req, res) => {
  if (!authorized(req)) return send(res, 401, 'Unauthorized');
  try {
    const result = await runPoll();
    return send(res, 200, result);
  } catch (e) {
    console.error('poll failed:', e);
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
};
