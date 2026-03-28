const { google } = require('googleapis');
const { getAuthClient } = require('./googleAuth');

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeHeader(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildBrandedEmailHtml(subject, bodyText) {
    const safeSubject = escapeHtml(subject || 'Augment Update');
    const lines = String(bodyText || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const messageHtml = lines.length
        ? lines.map(line => `<p style="margin:0 0 10px 0;color:#D8DCE9;font-size:15px;line-height:1.6;">${escapeHtml(line)}</p>`).join('')
        : '<p style="margin:0;color:#D8DCE9;font-size:15px;line-height:1.6;">You have a new update from Augment AI.</p>';

    return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#07090f;font-family:Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#07090f;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#0f1220;border:1px solid #23283a;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:22px 24px;background:linear-gradient(135deg,#6d5cff,#34d3a2);">
                <div style="font-size:11px;letter-spacing:1.3px;font-weight:700;color:#f7f8ff;text-transform:uppercase;">Augment AI</div>
                <div style="margin-top:7px;font-size:24px;line-height:1.25;font-weight:700;color:#ffffff;">${safeSubject}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 24px 8px 24px;">
                ${messageHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:14px 24px 22px 24px;">
                <div style="padding:12px 14px;border-radius:10px;background:#141a2c;border:1px solid #27314e;">
                  <div style="font-size:12px;color:#9fb0d7;line-height:1.5;">
                    This is an automated update from your Augment AI workspace.
                  </div>
                </div>
              </td>
            </tr>
          </table>
          <div style="max-width:620px;color:#6f7893;font-size:11px;line-height:1.5;text-align:center;margin-top:12px;">
            Augment AI - Strategic productivity coach
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Fetch the latest unread emails from Gmail.
 * Returns an array of { from, subject, snippet }.
 */
async function getUnreadSummary(maxResults = 5) {
    const auth = getAuthClient();
    if (!auth) return [];

    const gmail = google.gmail({ version: 'v1', auth });

    try {
        const res = await gmail.users.messages.list({
            userId: 'me',
            q: 'is:unread category:primary',
            maxResults,
        });

        const messages = res.data.messages || [];
        const results = [];

        for (const msg of messages) {
            const detail = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject'],
            });

            const headers = detail.data.payload?.headers || [];
            const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
            const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
            const snippet = detail.data.snippet || '';

            // Clean the "from" field to just the name
            const fromName = from.includes('<') ? from.split('<')[0].trim().replace(/"/g, '') : from;

            results.push({ from: fromName, subject, snippet });
        }

        return results;
    } catch (err) {
        console.error('[Gmail] Fetch error:', err.message);
        return [];
    }
}

/**
 * Sends an email natively from the authenticated user's account to themselves.
 */
async function sendTaskUpdateEmail(subject, bodyText) {
    const client = getAuthClient(); // Changed from googleAuth.getAuthClient() to getAuthClient() as it's imported
    if (!client) throw new Error('Google not connected');

    const gmail = google.gmail({ version: 'v1', auth: client });

    // Prefer explicit notification target to avoid requiring extra read scopes.
    let emailAddress = process.env.NOTIFICATION_EMAIL || process.env.GMAIL_ADDRESS || '';
    if (!emailAddress) {
        try {
            const profile = await gmail.users.getProfile({ userId: 'me' });
            emailAddress = profile.data.emailAddress || '';
        } catch (err) {
            throw new Error(
                'Unable to resolve recipient email. Set NOTIFICATION_EMAIL in .env or grant gmail.readonly and reconnect Google.'
            );
        }
    }

    const safeSubject = sanitizeHeader(subject || 'Augment Update');
    const plainText = String(bodyText || 'You have a new update from Augment AI.').trim();
    const htmlBody = buildBrandedEmailHtml(safeSubject, plainText);
    const boundary = `----=_Augment_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    const messageParts = [
        `From: Augment AI Coach <${emailAddress}>`,
        `To: <${emailAddress}>`,
        `Subject: ${safeSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        `${plainText}\n\nThis is an automated update from Augment AI.`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        htmlBody,
        '',
        `--${boundary}--`
    ];

    const messageStr = messageParts.join('\n');
    // Gmail API requires base64url encoded string
    const encodedMessage = Buffer.from(messageStr)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    try {
        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedMessage
            }
        });
        console.log(`[Gmail] Task update email sent to ${emailAddress}`);
    } catch (err) {
        console.error('[Gmail] Error sending email:', err.message);
        throw err;
    }
}

module.exports = { getUnreadSummary, sendTaskUpdateEmail };
