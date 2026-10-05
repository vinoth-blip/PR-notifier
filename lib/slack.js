'use strict';

const INFO = {
  'pullrequest:created':   ['🆕', 'Pull request opened'],
  'pullrequest:fulfilled': ['✅', 'Pull request merged'],
  'pullrequest:rejected':  ['❌', 'Pull request declined'],
  'push':                  ['⬆️', 'Commits pushed'],
  'branch:created':        ['🌿', 'Branch created'],
  'branch:deleted':        ['🗑️', 'Branch deleted'],
  'comment':               ['💬', 'New comment'],
  'approval':              ['👍', 'Pull request approved'],
  'reviewers':             ['👥', 'Reviewers changed'],
  'pipeline:success':      ['🟢', 'Pipeline passed'],
  'pipeline:failed':       ['🔴', 'Pipeline failed'],
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function trim(s, max) {
  s = String(s == null ? '' : s).trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function info(event) {
  return INFO[event] || ['🔔', event];
}

/** Message for pull request opened / merged / declined. */
function prMessage(e, reviewers, users) {
  const [emoji, label] = info(e.event);
  const title = esc(e.title);
  const head = e.url
    ? `${emoji} *${label}*\n<${e.url}|#${e.prId} ${title}>`
    : `${emoji} *${label}*\n#${e.prId} ${title}`;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: head } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Repo:*\n`' + esc(e.repo) + '`' },
        { type: 'mrkdwn', text: '*Branch:*\n`' + esc(e.source) + '` → `' + esc(e.target) + '`' },
        { type: 'mrkdwn', text: '*Author:*\n' + esc(e.author) },
        { type: 'mrkdwn', text: (e.event === 'pullrequest:fulfilled' ? '*Merged by:*' : '*Action by:*') + '\n' + esc(e.actor) },
      ],
    },
  ];

  if (e.event === 'pullrequest:created' && reviewers.length) {
    const parts = reviewers.map((n) => (users[n] ? `<@${users[n]}>` : esc(n)));
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Reviewers: ' + parts.join(' ') }] });
  }
  return { text: `${label}: ${e.title}`, blocks };
}

/** Message for every other kind of event. */
function generic(event, repo, headline, url, fields, detail) {
  const [emoji, label] = info(event);
  const title = esc(trim(headline, 200));
  const head = `${emoji} *${label}*\n` + (url ? `<${url}|${title}>` : title);

  const f = [{ type: 'mrkdwn', text: '*Repo:*\n`' + esc(repo) + '`' }];
  for (const [name, value] of Object.entries(fields || {})) {
    if (value !== '' && value != null) {
      f.push({ type: 'mrkdwn', text: `*${name}:*\n` + esc(trim(value, 300)) });
    }
  }
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: head } },
    { type: 'section', fields: f.slice(0, 10) },
  ];
  if (detail && String(detail).trim()) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: esc(trim(detail, 1500)) } });
  }
  return { text: `${label}: ${headline}`, blocks };
}

async function post(webhookUrl, payload) {
  if (!webhookUrl) return { ok: false, err: 'SLACK_WEBHOOK_URL is not set' };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    if (res.status === 200) return { ok: true, err: '' };
    return { ok: false, err: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

module.exports = { prMessage, generic, post, info, trim };
