const { google } = require('googleapis');
const { getAuthClient } = require('./googleAuth');

function toYmdLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isCalendarApiDisabledError(err) {
    const msg = String(err?.message || '');
    return (
        msg.includes('calendar-json.googleapis.com') ||
        msg.includes('accessNotConfigured') ||
        msg.includes('SERVICE_DISABLED')
    );
}

function isInsufficientScopeError(err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('insufficient authentication scopes')) return true;
    if (msg.includes('insufficientpermissions')) return true;
    if (msg.includes('insufficient permissions')) return true;

    const reason = String(err?.response?.data?.error?.errors?.[0]?.reason || '').toLowerCase();
    return reason === 'insufficientpermissions';
}

async function listReadableCalendars(calendar) {
    try {
        const res = await calendar.calendarList.list({
            minAccessRole: 'reader',
            maxResults: 100,
            showHidden: false,
        });

        const items = (res.data.items || []).filter(c => !c.deleted);
        const selected = items.filter(c => c.selected !== false);
        const source = selected.length ? selected : items;
        const calendars = source.map(c => ({ id: c.id, name: c.summary || 'Calendar' }));

        if (!calendars.some(c => c.id === 'primary')) {
            calendars.unshift({ id: 'primary', name: 'Primary' });
        }
        return calendars;
    } catch (err) {
        console.warn('[GoogleCalendar] Calendar list error, falling back to primary:', err.message);
        return [{ id: 'primary', name: 'Primary' }];
    }
}

async function fetchEvents(timeMin, timeMax) {
    const auth = getAuthClient();
    if (!auth) return [];

    const calendar = google.calendar({ version: 'v3', auth });
    const calendars = await listReadableCalendars(calendar);

    try {
        const results = await Promise.all(calendars.map(async (calInfo) => {
            try {
                const res = await calendar.events.list({
                    calendarId: calInfo.id,
                    timeMin,
                    timeMax,
                    singleEvents: true,
                    orderBy: 'startTime',
                    maxResults: 250,
                });
                return { calInfo, events: res.data.items || [] };
            } catch (err) {
                console.warn(`[GoogleCalendar] Failed calendar ${calInfo.id}:`, err.message);
                return { calInfo, events: [] };
            }
        }));

        const seen = new Set();
        const mapped = [];

        for (const pack of results) {
            for (const event of pack.events) {
                const startRaw = event.start?.dateTime || event.start?.date || '';
                const dedupeKey = `${event.iCalUID || event.id || event.summary || 'event'}|${startRaw}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);

                mapped.push({
                    title: event.summary || 'Untitled Event',
                    startTime: startRaw,
                    endTime: event.end?.dateTime || event.end?.date || '',
                    location: event.location || '',
                    calendarName: pack.calInfo.name,
                    allDay: !!(event.start?.date && !event.start?.dateTime),
                });
            }
        }

        mapped.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
        return mapped;
    } catch (err) {
        if (isCalendarApiDisabledError(err)) {
            throw new Error(
                'Google Calendar API is disabled for your Google Cloud project. Enable it in Google Cloud Console, wait 2-5 minutes, then reconnect Google.'
            );
        }

        const msg = String(err?.message || '');
        console.error('[GoogleCalendar] Error fetching events:', msg);
        throw err;
    }
}

/**
 * Fetch today's events from the user's primary Google Calendar.
 */
async function getTodayEvents() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
    return fetchEvents(startOfDay, endOfDay);
}

/**
 * Fetch a broader event window for calendar UI (week/month views).
 * Includes recent and upcoming events around today.
 */
async function getCalendarWindowEvents(daysBack = 7, daysForward = 45) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysForward, 23, 59, 59);
    return fetchEvents(start.toISOString(), end.toISOString());
}

/**
 * Create all-day Google Calendar entries for app tasks/goals that should be worked on today.
 * This writes to the user's primary calendar so they appear on mobile Calendar apps.
 */
async function syncTodayPlanToCalendar(tasks = [], goals = []) {
    const auth = getAuthClient();
    if (!auth) throw new Error('Google not connected');

    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);

    const todayYmd = toYmdLocal(start);
    const tomorrowYmd = toYmdLocal(end);

    const pendingTasks = (tasks || []).filter(t => t.status !== 'completed' && t.deadline && String(t.deadline) <= todayYmd);
    const activeGoals = (goals || []).filter(g => g.status !== 'completed' && g.deadline && String(g.deadline) <= todayYmd);

    const candidates = [
        ...pendingTasks.map(t => ({
            type: 'task',
            id: String(t.id),
            title: t.title,
            due: t.deadline,
            priority: (t.priority || 'medium').toUpperCase(),
        })),
        ...activeGoals.map(g => ({
            type: 'goal',
            id: String(g.id),
            title: g.title,
            due: g.deadline,
            priority: 'HIGH',
        })),
    ];

    if (!candidates.length) {
        return { total: 0, created: 0, skipped: 0 };
    }

    try {
        const existingRes = await calendar.events.list({
            calendarId: 'primary',
            timeMin: start.toISOString(),
            timeMax: end.toISOString(),
            singleEvents: true,
            showDeleted: false,
            maxResults: 250,
        });

        const existing = existingRes.data.items || [];
        const existingKeys = new Set();
        const existingSummaries = new Set();

        existing.forEach((ev) => {
            const k = ev.extendedProperties?.private?.augmentKey;
            if (k) existingKeys.add(String(k));
            if (ev.summary) existingSummaries.add(String(ev.summary).trim().toLowerCase());
        });

        let created = 0;
        let skipped = 0;

        for (const c of candidates) {
            const augmentKey = `${c.type}:${c.id}`;
            const summary = c.type === 'task' ? `AUGMENT TASK: ${c.title}` : `AUGMENT GOAL: ${c.title}`;
            const summaryKey = summary.toLowerCase();

            if (existingKeys.has(augmentKey) || existingSummaries.has(summaryKey)) {
                skipped += 1;
                continue;
            }

            await calendar.events.insert({
                calendarId: 'primary',
                requestBody: {
                    summary,
                    description: `Synced from Augment web app.\nType: ${c.type}\nPriority: ${c.priority}\nDue: ${c.due}`,
                    start: { date: todayYmd },
                    end: { date: tomorrowYmd },
                    colorId: c.type === 'goal' ? '3' : '6',
                    reminders: { useDefault: true },
                    extendedProperties: {
                        private: {
                            augmentKey,
                            augmentType: c.type,
                            augmentId: c.id,
                            augmentDue: c.due,
                            augmentDate: todayYmd,
                        },
                    },
                },
            });
            created += 1;
        }

        return { total: candidates.length, created, skipped };
    } catch (err) {
        if (isCalendarApiDisabledError(err)) {
            throw new Error(
                'Google Calendar API is disabled for your Google Cloud project. Enable it in Google Cloud Console, wait 2-5 minutes, then reconnect Google.'
            );
        }
        if (isInsufficientScopeError(err)) {
            throw new Error(
                'Google authorization is missing calendar write scope. Disconnect Google, then reconnect and approve permissions again.'
            );
        }
        throw err;
    }
}

module.exports = { getTodayEvents, getCalendarWindowEvents, syncTodayPlanToCalendar };
