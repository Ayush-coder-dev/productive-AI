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
        console.error('[Gmail] Error fetching emails:', err.message);
        return [];
    }
}

module.exports = { getUnreadSummary };
