const { google } = require('googleapis');
const { getAuthClient } = require('./googleAuth');

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

    const messageParts = [
        `From: Augment AI Coach <${emailAddress}>`,
        `To: <${emailAddress}>`,
        'Content-Type: text/plain; charset=utf-8',
        `Subject: ${subject}`,
        '',
        bodyText
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
