const cron = require('node-cron');
const db = require('./db');
const llm = require('./llm');
const contextGraph = require('./contextGraph');
const { analyzeAndStorePatterns, detectStreaks } = require('./patternAnalyzer');
const { sendPushToAll } = require('./pushNotify');

// Optional Google integrations (gracefully degrade if not connected)
let getTodayEvents, getUnreadSummary;
try {
    getTodayEvents = require('./googleCalendar').getTodayEvents;
    getUnreadSummary = require('./gmail').getUnreadSummary;
} catch { getTodayEvents = async () => []; getUnreadSummary = async () => []; }

let isRunning = false;

/**
 * Generate a rich Daily Morning Briefing and send it as a push notification.
 */
async function dailyBriefing() {
    console.log('[Scheduler] Generating Daily Morning Briefing...');
    try {
        const pendingTasks = db.getPendingTasks();
        const activeGoals = db.getActiveGoals();
        const upcomingEvents = db.getUpcomingEvents();
        const allTasks = db.getTasks();

        // Google integrations (safe to fail)
        let calendarEvents = [];
        let unreadEmails = [];
        try { calendarEvents = await getTodayEvents(); } catch {}
        try { unreadEmails = await getUnreadSummary(5); } catch {}

        // Build context for AI to summarize
        let briefingContext = `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.\n`;
        briefingContext += `\n## Pending Tasks (${pendingTasks.length}):\n`;
        pendingTasks.slice(0, 8).forEach(t => { briefingContext += `- ${t.title}${t.deadline ? ' (due: ' + t.deadline + ')' : ''}\n`; });

        briefingContext += `\n## Active Objectives (${activeGoals.length}):\n`;
        activeGoals.forEach(g => {
            const tc = allTasks.filter(t => t.goal_id === g.id);
            const done = tc.filter(t => t.status === 'completed').length;
            briefingContext += `- ${g.title} — ${done}/${tc.length} steps done\n`;
        });

        if (upcomingEvents.length > 0) {
            briefingContext += `\n## Upcoming Events:\n`;
            upcomingEvents.slice(0, 5).forEach(e => { briefingContext += `- ${e.title} on ${e.date}\n`; });
        }

        if (calendarEvents.length > 0) {
            briefingContext += `\n## Today's Calendar:\n`;
            calendarEvents.forEach(e => {
                const start = e.startTime ? new Date(e.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'All day';
                briefingContext += `- ${start}: ${e.title}\n`;
            });
        }

        if (unreadEmails.length > 0) {
            briefingContext += `\n## Unread Emails (${unreadEmails.length}):\n`;
            unreadEmails.forEach(e => { briefingContext += `- From ${e.from}: "${e.subject}"\n`; });
        }

        const system = `You are a premium AI productivity coach delivering a morning briefing. Summarize the user's day ahead in 3-5 crisp, actionable bullet points. Be specific: mention task names, event times, and email senders. Close with a single motivating sentence. Do NOT use clichés.`;
        const briefing = await llm.generate(briefingContext, system, { temperature: 0.7, num_predict: 300 });

        if (briefing && briefing.trim()) {
            db.addProactiveMessage('briefing', briefing.trim(), 'Daily Morning Briefing');
            sendPushToAll('☀️ Your Morning Briefing', briefing.trim().substring(0, 200), 'briefing').catch(() => {});
            console.log('[Scheduler] Morning briefing sent.');
        }
    } catch (err) {
        console.error('[Scheduler] Briefing error:', err.message);
    }
}

/**
 * The cognitive loop: Observe → Think → Decide → Act → Reflect
 * Runs every hour to evaluate proactive triggers.
 */
async function cognitiveLoop() {
    if (isRunning) return;
    isRunning = true;
    console.log('[Scheduler] Running cognitive loop...');

    try {
        // ── OBSERVE ──────────────────────────────────────
        const lastActivity = db.getLastActivity();
        const pendingTasks = db.getPendingTasks();
        const activeGoals = db.getActiveGoals();
        const upcomingEvents = db.getUpcomingEvents();
        const logs = db.getActivityLogs(100);
        const todayMessageCount = db.getProactiveCountToday();

        // Rate limit: max 2 proactive messages per day
        if (todayMessageCount >= 2) {
            console.log('[Scheduler] Daily proactive message limit reached (2). Skipping.');
            isRunning = false;
            return;
        }

        // ── THINK & DECIDE ───────────────────────────────
        const triggers = [];
        const now = new Date();

        // 1. Inactivity check (>48 hours since last activity)
        if (lastActivity) {
            const lastTime = new Date(lastActivity.timestamp);
            const hoursSince = (now - lastTime) / (1000 * 60 * 60);
            if (hoursSince >= 48) {
                triggers.push({
                    type: 'reminder',
                    reason: `User has been inactive for ${Math.round(hoursSince)} hours.`,
                    priority: 2,
                });
            }
        } else if (db.getChatHistory(1).length > 0) {
            // User has chatted but never logged activity
            triggers.push({
                type: 'advice',
                reason: 'User has chatted but never logged any activity.',
                priority: 1,
            });
        }

        // 2. Upcoming deadlines (<24 hours) with low progress
        for (const task of pendingTasks) {
            if (task.deadline) {
                const deadline = new Date(task.deadline);
                const hoursUntil = (deadline - now) / (1000 * 60 * 60);
                if (hoursUntil > 0 && hoursUntil < 24) {
                    triggers.push({
                        type: 'reminder',
                        reason: `Task "${task.title}" is due in ${Math.round(hoursUntil)} hours and still pending.`,
                        priority: 3,
                    });
                }
            }
        }

        for (const goal of activeGoals) {
            if (goal.deadline) {
                const deadline = new Date(goal.deadline);
                const hoursUntil = (deadline - now) / (1000 * 60 * 60);
                if (hoursUntil > 0 && hoursUntil < 24 && goal.progress < 70) {
                    triggers.push({
                        type: 'challenge',
                        reason: `Goal "${goal.title}" deadline is in ${Math.round(hoursUntil)} hours but progress is only ${goal.progress}%.`,
                        priority: 4,
                    });
                }
            }
        }

        // 3. Missed tasks (past deadline, still pending)
        const missedTasks = pendingTasks.filter(t => t.deadline && new Date(t.deadline) < now);
        if (missedTasks.length > 0) {
            triggers.push({
                type: 'challenge',
                reason: `${missedTasks.length} task(s) have passed their deadline: ${missedTasks.map(t => t.title).join(', ')}`,
                priority: 3,
            });
        }

        // 4. Broken streaks
        const streaks = detectStreaks(logs);
        if (streaks.longestStreak >= 3 && streaks.currentStreak === 0) {
            triggers.push({
                type: 'motivation',
                reason: `User had a ${streaks.longestStreak}-day streak but it's now broken. Time to restart.`,
                priority: 2,
            });
        }

        // 5. Upcoming events
        for (const event of upcomingEvents) {
            const eventDate = new Date(event.date);
            const daysUntil = (eventDate - now) / (1000 * 60 * 60 * 24);
            if (daysUntil > 0 && daysUntil <= 3 && event.importance === 'high') {
                triggers.push({
                    type: 'reminder',
                    reason: `Important event "${event.title}" is in ${Math.round(daysUntil)} day(s).`,
                    priority: 3,
                });
            }
        }

        // No triggers? Skip.
        if (triggers.length === 0) {
            console.log('[Scheduler] No triggers fired.');
            isRunning = false;
            return;
        }

        // Pick the highest priority trigger
        triggers.sort((a, b) => b.priority - a.priority);
        const topTrigger = triggers[0];
        console.log(`[Scheduler] Trigger fired: ${topTrigger.type} - ${topTrigger.reason}`);

        // ── ACT ──────────────────────────────────────────
        const contextSummary = contextGraph.getContextSummary();
        const message = await llm.generateCoachingMessage(contextSummary, topTrigger.reason);

        if (message && message.trim()) {
            db.addProactiveMessage(topTrigger.type, message.trim(), topTrigger.reason);
            console.log(`[Scheduler] Proactive message sent: ${message.trim().substring(0, 80)}...`);

            // Send browser push notification
            sendPushToAll(
                'Augment AI • ' + topTrigger.type.charAt(0).toUpperCase() + topTrigger.type.slice(1),
                message.trim(),
                topTrigger.type
            ).catch(err => console.warn('[Push] Error:', err.message));
        }

        // ── REFLECT ──────────────────────────────────────
        analyzeAndStorePatterns();
        console.log('[Scheduler] Pattern analysis updated.');

    } catch (err) {
        console.error('[Scheduler] Error in cognitive loop:', err.message);
    } finally {
        isRunning = false;
    }
}

let activeCrons = {};

/**
 * Reload dynamically scheduled cron reminders.
 */
function reloadCrons() {
    Object.values(activeCrons).forEach(task => task.stop());
    activeCrons = {};

    const reminders = db.getActiveReminders();
    for (const r of reminders) {
        if (cron.validate(r.time_rule)) {
            activeCrons[r.id] = cron.schedule(r.time_rule, () => {
                const msg = `It's time for to focus on: ${r.title}`;
                db.addProactiveMessage('reminder', msg, 'Scheduled cron reminder');
                sendPushToAll('Augment AI • Reminder', msg, 'reminder').catch(()=>{});
                
                if (!r.is_recurring) {
                    db.deactivateReminder(r.id);
                    reloadCrons();
                }
            });
        }
    }
}

/**
 * Start the scheduler. Runs cognitive loop every hour, briefing every morning, and sets up reminders.
 */
function startScheduler() {
    console.log('[Scheduler] Starting proactive scheduler and reminder engine...');

    // Run cognitive loop every hour
    cron.schedule('0 * * * *', () => {
        cognitiveLoop();
    });

    // Daily Morning Briefing at 8:00 AM
    cron.schedule('0 8 * * *', () => {
        dailyBriefing();
    });

    // Also run cognitive loop once on startup after a short delay
    setTimeout(() => {
        cognitiveLoop();
    }, 5000);

    // Load initial cron reminders
    reloadCrons();

    // Minute-by-minute check for ISO date (one-off) reminders
    cron.schedule('* * * * *', () => {
        const reminders = db.getActiveReminders();
        const now = Date.now();
        for (const r of reminders) {
            if (!cron.validate(r.time_rule)) {
                const triggerTime = new Date(r.time_rule).getTime();
                if (triggerTime && now >= triggerTime) {
                    const msg = `Reminder: ${r.title}`;
                    db.addProactiveMessage('reminder', msg, 'Scheduled time reminder');
                    sendPushToAll('Augment AI • Reminder', msg, 'reminder').catch(()=>{});
                    db.deactivateReminder(r.id);
                }
            }
        }
    });
}

module.exports = { startScheduler, cognitiveLoop, reloadCrons, dailyBriefing };
