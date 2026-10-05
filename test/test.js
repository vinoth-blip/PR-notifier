'use strict';
// Offline test: fake Redis + fake Bitbucket + fake Slack. Run with:  node test/test.js
const assert = require('assert');

process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/abc';
process.env.BITBUCKET_WORKSPACE = 'techcore';
process.env.BITBUCKET_EMAIL = 'me@example.com';
process.env.BITBUCKET_API_TOKEN = 'token';
process.env.SLACK_USERS = 'Rajesh Kumar:U01ABC';

/* ---------- fake Redis ---------- */
const kv = new Map();
const hashes = new Map();
const lists = new Map();
function redis(args) {
  const [c, ...a] = args;
  switch (c.toUpperCase()) {
    case 'SET': {
      const nx = a.includes('NX');
      if (nx && kv.has(a[0])) return null;
      kv.set(a[0], a[1]);
      return 'OK';
    }
    case 'GET': return kv.has(a[0]) ? kv.get(a[0]) : null;
    case 'DEL': kv.delete(a[0]); return 1;
    case 'HGETALL': { const h = hashes.get(a[0]) || {}; return Object.entries(h).flat(); }
    case 'HSET': {
      const h = hashes.get(a[0]) || {};
      for (let i = 1; i + 1 < a.length; i += 2) h[a[i]] = a[i + 1];
      hashes.set(a[0], h);
      return 1;
    }
    case 'HDEL': { const h = hashes.get(a[0]) || {}; a.slice(1).forEach((f) => delete h[f]); return 1; }
    case 'LPUSH': { const l = lists.get(a[0]) || []; l.unshift(a[1]); lists.set(a[0], l); return l.length; }
    case 'LTRIM': return 'OK';
    case 'RPOP': { const l = lists.get(a[0]) || []; return l.length ? l.pop() : null; }
    default: throw new Error('unsupported redis command ' + c);
  }
}

/* ---------- fake Bitbucket world ---------- */
const iso = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString();
const world = {
  prs: [
    { id: 1, title: 'Old open PR', state: 'OPEN', created_on: iso(-86400), updated_on: iso(-3600),
      author: { display_name: 'Murugan A' }, reviewers: [],
      source: { branch: { name: 'feature/a' } }, destination: { branch: { name: 'master' } },
      links: { html: { href: 'https://bb/pr/1' } } },
    { id: 2, title: 'Old merged PR', state: 'MERGED', created_on: iso(-90000), updated_on: iso(-80000),
      author: { display_name: 'Dinesh Naik' }, reviewers: [],
      source: { branch: { name: 'feature/b' } }, destination: { branch: { name: 'master' } },
      links: { html: { href: 'https://bb/pr/2' } } },
  ],
  branches: [
    { name: 'master', target: { hash: 'aaa1111', message: 'init', author: { raw: 'Dev <d@x.com>' }, links: { html: { href: 'https://bb/c/aaa1111' } } } },
    { name: 'dev', target: { hash: 'bbb2222', message: 'dev work', author: { raw: 'Dev <d@x.com>' }, links: { html: { href: 'https://bb/c/bbb2222' } } } },
  ],
  commits: [],
  activity: [],
  pipelines: [],
};

const slackSent = [];
let slackFail = false;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://fake-redis.test')) {
    const body = JSON.parse(opts.body);
    if (url.endsWith('/pipeline')) return json(body.map((b) => ({ result: redis(b) })));
    return json({ result: redis(body) });
  }
  if (url.startsWith('https://hooks.slack.test')) {
    if (slackFail) return new Response('invalid_token', { status: 403 });
    slackSent.push(JSON.parse(opts.body));
    return new Response('ok', { status: 200 });
  }
  if (url.startsWith('https://api.bitbucket.org/2.0')) {
    assert.ok(opts.headers.Authorization.startsWith('Basic '), 'Bitbucket call must be authenticated');
    const path = url.replace('https://api.bitbucket.org/2.0', '');
    if (path.startsWith('/repositories/techcore?')) return json({ values: [{ slug: 'khelo' }] });
    if (path.includes('/khelo/pullrequests/activity')) return json({ values: world.activity });
    if (path.includes('/khelo/pullrequests?')) return json({ values: world.prs });
    if (path.includes('/khelo/refs/branches')) return json({ values: world.branches });
    if (path.includes('/khelo/commits')) return json({ values: world.commits });
    if (path.includes('/khelo/pipelines/')) return json({ values: world.pipelines });
    return json({ error: { message: 'not found ' + path } }, 404);
  }
  throw new Error('unexpected fetch ' + url);
};

const { runPoll } = require('../lib/poll');
const labels = () => slackSent.map((m) => m.text.split(':')[0]);
const reset = () => { slackSent.length = 0; };

(async () => {
  /* 1. first run: remembers everything, says nothing */
  let r = await runPoll();
  console.log('poll 1:', r.message);
  assert.strictEqual(slackSent.length, 0, 'first run must be silent');

  /* 2. lots of new activity */
  world.prs.unshift({
    id: 3, title: 'New PR from test', state: 'OPEN', created_on: iso(30), updated_on: iso(30),
    author: { display_name: 'Murugan A' }, reviewers: [{ display_name: 'Rajesh Kumar' }],
    source: { branch: { name: 'feature/c' } }, destination: { branch: { name: 'master' } },
    links: { html: { href: 'https://bb/pr/3' } },
  });
  world.prs[1].state = 'MERGED'; // PR #1 gets merged
  world.prs[1].updated_on = iso(31);
  world.prs[1].closed_by = { display_name: 'Dinesh Naik' };
  world.branches.push({ name: 'feature/c', target: { hash: 'ccc3333', message: 'start c', author: { raw: 'Murugan A <m@x.com>' }, links: { html: { href: 'https://bb/c/ccc3333' } } } });
  world.branches[0].target.hash = 'aaa9999'; // push to master
  world.commits = [
    { hash: 'aaa9999xyz', message: 'Fix filter\n\nlong body', author: { user: { display_name: 'Murugan A' } } },
    { hash: 'aaa8888xyz', message: 'Add test', author: { raw: 'Murugan A <m@x.com>' } },
  ];
  world.activity = [
    { pull_request: { id: 3, title: 'New PR from test', links: { html: { href: 'https://bb/pr/3' } } },
      comment: { id: 77, created_on: iso(32), user: { display_name: 'Dinesh Naik' }, content: { raw: 'Looks good <3 & tidy' }, links: { html: { href: 'https://bb/pr/3#c77' } } } },
    { pull_request: { id: 3, title: 'New PR from test', links: { html: { href: 'https://bb/pr/3' } } },
      approval: { date: iso(33), user: { display_name: 'Rajesh Kumar' } } },
    { pull_request: { id: 1, title: 'Old open PR' }, comment: { id: 5, created_on: iso(-5000), user: { display_name: 'Old' }, content: { raw: 'ancient' } } },
  ];
  world.pipelines = [
    { uuid: '{p1}', build_number: 12, state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
      target: { ref_name: 'master' }, creator: { display_name: 'Murugan A' }, completed_on: iso(34), duration_in_seconds: 125 },
    { uuid: '{p2}', build_number: 13, state: { name: 'IN_PROGRESS' }, target: { ref_name: 'master' }, completed_on: null },
  ];

  r = await runPoll();
  console.log('poll 2:', r.message, r.problems);
  console.log('  sent:', labels().join(' | '));
  const want = ['Pull request opened', 'Pull request merged', 'Branch created', 'Commits pushed', 'New comment', 'Pull request approved', 'Pipeline passed'];
  for (const w of want) assert.ok(labels().includes(w), 'missing: ' + w);
  assert.strictEqual(slackSent.length, want.length, 'unexpected extra messages: ' + labels().join(','));
  const opened = slackSent.find((m) => m.text.startsWith('Pull request opened'));
  assert.ok(JSON.stringify(opened).includes('<@U01ABC>'), 'reviewer should be @mentioned');
  const comment = slackSent.find((m) => m.text.startsWith('New comment'));
  assert.ok(JSON.stringify(comment).includes('Looks good &lt;3 &amp; tidy'), 'Slack text must be escaped');
  const push = slackSent.find((m) => m.text.startsWith('Commits pushed'));
  assert.ok(push.text.includes('2 commits pushed to master'), 'push summary: ' + push.text);

  /* 3. same data again: nothing new */
  reset();
  r = await runPoll();
  console.log('poll 3:', r.message);
  assert.strictEqual(slackSent.length, 0, 'no duplicates allowed: ' + labels().join(','));

  /* 4. reviewer change + branch deleted */
  reset();
  world.prs[0].reviewers = [{ display_name: 'Rajesh Kumar' }, { display_name: 'Dinesh Naik' }];
  world.prs[0].updated_on = iso(40);
  world.branches = world.branches.filter((b) => b.name !== 'feature/c');
  r = await runPoll();
  console.log('poll 4:', r.message, '| sent:', labels().join(' | '));
  assert.ok(labels().includes('Reviewers changed'));
  assert.ok(labels().includes('Branch deleted'));
  assert.strictEqual(slackSent.length, 2);

  /* 5. Slack down -> retried on the next poll */
  reset();
  slackFail = true;
  world.activity.unshift({ pull_request: { id: 3, title: 'New PR from test' }, comment: { id: 99, created_on: iso(50), user: { display_name: 'Dinesh Naik' }, content: { raw: 'second comment' } } });
  r = await runPoll();
  console.log('poll 5 (Slack down):', r.problems);
  assert.strictEqual(slackSent.length, 0);
  assert.ok(r.problems.length > 0, 'problem must be reported');
  slackFail = false;
  r = await runPoll();
  console.log('poll 6 (Slack back):', r.message);
  assert.strictEqual(slackSent.length, 1, 'failed message must be retried');

  /* 6. lock stops overlapping polls */
  kv.set('lock:poll', '1');
  r = await runPoll();
  assert.ok(/already running/.test(r.message));
  kv.delete('lock:poll');

  console.log('\nALL TESTS PASSED');
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
