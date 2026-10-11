/**
 * Sends the account emails (verify address, reset password).
 *
 * Uses Brevo's HTTP API because Railway blocks outgoing SMTP. Without EMAIL_API_KEY the
 * message is printed to the server log instead, so verification still works in development:
 * copy the link from the log.
 *
 *   EMAIL_API_KEY     Brevo API key (Settings > SMTP & API > API keys)
 *   EMAIL_FROM        a sender address verified in Brevo, e.g. you@gmail.com
 *   EMAIL_FROM_NAME   shown as the sender (default StudyMate)
 */
const API_KEY = process.env.EMAIL_API_KEY || '';
const FROM = process.env.EMAIL_FROM || '';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'StudyMate';

const enabled = Boolean(API_KEY && FROM);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(heading, body, link, label) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f6f4ee;padding:24px;color:#101828">
<div style="max-width:520px;margin:auto;background:#fff;border:1px solid #e2ded3;border-radius:12px;padding:28px">
<h2 style="margin:0 0 12px">${escapeHtml(heading)}</h2>
<p style="line-height:1.5">${body}</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#c2410c;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">${escapeHtml(label)}</a></p>
<p style="font-size:13px;color:#667085;line-height:1.5">If the button does not work, open this link:<br>${escapeHtml(link)}</p>
<p style="font-size:13px;color:#667085">If you did not ask for this, you can ignore this email.</p>
</div></body></html>`;
}

async function send(to, subject, html, text) {
  if (!enabled) {
    console.log(`[email] (not sent: EMAIL_API_KEY/EMAIL_FROM not set)\n  to: ${to}\n  subject: ${subject}\n  ${text}`);
    return { delivered: false };
  }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: FROM, name: FROM_NAME },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[email] Brevo refused the message (${res.status}): ${detail.slice(0, 300)}`);
    throw Object.assign(new Error('EMAIL_SEND_FAILED'), { status: 502 });
  }
  return { delivered: true };
}

function sendVerification(to, name, link) {
  return send(
    to,
    'Confirm your StudyMate email',
    layout(`Welcome, ${name}`, 'Confirm your email address to start using StudyMate. The link works for 24 hours.', link, 'Confirm email'),
    `Confirm your StudyMate email (valid 24 hours): ${link}`
  );
}

function sendPasswordReset(to, name, link) {
  return send(
    to,
    'Reset your StudyMate password',
    layout(`Hi ${name}`, 'Someone asked to reset your StudyMate password. The link works for one hour and signs you out everywhere.', link, 'Choose a new password'),
    `Reset your StudyMate password (valid 1 hour): ${link}`
  );
}

module.exports = { enabled, sendVerification, sendPasswordReset };
