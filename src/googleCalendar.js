const { google } = require('googleapis');
const { getAuthClient } = require('./googleAuth');

/**
 * Fetch today's events from the user's primary Google Calendar.
 * Returns an array of { title, startTime, endTime, location }.
 */
async function getTodayEvents() {
    const auth = getAuthClient();
    if (!auth) return [];

    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    try {
        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: startOfDay,
            timeMax: endOfDay,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 20,
        });

        return (res.data.items || []).map(event => ({
            title: event.summary || 'Untitled Event',
            startTime: event.start?.dateTime || event.start?.date || '',
            endTime: event.end?.dateTime || event.end?.date || '',
            location: event.location || '',
        }));
    } catch (err) {
        console.error('[GoogleCalendar] Error fetching events:', err.message);
        return [];
    }
}

module.exports = { getTodayEvents };
