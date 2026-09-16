// Sending invite emails.
//
// Deliberately dependency-free: SendGrid over plain HTTPS using the fetch
// built into Node 18+. Nothing to install, nothing to break a deploy.
//
// If it isn't configured, nothing fails — the invite link comes back to the
// administrator on screen so they can pass it on themselves.

function mailerStatus() {
  const key = process.env.SENDGRID_API_KEY;
  const from = process.env.INVITE_FROM_EMAIL;
  if (!key) return { configured: false, reason: 'SENDGRID_API_KEY is not set' };
  if (!from) return { configured: false, reason: 'INVITE_FROM_EMAIL is not set' };
  return { configured: true, from };
}

function inviteHtml({ link, invitedBy }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0b1f2a">
    <div style="background:#07354D;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
      <div style="font-size:20px;font-weight:800">Serial Number Scanner</div>
      <div style="opacity:.8;font-size:14px">Carter &amp; Carter</div>
    </div>
    <div style="border:1px solid #e3e8ee;border-top:none;border-radius:0 0 12px 12px;padding:24px">
      <p style="font-size:16px;margin:0 0 16px">${escapeHtml(invitedBy)} has invited you to the appliance scanner.</p>
      <p style="font-size:15px;color:#4a5763;margin:0 0 24px">
        Use the button below to set your password. The link works once and expires in 14 days.
      </p>
      <p style="margin:0 0 24px">
        <a href="${link}" style="background:#1a9e4f;color:#fff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px;display:inline-block">Set your password</a>
      </p>
      <p style="font-size:13px;color:#7b8794;margin:0">
        If the button doesn't work, paste this into your browser:<br>
        <span style="word-break:break-all">${link}</span>
      </p>
      <p style="font-size:13px;color:#7b8794;margin:18px 0 0">
        If you weren't expecting this, you can ignore it — nothing happens until someone sets a password.
      </p>
    </div>
  </div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function sendInviteEmail({ to, link, invitedBy }) {
  const status = mailerStatus();
  if (!status.configured) return { ok: false, error: status.reason };

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.INVITE_FROM_EMAIL, name: 'Carter & Carter Scanner' },
        subject: 'Your invite to the Serial Number Scanner',
        content: [
          { type: 'text/plain', value: `${invitedBy} has invited you to the Carter & Carter appliance scanner.\n\nSet your password here (expires in 14 days):\n${link}\n` },
          { type: 'text/html', value: inviteHtml({ link, invitedBy }) },
        ],
      }),
    });

    if (response.status >= 200 && response.status < 300) return { ok: true };
    const detail = await response.text();
    console.error('[mailer] SendGrid rejected the invite:', response.status, detail.slice(0, 400));
    return { ok: false, error: `Email service returned ${response.status}` };
  } catch (err) {
    console.error('[mailer] Could not reach SendGrid:', err.message);
    return { ok: false, error: 'Could not reach the email service' };
  }
}

module.exports = { sendInviteEmail, mailerStatus };
