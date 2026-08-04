# Email-triggered website changes

An email that names a website and describes a change starts the same edit run the
chat UI starts: plan → apply → pull request → CI → **stop for a human** → merge.

Studio owns everything from "here is an email" onwards. Getting mail *out of the
inbox* is a separate job — pick one of the transports below.

```
inbox ──(transport)──> POST /api/webhook/email-change ──> match site ──> edit job ──> PR ──> you approve ──> live
                                                                    └──> comment on the TED task
```

## The endpoint

`POST /api/webhook/email-change`
Header: `X-Webhook-Secret: $EMAIL_WEBHOOK_SECRET`

```json
{
  "from": "Someone <someone@growth99.com>",
  "subject": "Brew Aesthetics — update the hero",
  "body": "Please change the homepage headline to ...",
  "messageId": "<optional, for de-duplication in your transport>",
  "headers": { "Auto-Submitted": "no" },
  "dryRun": false
}
```

Replies `202 {accepted:true, jobId, siteId, matchedBy, instruction}` when a run
starts, or `200 {accepted:false, reason}` when it declines. It answers 200 on a
decline on purpose — the caller is a mail hook, and a 4xx would make most
transports retry the same message forever.

**Always test with `"dryRun": true` first.** It parses, matches and reports what
it *would* do without touching a repo.

### Environment

| Variable | Purpose |
| --- | --- |
| `EMAIL_WEBHOOK_SECRET` | Shared secret for this endpoint. Falls back to `WEBHOOK_SECRET`. Without one set, the endpoint returns 401 to everybody. |
| `EMAIL_ALLOWED_SENDERS` | Comma-separated addresses or domains. Default `growth99.com`. |
| `TED_API_TOKEN` | READ_WRITE personal API token. **Unset turns TED logging off** and changes nothing else. |
| `TED_BASE` | Default `https://ted.growth99.com`. |
| `TED_REVISIONS_TASK_ID` | Task the requests are filed against. Default `9078`. |
| `TED_AUTH_HEADER` | `bearer` (default) or `x-api-key`. |

## How an email becomes a change

1. **Automated mail is dropped** — `Auto-Submitted` / `Precedence: bulk` headers,
   or an "Out of office" / "Undeliverable" subject. Without this, one auto-reply
   can start a loop.
2. **Sender must be on the allow-list.** `From` is trivially spoofable, so this is
   a second fence behind the shared secret, never the lock itself.
3. **Quoted history is stripped** — everything from the first `On … wrote:`,
   `-----Original Message-----`, or signature marker down. Otherwise last week's
   request gets mixed into this week's.
4. **Website matching, deterministic first** — a domain, repo slug, or exact
   business name found in subject + body. Free, and it cannot invent a site.
   Two different sites named in one email counts as ambiguous, not a match.
5. **Gemini only as a fallback**, constrained to the known site list, and it must
   be ≥60% confident. Below that the email is parked for a human.
6. **The run always waits for approval before merging**, regardless of the site's
   own merge policy — nobody typed this request into Studio, so a person confirms
   it before it reaches a live site.

Everything the mailbox sends, matched or not, is logged to `email-requests.json`
and readable at `GET /api/email-requests` — the first place to look when someone
says "I emailed that and nothing happened".

## TED

A request that gets as far as an edit job is also filed in TED as a comment on
the beta site revisions task (`TED_REVISIONS_TASK_ID`, currently `9078`), so the
delivery team sees it where they already work. The comment carries the parsed
instruction plus who asked, which site, and the Studio job id.

Only accepted requests are posted — a decline, a dry run, or automated mail never
reaches TED, so the task does not fill up with noise. Posting is fail-soft and
happens after the job is queued and the acknowledgement is written: TED being
down or misconfigured costs the comment and nothing else. Failures are a
`console.error`, never a 5xx to the mailbox.

The task id is hard-coded for now. `GET /api/tasks/all?client=<name>` takes a
client filter, so resolving the right task per website is the obvious next step.

## Transport A — Gmail + Apps Script (recommended to start)

No OAuth app review, no DNS changes, no new dependencies, works with a Workspace
account today. Create a filter that labels the relevant mail `studio-changes`,
then add this script at <https://script.google.com> and give it a time trigger
(every 1–5 minutes).

```javascript
const STUDIO_URL = 'https://YOUR-STUDIO-HOST/api/webhook/email-change';
const SECRET     = 'the same value as EMAIL_WEBHOOK_SECRET';
const LABEL      = 'studio-changes';
const DONE_LABEL = 'studio-sent';

function pollStudioChanges() {
  const label = GmailApp.getUserLabelByName(LABEL);
  const done  = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  if (!label) throw new Error('Create the "' + LABEL + '" label and a filter that applies it.');

  label.getThreads(0, 20).forEach(function (thread) {
    const msg = thread.getMessages()[thread.getMessageCount() - 1];  // newest in thread
    const payload = {
      from: msg.getFrom(),
      subject: msg.getSubject(),
      body: msg.getPlainBody(),
      messageId: msg.getId(),
      headers: {
        'Auto-Submitted': msg.getHeader('Auto-Submitted') || '',
        'Precedence': msg.getHeader('Precedence') || ''
      }
    };
    const res = UrlFetchApp.fetch(STUDIO_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Webhook-Secret': SECRET },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    Logger.log(msg.getSubject() + ' -> ' + res.getResponseCode() + ' ' + res.getContentText());
    // Move on whatever the answer was; declines are logged on the Studio side.
    thread.removeLabel(label).addLabel(done);
  });
}
```

Studio must be reachable from Google's servers, so this needs the deployed
instance (or a tunnel) — not `localhost`.

## Transport B — inbound parse service

SendGrid Inbound Parse, Mailgun Routes or Postmark can POST straight to the
endpoint. Cleanest long-term (no polling, instant), but it needs an MX record on
a subdomain such as `changes.growth99.com` and a field mapping from the
provider's payload to `{from, subject, body}`.

## Transport C — IMAP polling inside Studio

Self-contained and needs no third party, but Studio ships with zero npm
dependencies, so this means either adding one or hand-rolling an IMAP client.
Only worth it if A and B are both ruled out.

## Not built yet

- **No UI.** Requests land in `email-requests.json` and matched ones appear in
  Activity like any other run. A screen listing declined/ambiguous emails with a
  "run it anyway" button is the obvious next step.
- **De-duplication is the transport's job.** The endpoint accepts `messageId` and
  logs it, but does not yet refuse a repeat. The Apps Script above avoids
  repeats by re-labelling; a different transport must not send the same message
  twice.
