/**
 * Growth99 Studio — Gmail trigger
 * Inbox: g99emailtrigger@gmail.com
 *
 * This mailbox exists only to receive website change requests, so there is no
 * filter or label to set up: every unread message in the inbox is a request.
 * Each one is POSTed to Studio, then archived so it is never sent twice.
 *
 * SETUP
 *  1. script.google.com  →  New project  →  paste this file
 *  2. Set STUDIO_URL and SECRET below
 *  3. Run `testConnection` once and approve the permission prompt
 *  4. Triggers (clock icon) → Add trigger → pollInbox → Time-driven →
 *     Minutes timer → Every minute
 */

// ── configure these two ──────────────────────────────────────────────────────
// SECRET must match EMAIL_WEBHOOK_SECRET on the Studio server. Keep the real
// value in Apps Script only — it does not belong in this repository.
const STUDIO_URL = 'https://YOUR-STUDIO-URL/api/webhook/email-change';
const SECRET     = 'PASTE_EMAIL_WEBHOOK_SECRET_HERE';
// ─────────────────────────────────────────────────────────────────────────────

const PROCESSED_LABEL = 'studio-sent';
const MAX_PER_RUN = 10;

function pollInbox() {
  const done = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);

  // Unread and in the inbox — anything already handled has been archived.
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
      headers: {
        'Auto-Submitted': msg.getHeader('Auto-Submitted') || '',
        'Precedence': msg.getHeader('Precedence') || ''
      }
    };

    let code = 0, reply = '';
    try {
      const res = UrlFetchApp.fetch(STUDIO_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'X-Webhook-Secret': SECRET,
          // ngrok/cloudflare quick tunnels show an interstitial to browsers;
          // this header tells them we are an API client, not a browser.
          'ngrok-skip-browser-warning': 'true'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      code = res.getResponseCode();
      reply = res.getContentText();
    } catch (err) {
      // Studio unreachable (laptop asleep, tunnel dead, deploy restarting).
      // Leave the mail unread so the next run retries it.
      Logger.log('UNREACHABLE: ' + msg.getSubject() + ' — ' + err);
      return;
    }

    Logger.log(code + ' ' + msg.getSubject() + ' → ' + reply.slice(0, 200));

    // Studio answers 200 for a considered refusal and 202 when a run starts —
    // both are final, so the mail is done either way. Anything else (500, 502)
    // means Studio broke, so leave it unread to retry.
    if (code === 200 || code === 202) {
      thread.markRead().addLabel(done).moveToArchive();
    }
  });
}

/** Run once by hand to grant permissions and confirm Studio is reachable. */
function testConnection() {
  const res = UrlFetchApp.fetch(STUDIO_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Webhook-Secret': SECRET, 'ngrok-skip-browser-warning': 'true' },
    payload: JSON.stringify({
      from: 'g99emailtrigger@gmail.com',
      subject: 'Brew Aesthetics — connection test',
      body: 'Connection test from Apps Script. Change the homepage hero headline.',
      dryRun: true
    }),
    muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' → ' + res.getContentText());
}
