'use strict';

const bb = require('./bitbucket');
const store = require('./store');
const slack = require('./slack');

const API = bb.API;
const enc = encodeURIComponent;
const DEFAULT_EVENTS = 'pr,commits,branches,comments,approvals,reviewers,pipelines';

/* ---------------------------------------------------------------------
 * Settings (all from Vercel environment variables)
 * ------------------------------------------------------------------- */
function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function config() {
  const users = {};
  for (const pair of list(process.env.SLACK_USERS)) {
    const i = pair.lastIndexOf(':');
    if (i > 0) users[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return {
    ws: process.env.BITBUCKET_WORKSPACE || '',
    slackUrl: process.env.SLACK_WEBHOOK_URL || '',
    repos: list(process.env.BITBUCKET_REPOS),
    branches: list(process.env.BITBUCKET_NOTIFY_BRANCHES),
    events: new Set(list((process.env.POLL_EVENTS || DEFAULT_EVENTS).toLowerCase())),
    users,
  };
}

const ts = (s) => {
  const t = Date.parse(s || '');
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
};

function commitAuthor(c) {
  const a = (c && c.author) || {};
  if (a.user && a.user.display_name) return a.user.display_name;
  return String(a.raw || '').replace(/\s*<[^>]*>/g, '').trim();
}

const firstLine = (s) => String(s || '').trim().split('\n')[0].trim();

/* ---------------------------------------------------------------------
 * Sending (each event is announced only once)
 * ------------------------------------------------------------------- */
async function deliver(c, id, payload, out) {
  if (!(await store.claim(id))) return; // already announced
  const r = await slack.post(c.slackUrl, payload);
  if (r.ok) {
    out.sent++;
  } else {
    out.problems.push('Slack: ' + r.err.slice(0, 100));
    await store.pushRetry(payload); // try again on the next poll
  }
}

async function flushRetries(c, out) {
  for (let i = 0; i < 20; i++) {
    const payload = await store.popRetry();
    if (!payload) return;
    const r = await slack.post(c.slackUrl, payload);
    if (r.ok) {
      out.sent++;
    } else {
      await store.pushRetry(payload);
      out.problems.push('Slack retry: ' + r.err.slice(0, 100));
      return;
    }
  }
}

/* ---------------------------------------------------------------------
 * Repositories
 * ------------------------------------------------------------------- */
async function repoSlugs(c) {
  if (c.repos.length) return { slugs: c.repos, err: '' };
  // The repo list rarely changes: keep it for an hour (saves Bitbucket API calls)
  try {
    const cached = await store.cmd('GET', 'cache:repos');
    if (cached) { const list = JSON.parse(cached); if (Array.isArray(list) && list.length) return { slugs: list, err: '' }; }
  } catch (e) { /* no cache, fetch below */ }
  const slugs = [];
  let url = `${API}/repositories/${enc(c.ws)}?pagelen=100&fields=next,values.slug`;
  let pages = 0;
  while (url && pages++ < 10) {
    const { data, err } = await bb.get(url);
    if (err) return { slugs: [], err };
    for (const r of data.values || []) if (r.slug) slugs.push(String(r.slug));
    url = data.next || null;
  }
  if (slugs.length) await store.cmd('SET', 'cache:repos', JSON.stringify(slugs), 'EX', 3600).catch(() => {});
  return { slugs, err: '' };
}

/* ---------------------------------------------------------------------
 * 1. Pull requests: opened / merged / declined + reviewer changes
 * ------------------------------------------------------------------- */
async function pollPrs(c, slug, baseline, first, out) {
  const repo = `${c.ws}/${slug}`;
  const url = `${API}/repositories/${enc(c.ws)}/${enc(slug)}/pullrequests`
    + '?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=50';
  const { data, err } = await bb.get(url);
  if (err) { out.problems.push(`${slug} pull requests (${err})`); return; }

  const known = await store.hgetall('pr:' + repo);
  const updates = [];

  for (const p of data.values || []) {
    const id = Number(p.id) || 0;
    const state = p.state || '';
    const created = ts(p.created_on);
    const updated = ts(p.updated_on);
    const target = (p.destination && p.destination.branch && p.destination.branch.name) || '';
    const source = (p.source && p.source.branch && p.source.branch.name) || '';
    const author = (p.author && p.author.display_name) || '';
    const closer = (p.closed_by && p.closed_by.display_name) || '';
    const link = (p.links && p.links.html && p.links.html.href) || '';
    const allowed = !c.branches.length || c.branches.includes(target);
    const prev = known[String(id)] ? JSON.parse(known[String(id)]) : null;

    let event = null;
    if (!first) {
      if (!prev) {
        if (state === 'OPEN' && created >= baseline) event = 'pullrequest:created';
        else if (state === 'MERGED' && updated >= baseline) event = 'pullrequest:fulfilled';
        else if (state === 'DECLINED' && updated >= baseline) event = 'pullrequest:rejected';
      } else if (prev.s !== state) {
        if (state === 'MERGED') event = 'pullrequest:fulfilled';
        else if (state === 'DECLINED') event = 'pullrequest:rejected';
      }
    }

    const reviewerNames = Array.isArray(p.reviewers)
      ? p.reviewers.map((r) => r.display_name).filter(Boolean)
      : [];

    if (event && c.events.has('pr') && allowed) {
      const info = {
        event, repo, prId: id, title: p.title || '', author,
        actor: event === 'pullrequest:created' ? author : (closer || author),
        source, target, url: link,
      };
      await deliver(c, `pr:${repo}:${id}:${event}`, slack.prMessage(info, reviewerNames, c.users), out);
    }

    // Reviewer changes (only when Bitbucket gave us a reviewers list)
    let joined = prev ? prev.r : null;
    if (Array.isArray(p.reviewers)) {
      const names = [...reviewerNames].sort();
      joined = names.join('|');
      if (c.events.has('reviewers') && !first && prev && prev.r != null && prev.r !== joined
          && state === 'OPEN' && allowed) {
        const oldNames = prev.r === '' ? [] : prev.r.split('|');
        const added = names.filter((n) => !oldNames.includes(n));
        const removed = oldNames.filter((n) => !names.includes(n));
        const lines = [];
        if (added.length) lines.push('Added: ' + added.join(', '));
        if (removed.length) lines.push('Removed: ' + removed.join(', '));
        await deliver(
          c,
          `reviewers:${repo}:${id}:${joined}`,
          slack.generic('reviewers', repo, `#${id} ${p.title || ''}`, link,
            { Branch: `${source} → ${target}`, Author: author }, lines.join('\n')),
          out
        );
      }
    }

    if (!prev || prev.s !== state || prev.r !== joined) {
      updates.push(String(id), JSON.stringify({ s: state, r: joined }));
    }
    out.prs++;
  }

  await store.hset('pr:' + repo, updates);
}

/* ---------------------------------------------------------------------
 * 2. Branches created / deleted and commits pushed
 * ------------------------------------------------------------------- */
async function pollBranches(c, slug, since, doBranches, doCommits, out) {
  const repo = `${c.ws}/${slug}`;
  // Light requests only (names + hashes). To stay under Bitbucket's hourly request limit:
  //  - every poll reads just the 50 most recently updated branches (1 request): catches pushes and new branches
  //  - every ~10 minutes it reads ALL branches: catches deleted branches and new branches with old commits
  const fullDue = (await store.cmd('SET', 'fullscan:' + repo, '1', 'NX', 'EX', 540)) === 'OK';
  const fields = 'next,values.name,values.target.hash';
  let url = fullDue
    ? `${API}/repositories/${enc(c.ws)}/${enc(slug)}/refs/branches?pagelen=100&fields=${fields}`
    : `${API}/repositories/${enc(c.ws)}/${enc(slug)}/refs/branches?pagelen=50&sort=-target.date&fields=${fields}`;
  const current = {};
  const budgetEnd = Date.now() + 30000;
  let complete = fullDue;

  while (url) {
    const { data, err } = await bb.get(url, 20000);
    if (err) {
      out.problems.push(`${slug} branches (${err})`);
      if (fullDue) await store.cmd('DEL', 'fullscan:' + repo).catch(() => {}); // try the full scan again next poll
      return;
    }
    for (const b of data.values || []) {
      const name = b.name || '';
      const t = b.target || {};
      if (!name || !t.hash) continue;
      current[name] = { hash: t.hash, message: '', author: '', date: 0, url: '' };
    }
    url = fullDue ? (data.next || null) : null;
    if (url && Date.now() > budgetEnd) { complete = false; break; }
  }

  // Fetch commit details for one branch (only needed when we announce it)
  const detail = async (name) => {
    const r = await bb.get(`${API}/repositories/${enc(c.ws)}/${enc(slug)}/refs/branches/${encodeURIComponent(name)}`);
    if (r.err) { out.problems.push(`${slug} branch ${name} (${r.err})`); return false; }
    const t = r.data.target || {};
    Object.assign(current[name], {
      message: t.message || '', author: commitAuthor(t),
      url: (t.links && t.links.html && t.links.html.href) || '',
    });
    return true;
  };

  const old = await store.hgetall('heads:' + repo);
  const first = Object.keys(old).length === 0; // first time we see this repo: remember, say nothing
  const allowed = (name) => !c.branches.length || c.branches.includes(name);

  if (!first) {
    for (const [name, b] of Object.entries(current)) {
      if (!allowed(name)) continue;

      if (old[name] === undefined) {
        if (doBranches) {
          if (!(await detail(name))) { current[name].failed = true; continue; } // try again next minute
          await deliver(c, `branch+:${repo}:${name}:${b.hash}`,
            slack.generic('branch:created', repo, name, b.url,
              { Branch: '`' + name + '`', 'Last commit by': b.author }, firstLine(b.message)),
            out);
        }
      } else if (old[name] !== b.hash && doCommits) {
        if (!(await detail(name))) { current[name].failed = true; continue; } // try again next minute
        const cu = `${API}/repositories/${enc(c.ws)}/${enc(slug)}/commits`
          + `?include=${enc(b.hash)}&exclude=${enc(old[name])}&pagelen=10`;
        const r = await bb.get(cu);
        const lines = [];
        let more = false;
        if (!r.err) {
          for (const cm of r.data.values || []) {
            lines.push('• ' + String(cm.hash || '').slice(0, 7) + ' '
              + slack.trim(firstLine(cm.message), 100) + ' — ' + commitAuthor(cm));
          }
          more = !!r.data.next;
        }
        if (r.err) { out.problems.push(`${slug} commits of ${name} (${r.err})`); current[name].failed = true; continue; }
        let count = lines.length;
        if (count === 0) {
          count = 1;
          lines.push('• ' + b.hash.slice(0, 7) + ' ' + slack.trim(firstLine(b.message), 100) + ' — ' + b.author);
        }
        const headline = `${more ? count + '+' : count} commit${count > 1 || more ? 's' : ''} pushed to ${name}`;
        await deliver(c, `push:${repo}:${name}:${b.hash}`,
          slack.generic('push', repo, headline, b.url,
            { Branch: '`' + name + '`', 'Latest commit by': b.author }, lines.join('\n')),
          out);
      }
    }

    if (doBranches && complete) {
      for (const [name, hash] of Object.entries(old)) {
        if (current[name] === undefined && allowed(name)) {
          await deliver(c, `branch-:${repo}:${name}:${hash}`,
            slack.generic('branch:deleted', repo, name, '', { Branch: '`' + name + '`' }),
            out);
        }
      }
    }
  }

  // Save the new state of every branch
  const set = [];
  for (const [name, b] of Object.entries(current)) {
    if (b.failed) continue; // keep the old value so it is announced on the next poll
    if (old[name] !== b.hash) set.push(name, b.hash);
  }
  const gone = complete ? Object.keys(old).filter((n) => current[n] === undefined) : [];
  await store.hset('heads:' + repo, set);
  await store.hdel('heads:' + repo, gone);
}

/* ---------------------------------------------------------------------
 * 3. Comments and approvals (pull request activity feed)
 * ------------------------------------------------------------------- */
async function pollActivity(c, slug, since, doComments, doApprovals, out) {
  const repo = `${c.ws}/${slug}`;
  const { data, err } = await bb.get(`${API}/repositories/${enc(c.ws)}/${enc(slug)}/pullrequests/activity?pagelen=50`);
  if (err) { out.problems.push(`${slug} activity (${err})`); return; }

  for (const a of data.values || []) {
    const pr = a.pull_request || {};
    const prId = Number(pr.id) || 0;
    const prTitle = pr.title || '';
    const prUrl = (pr.links && pr.links.html && pr.links.html.href) || '';

    if (a.comment && doComments) {
      const cm = a.comment;
      if (cm.deleted) continue;
      const when = ts(cm.created_on);
      if (when < since) continue;
      const who = (cm.user && cm.user.display_name) || '';
      const link = (cm.links && cm.links.html && cm.links.html.href) || prUrl;
      await deliver(c, `comment:${repo}:${cm.id || when}`,
        slack.generic('comment', repo, `#${prId} ${prTitle}`, link,
          { By: who, Type: cm.inline ? 'Inline code comment' : 'Comment' },
          (cm.content && cm.content.raw) || ''),
        out);
    } else if (a.approval && doApprovals) {
      const ap = a.approval;
      const when = ts(ap.date);
      if (when < since) continue;
      const who = (ap.user && ap.user.display_name) || '';
      await deliver(c, `approval:${repo}:${prId}:${who}:${ap.date || when}`,
        slack.generic('approval', repo, `#${prId} ${prTitle}`, prUrl, { 'Approved by': who }),
        out);
    }
  }
}

/* ---------------------------------------------------------------------
 * 4. Pipeline results
 * ------------------------------------------------------------------- */
async function pollPipelines(c, slug, since, out) {
  const repo = `${c.ws}/${slug}`;
  const { code, data, err } = await bb.get(
    `${API}/repositories/${enc(c.ws)}/${enc(slug)}/pipelines/?sort=-created_on&pagelen=20`
  );
  if (err) {
    if (code === 404) return; // pipelines are not enabled in this repo
    if (code === 401 || code === 403) {
      out.problems.push('pipelines need the token scope read:pipeline:bitbucket');
    } else {
      out.problems.push(`${slug} pipelines (${err})`);
    }
    return;
  }

  for (const pl of data.values || []) {
    if (!pl.state || pl.state.name !== 'COMPLETED') continue;
    if (ts(pl.completed_on) < since) continue;
    const branch = (pl.target && pl.target.ref_name) || '';
    if (c.branches.length && !c.branches.includes(branch)) continue;

    const result = (pl.state.result && pl.state.result.name) || '';
    const ok = result === 'SUCCESSFUL';
    const event = ok ? 'pipeline:success' : 'pipeline:failed';
    const number = Number(pl.build_number) || 0;
    const link = `https://bitbucket.org/${c.ws}/${slug}/pipelines/results/${number}`;
    const secs = Number(pl.duration_in_seconds) || 0;
    const headline = `Pipeline #${number} ${(result || 'finished').toLowerCase()}`;

    await deliver(c, `pipeline:${pl.uuid || repo + number}`,
      slack.generic(event, repo, headline, link, {
        Branch: '`' + branch + '`',
        Result: result,
        'Triggered by': (pl.creator && pl.creator.display_name) || '',
        Duration: secs > 0 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : '',
      }),
      out);
  }
}

/* ---------------------------------------------------------------------
 * Main entry point
 * ------------------------------------------------------------------- */
async function runPoll() {
  const c = config();
  if (!c.ws) return { ok: false, message: 'Set BITBUCKET_WORKSPACE' };
  if (!c.slackUrl) return { ok: false, message: 'Set SLACK_WEBHOOK_URL' };

  // Never run two polls at the same time
  if ((await store.cmd('SET', 'lock:poll', '1', 'NX', 'EX', 50)) !== 'OK') {
    return { ok: true, message: 'Another poll is already running' };
  }

  const started = Date.now();
  const out = { sent: 0, prs: 0, problems: [] };

  try {
    await flushRetries(c, out);

    const { slugs, err } = await repoSlugs(c);
    if (err) return { ok: false, message: 'Bitbucket error: ' + err };

    // Each feature has its own start time, so switching one on later never floods Slack
    const [prBase, prFirst] = await store.initBaseline('meta:baseline');
    const doBranches = c.events.has('branches');
    const doCommits = c.events.has('commits');
    const doComments = c.events.has('comments');
    const doApprovals = c.events.has('approvals');
    const doPipelines = c.events.has('pipelines');

    let brSince = 0;
    let actSince = 0;
    let plSince = 0;
    if (doBranches || doCommits) [brSince] = await store.initBaseline('meta:baseline_branches');
    if (doComments || doApprovals) [actSince] = await store.initBaseline('meta:baseline_activity');
    if (doPipelines) [plSince] = await store.initBaseline('meta:baseline_pipelines');

    // Comments, approvals and pipelines are checked every 2nd poll (keeps us under Bitbucket's request limit)
    const heavy = Number(await store.cmd('INCR', 'poll:tick')) % 2 === 0;

    await Promise.all(slugs.map(async (slug) => {
      const run = async (fn) => {
        try { await fn(); } catch (e) { out.problems.push(`${slug}: ${(e && e.message) || e}`); }
      };
      await run(() => pollPrs(c, slug, prBase, prFirst, out));
      if (doBranches || doCommits) await run(() => pollBranches(c, slug, brSince, doBranches, doCommits, out));
      if (heavy && (doComments || doApprovals)) await run(() => pollActivity(c, slug, actSince, doComments, doApprovals, out));
      if (heavy && doPipelines) await run(() => pollPipelines(c, slug, plSince, out));
    }));

    const problems = [...new Set(out.problems)];
    const result = {
      ok: problems.length === 0,
      message: `Checked ${slugs.length} repos and ${out.prs} pull requests, sent ${out.sent} Slack notification(s).`
        + (prFirst ? ' First run: existing activity was saved silently.' : ''),
      problems: problems.slice(0, 6),
      ms: Date.now() - started,
      at: new Date().toISOString(),
    };
    await store.cmd('SET', 'last:poll', JSON.stringify(result));
    return result;
  } finally {
    await store.cmd('DEL', 'lock:poll').catch(() => {});
  }
}

module.exports = { runPoll, config };
