# Bitbucket -> Slack Notifier (Vercel)

Runs on Vercel with no server of your own and no Bitbucket admin rights.
It checks Bitbucket every minute or two (using an API token) and posts to Slack when:

- a pull request is opened, merged or declined
- commits are pushed to a branch
- a branch is created or deleted
- someone comments on or approves a pull request
- reviewers are added or removed
- a pipeline finishes (passed or failed)

Each event is announced once. The first run only saves what already exists (no flood).

## Setup

1. **Bitbucket token** - https://id.atlassian.com/manage-profile/security/api-tokens
   Create API token with scopes, app = Bitbucket, scopes:
   `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `read:pipeline:bitbucket`
2. **Slack** - api.slack.com/apps -> your app -> Incoming Webhooks -> copy the URL.
3. **GitHub** - push this folder to a new private repository.
4. **Vercel** - Add New Project -> import that repository (no build settings needed).
5. **Redis** - in the Vercel project: Storage -> Create/Connect -> Upstash Redis (free plan).
   This adds UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_*) automatically.
6. **Environment variables** (Project -> Settings -> Environment Variables), see `.env.example`:
   SLACK_WEBHOOK_URL, BITBUCKET_WORKSPACE, BITBUCKET_EMAIL, BITBUCKET_API_TOKEN, POLL_KEY
   (optional: BITBUCKET_REPOS, BITBUCKET_NOTIFY_BRANCHES, SLACK_USERS, POLL_EVENTS)
7. **Redeploy** so the variables are active.
8. **Check** - open  https://YOUR-APP.vercel.app/api/status?key=YOUR_POLL_KEY&test=1
   It shows what is set up and sends a test message to Slack.
9. **Schedule** - something must call  https://YOUR-APP.vercel.app/api/poll?key=YOUR_POLL_KEY  every 1-2 minutes:
   - Free: https://cron-job.org (create a cron job, every 1 minute, that URL)
   - Vercel Pro only: add to vercel.json
     `"crons": [{ "path": "/api/poll", "schedule": "* * * * *" }]` and set CRON_SECRET to the same value as POLL_KEY.
     (Hobby plans only allow daily crons and the deploy fails if you add faster ones.)

## Test offline

    npm test
# PR-notifier
