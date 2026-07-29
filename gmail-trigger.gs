/**
 * Growth99 Studio — Gmail trigger
 * Inbox: g99emailtrigger@gmail.com
 *
 * This mailbox exists only to receive website change requests, so there is no
 * filter or label to set up: every unread message in the inbox is a request.
 * Each one is POSTed to Studio, then archived so it is never sent twice.
 *
 * Studio cannot send email, so this script is also its outbox: each run it
 * collects any replies Studio has queued ("ready to review", "shipped",
 * "failed") and sends them on the original thread.
 *
 * SETUP
 *  1. script.google.com  →  New project  →  paste this file
 *  2. Set STUDIO_BASE and SECRET below
 *  3. Run `testConnection` once and approve the permission prompt
 *  4. Triggers (clock icon) → Add trigger → pollInbox → Time-driven →
 *     Minutes timer → Every minute
 */

// ── configure these two ──────────────────────────────────────────────────────
// SECRET must match EMAIL_WEBHOOK_SECRET on the Studio server. Keep the real
// value in Apps Script only — it does not belong in this repository.
const STUDIO_BASE = 'https://g99-website-build-tool.onrender.com';
const SECRET      = 'PASTE_EMAIL_WEBHOOK_SECRET_HERE';
// ─────────────────────────────────────────────────────────────────────────────

const INBOUND_URL = STUDIO_BASE + '/api/webhook/email-change';
const OUTBOX_URL  = STUDIO_BASE + '/api/webhook/email-outbox';
const PROCESSED_LABEL = 'studio-sent';
const MAX_PER_RUN = 10;

function pollInbox() {
  handleIncoming();
  sendQueuedReplies();
}

// ── inbound: unread mail → Studio ───────────────────────────────────────────
function handleIncoming() {
  const done = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
  const threads = GmailApp.search('is:unread in:inbox', 0, MAX_PER_RUN);
  if (!threads.length) return;

  threads.forEach(function (thread) {
    const messages = thread.getMessages();
    const msg = messages[messages.length - 1];   // newest message in the thread

    const payload = {
      from: msg.getFrom(),
      subject: msg.getSubject(),
      body: msg.getPlainBody(),
      messageId: msg.getId(),
      threadId: thread.getId(),                  // so Studio can reply here later
      headers: {
        'Auto-Submitted': msg.getHeader('Auto-Submitted') || '',
        'Precedence': msg.getHeader('Precedence') || ''
      }
    };

    let code = 0, reply = '';
    try {
      const res = post(INBOUND_URL, payload);
      code = res.getResponseCode();
      reply = res.getContentText();
    } catch (err) {
      // Studio unreachable (deploy restarting, network blip). Leave the mail
      // unread so the next run retries it.
      Logger.log('UNREACHABLE: ' + msg.getSubject() + ' — ' + err);
      return;
    }

    Logger.log(code + ' ' + msg.getSubject() + ' → ' + reply.slice(0, 200));

    // Studio answers 200 for a considered refusal and 202 when a run starts —
    // both are final, so the mail is done either way. Anything else (500, 502)
    // means Studio broke, so leave it unread to retry.
    if (code === 200 || code === 202) {
      // Studio decides whether this outcome deserves a reply. It stays silent
      // for automated mail and unknown senders on purpose.
      let body = null;
      try { body = JSON.parse(reply); } catch (e) { /* not JSON — skip the reply */ }
      if (body && body.reply) {
        try { thread.reply(body.reply); } catch (e) { Logger.log('reply failed: ' + e); }
      }
      thread.markRead().addLabel(done).moveToArchive();
    }
  });
}

// ── outbound: replies Studio queued while a run was in flight ───────────────
function sendQueuedReplies() {
  let pending = [];
  try {
    const res = UrlFetchApp.fetch(OUTBOX_URL, {
      method: 'get',
      headers: { 'X-Webhook-Secret': SECRET },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return;
    pending = (JSON.parse(res.getContentText()) || {}).pending || [];
  } catch (e) {
    Logger.log('outbox unreachable: ' + e);
    return;
  }
  if (!pending.length) return;

  const sent = [];
  pending.forEach(function (item) {
    try {
      const thread = GmailApp.getThreadById(item.threadId);
      if (!thread) { sent.push(item.id); return; }   // thread gone — drop it
      thread.reply(item.text);
      sent.push(item.id);
      Logger.log('replied on ' + item.threadId);
    } catch (e) {
      // Leave it queued; the next run retries.
      Logger.log('reply failed for ' + item.id + ': ' + e);
    }
  });

  // Only acknowledge what actually went out, so nothing is silently dropped.
  if (sent.length) {
    try { post(OUTBOX_URL, { ids: sent }); }
    catch (e) { Logger.log('ack failed: ' + e); }
  }
}

function post(url, payload) {
  return UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/** Run once by hand to grant permissions and confirm Studio is reachable. */
function testConnection() {
  const res = post(INBOUND_URL, {
    from: 'g99emailtrigger@gmail.com',
    subject: 'Brew Aesthetics — connection test',
    body: 'Connection test from Apps Script. Change the homepage hero headline.',
    dryRun: true
  });
  Logger.log(res.getResponseCode() + ' → ' + res.getContentText());
}
