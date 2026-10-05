'use strict';
const store = require('../lib/store');
const slack = require('../lib/slack');
const { config } = require('../lib/poll');
const { authorized, flag, send } = require('../lib/auth');

// https://YOUR-APP.vercel.app/api/status?key=YOUR_POLL_KEY            -> shows setup + last poll
// https://YOUR-APP.vercel.app/api/status?key=YOUR_POLL_KEY&test=1     -> also sends a test Slack message
module.exports = async (req, res) => {
  if (!authorized(req)) return send(res, 401, 'Unauthorized');

  const c = config();
  const has = (n) => Boolean(process.env[n]);
  const body = {
    setup: {
      SLACK_WEBHOOK_URL: has('SLACK_WEBHOOK_URL'),
      BITBUCKET_WORKSPACE: c.ws || false,
      BITBUCKET_EMAIL: has('BITBUCKET_EMAIL'),
      BITBUCKET_API_TOKEN: has('BITBUCKET_API_TOKEN'),
      POLL_KEY: has('POLL_KEY') || has('CRON_SECRET'),
      redis: Boolean(
        (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)
        && (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)
      ),
      events: [...c.events],
      branchFilter: c.branches.length ? c.branches : 'all branches',
    },
  };

  try {
    const last = await store.cmd('GET', 'last:poll');
    body.lastPoll = last ? JSON.parse(last) : 'no poll has run yet';
  } catch (e) {
    body.lastPoll = 'cannot read Redis: ' + ((e && e.message) || e);
  }

  if (flag(req, 'test')) {
    const r = await slack.post(c.slackUrl, { text: '🔔 Test message from Bitbucket Slack Notifier (Vercel)' });
    body.slackTest = r.ok ? 'sent' : 'failed: ' + r.err;
  }
  return send(res, 200, body);
};
