/**
 * Growth99 Studio — Gmail trigger
 * Inbox: g99emailtrigger@gmail.com
 *
 * This mailbox exists only to receive website change requests, so there is no
 * filter to set up: every message in the inbox is a request. Each one is
 * POSTed to Studio, then labelled and archived so it is never sent twice.
 * Reading a message here is safe — only the label decides what has been done.
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

const PROCESSED_LABEL = 'studio-sent';
const MAX_PER_RUN = 10;

// Built inside functions rather than as top-level constants: one const reading
// another at file scope breaks with a bare "X is not defined" if the config
// line above is edited or renamed, which says nothing useful about the cause.
function inboundUrl() { return base() + '/api/webhook/email-change'; }
function outboxUrl()  { return base() + '/api/webhook/email-outbox'; }
function base() {
  if (typeof STUDIO_BASE === 'undefined' || !STUDIO_BASE) {
    throw new Error('STUDIO_BASE is not set. The config line near the top of this file must read: ' +
                    "const STUDIO_BASE = 'https://g99-website-build-tool.onrender.com';  (origin only, no path)");
  }
  return String(STUDIO_BASE).replace(/\/+$/, '');   // tolerate a trailing slash
}

function pollInbox() {
  handleIncoming();
  sendQueuedReplies();
}

// ── inbound: unread mail → Studio ───────────────────────────────────────────
function handleIncoming() {
  const done = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
  // Keyed on the label, not on unread. Opening a message in Gmail marks it
  // read, so anyone glancing at this mailbox used to make the request
  // invisible to the trigger — it just never ran, with nothing in the log to
  // say why. A label only changes when this script changes it.
  const threads = GmailApp.search('in:inbox -label:' + PROCESSED_LABEL, 0, MAX_PER_RUN);
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
      const res = post(inboundUrl(), payload);
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
        try { replyToRequester(thread, body.reply); } catch (e) { Logger.log("reply failed: " + e); }
      }
      thread.markRead().addLabel(done).moveToArchive();
    }
  });
}

// ── outbound: replies Studio queued while a run was in flight ───────────────
function sendQueuedReplies() {
  let pending = [];
  try {
    const res = UrlFetchApp.fetch(outboxUrl(), {
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
      replyToRequester(thread, item.text);
      sent.push(item.id);
      Logger.log('replied on ' + item.threadId);
    } catch (e) {
      // Leave it queued; the next run retries.
      Logger.log('reply failed for ' + item.id + ': ' + e);
    }
  });

  // Only acknowledge what actually went out, so nothing is silently dropped.
  if (sent.length) {
    try { post(outboxUrl(), { ids: sent }); }
    catch (e) { Logger.log('ack failed: ' + e); }
  }
}

// thread.reply() answers the LAST message in the thread. Once we have replied
// once, that last message is our own, so a second reply is addressed to this
// mailbox instead of the person who asked — it appears in the thread but never
// reaches them. Always answer the newest message that is not from us.
function replyToRequester(thread, text) {
  const msgs = thread.getMessages();
  let me = '';
  try { me = (Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { /* no scope */ }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const from = (msgs[i].getFrom() || '').toLowerCase();
    if (!me || from.indexOf(me) === -1) { msgs[i].reply(text); return; }
  }
  msgs[0].reply(text);   // whole thread is ours — answer the opening message
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
  const res = post(inboundUrl(), {
    from: 'g99emailtrigger@gmail.com',
    subject: 'Brew Aesthetics — connection test',
    body: 'Connection test from Apps Script. Change the homepage hero headline.',
    dryRun: true
  });
  Logger.log(res.getResponseCode() + ' → ' + res.getContentText());
}
