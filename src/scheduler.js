const cron = require('node-cron');
const db = require('./db');
const llm = require('./llm');
const contextGraph = require('./contextGraph');
const { analyzeAndStorePatterns, detectStreaks } = require('./patternAnalyzer');
const { sendPushToAll } = require('./pushNotify');
const { sendTelegramMessage } = require('./telegram');

const PROACTIVE_TYPES = new Set(['reminder', 'challenge', 'motivation', 'advice', 'planning', 'reflection', 'briefing']);
const DAILY_PROACTIVE_LIMIT = Number.parseInt(process.env.PROACTIVE_DAILY_LIMIT || '3', 10);
const PROACTIVE_COOLDOWN_MINUTES = Number.parseInt(process.env.PROACTIVE_COOLDOWN_MINUTES || '120', 10);
const NIGHT_START_HOUR = Number.parseInt(process.env.PROACTIVE_NIGHT_START_HOUR || '22', 10);
const NIGHT_END_HOUR = Number.parseInt(process.env.PROACTIVE_NIGHT_END_HOUR || '7', 10);

let isRunning = false;
let activeCrons = {};

function toDateOrNull(value, endOfDayForDateOnly = false) {
    if (!value) return null;
    const text = String(value).trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const iso = endOfDayForDateOnly ? `${text}T23:59:59` : `${text}T00:00:00`;
        const localDate = new Date(iso);
        return Number.isFinite(localDate.getTime()) ? localDate : null;
    }

    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function clamp(number, min, max) {
    return Math.max(min, Math.min(max, number));
}

function hoursBetween(from, to = new Date()) {
    const fromDate = toDateOrNull(from);
    if (!fromDate) return null;
    return (to.getTime() - fromDate.getTime()) / (1000 * 60 * 60);
}

function minutesBetween(from, to = new Date()) {
    const fromDate = toDateOrNull(from);
    if (!fromDate) return null;
    return (to.getTime() - fromDate.getTime()) / (1000 * 60);
}

function daysUntil(dateLike, now = new Date()) {
    const date = toDateOrNull(dateLike, false);
    if (!date) return null;
    return (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
}

function isQuietHours(hour) {
    if (NIGHT_START_HOUR === NIGHT_END_HOUR) return false;
    if (NIGHT_START_HOUR < NIGHT_END_HOUR) {
        return hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
    }
    return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

function hasUrgentSignal(signals) {
    return (
        signals.overdueTasks.length > 0 ||
        signals.dueSoonTasks.length > 0 ||
        signals.stalledGoals.length > 0 ||
        signals.importantEvents.length > 0
    );
}

function formatTriggerTitle(type) {
    const normalized = String(type || 'advice').toLowerCase();
    const label = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    return `Augment AI - ${label}`;
}

function buildFallbackMessage(decision, signals, timeContext) {
    const type = String(decision.type || 'advice').toLowerCase();
    const dayPart = timeContext.dayPart || 'today';

    if (type === 'challenge' && signals.overdueTasks.length > 0) {
        const taskTitle = signals.overdueTasks[0].title;
        return `You have overdue work (${signals.overdueTasks.length} task${signals.overdueTasks.length > 1 ? 's' : ''}). Start with "${taskTitle}" for a focused 15-minute sprint right now.`;
    }

    if (type === 'reminder' && signals.dueSoonTasks.length > 0) {
        const task = signals.dueSoonTasks[0];
        return `"${task.title}" is due soon. In this ${dayPart}, lock a 20-minute block and ship the first concrete step.`;
    }

    if (type === 'motivation' && signals.inactivityHours != null) {
        return `It's been about ${Math.round(signals.inactivityHours)} hours since your last activity. Restart momentum with one small win in the next 10 minutes.`;
    }

    return `Quick reset for this ${dayPart}: choose one meaningful task and work distraction-free for 15 minutes.`;
}

function collectSignals(now = new Date()) {
    const pendingTasks = db.getPendingTasks();
    const activeGoals = db.getActiveGoals();
    const upcomingEvents = db.getUpcomingEvents();
    const activityLogs = db.getActivityLogs(120);
    const streaks = detectStreaks(activityLogs);
    const lastActivity = db.getLastActivity();
    const todayMood = db.getTodayMood();
    const lastProactive = db.getLastProactive();
    const todayProactiveCount = db.getProactiveCountToday();

    const overdueTasks = [];
    const dueSoonTasks = [];
    const dueWeekTasks = [];

    for (const task of pendingTasks) {
        const dueDate = toDateOrNull(task.deadline, true);
        if (!dueDate) continue;

        const diffHours = (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60);
        if (diffHours < 0) {
            overdueTasks.push({ id: task.id, title: task.title, hoursLate: Math.abs(diffHours) });
        } else if (diffHours <= 24) {
            dueSoonTasks.push({ id: task.id, title: task.title, hoursUntil: diffHours });
        } else if (diffHours <= 24 * 7) {
            dueWeekTasks.push({ id: task.id, title: task.title, daysUntil: diffHours / 24 });
        }
    }

    const stalledGoals = activeGoals
        .map((goal) => {
            const daysLeft = daysUntil(goal.deadline, now);
            return { ...goal, daysLeft };
        })
        .filter((goal) => goal.daysLeft != null && goal.daysLeft <= 7 && goal.daysLeft >= 0 && Number(goal.progress || 0) < 60)
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .slice(0, 5);

    const importantEvents = upcomingEvents
        .map((event) => {
            const daysLeft = daysUntil(event.date, now);
            return { ...event, daysLeft };
        })
        .filter((event) => event.daysLeft != null && event.daysLeft >= 0 && event.daysLeft <= 3 && event.importance === 'high')
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .slice(0, 5);

    return {
        pendingTasksCount: pendingTasks.length,
        highPriorityPending: pendingTasks.filter((task) => task.priority === 'high').length,
        overdueTasks: overdueTasks.slice(0, 5),
        dueSoonTasks: dueSoonTasks.slice(0, 5),
        dueWeekTasks: dueWeekTasks.slice(0, 5),
        stalledGoals,
        importantEvents,
        inactivityHours: hoursBetween(lastActivity?.timestamp, now),
        todayMood,
        streaks,
        todayProactiveCount,
        lastProactive,
    };
}

function shouldSkipNow(signals, timeContext, now = new Date()) {
    const minutesSinceLast = minutesBetween(signals.lastProactive?.sent_at, now);

    return {
        skip: false,
        reasons: [],
        minutesSinceLastProactive: minutesSinceLast,
        quietHours: false,
    };
}

function buildDecisionContext(signals, guardrails, timeContext) {
    const context = {
        now: {
            weekday: timeContext.weekday,
            localDate: timeContext.localDate,
            localTime: timeContext.localTime,
            dayPart: timeContext.dayPart,
            isWeekend: timeContext.isWeekend,
            timezone: timeContext.timezone,
        },
        notificationPolicy: {
            dailyLimit: DAILY_PROACTIVE_LIMIT,
            sentToday: signals.todayProactiveCount,
            cooldownMinutes: PROACTIVE_COOLDOWN_MINUTES,
            minutesSinceLastProactive: guardrails.minutesSinceLastProactive,
            quietHoursActive: guardrails.quietHours,
        },
        signals: {
            inactivityHours: signals.inactivityHours,
            pendingTasksCount: signals.pendingTasksCount,
            highPriorityPending: signals.highPriorityPending,
            overdueTasks: signals.overdueTasks.map((task) => ({
                title: task.title,
                hoursLate: Math.round(task.hoursLate),
            })),
            dueSoonTasks: signals.dueSoonTasks.map((task) => ({
                title: task.title,
                hoursUntil: Math.round(task.hoursUntil),
            })),
            dueThisWeekTasks: signals.dueWeekTasks.map((task) => ({
                title: task.title,
                daysUntil: Number(task.daysUntil.toFixed(1)),
            })),
            stalledGoals: signals.stalledGoals.map((goal) => ({
                title: goal.title,
                progress: goal.progress,
                daysLeft: Number(goal.daysLeft.toFixed(1)),
            })),
            importantEvents: signals.importantEvents.map((event) => ({
                title: event.title,
                daysLeft: Number(event.daysLeft.toFixed(1)),
            })),
            streaks: {
                current: signals.streaks.currentStreak,
                longest: signals.streaks.longestStreak,
            },
            todayMood: signals.todayMood
                ? {
                      mood: signals.todayMood.mood,
                      note: signals.todayMood.note || '',
                  }
                : null,
        },
    };

    return JSON.stringify(context, null, 2);
}

function fallbackDecision(signals, timeContext) {
    if (signals.overdueTasks.length > 0) {
        return {
            send: true,
            type: 'challenge',
            priority: 5,
            reason: `${signals.overdueTasks.length} overdue task(s) need immediate rescue.`,
            tone_hint: 'firm, clear, action-first',
        };
    }

    if (signals.dueSoonTasks.length > 0) {
        return {
            send: true,
            type: 'reminder',
            priority: 4,
            reason: `At least one task is due within 24 hours.`,
            tone_hint: 'calm urgency with concrete next step',
        };
    }

    if (signals.stalledGoals.length > 0) {
        return {
            send: true,
            type: 'planning',
            priority: 4,
            reason: `Goal deadline is near and progress is low.`,
            tone_hint: 'strategic and practical',
        };
    }

    if (signals.inactivityHours != null && signals.inactivityHours >= 48) {
        return {
            send: true,
            type: 'motivation',
            priority: 3,
            reason: `Inactivity has crossed ${Math.round(signals.inactivityHours)} hours.`,
            tone_hint: 'warm, low-pressure restart',
        };
    }

    if (signals.todayMood && Number(signals.todayMood.mood) <= 2) {
        return {
            send: true,
            type: 'advice',
            priority: 3,
            reason: `Low mood detected today, better to suggest a gentle reset.`,
            tone_hint: 'empathetic and gentle',
        };
    }

    if ((timeContext.dayPart === 'morning' || timeContext.dayPart === 'afternoon') && signals.pendingTasksCount > 0) {
        return {
            send: true,
            type: 'planning',
            priority: 2,
            reason: `A lightweight planning nudge can improve execution for the day.`,
            tone_hint: 'structured and concise',
        };
    }

    return {
        send: false,
        type: 'advice',
        priority: 1,
        reason: 'No strong signal for interruption right now.',
        tone_hint: 'neutral',
    };
}

function sanitizeDecision(rawDecision, fallback) {
    const decision = rawDecision && typeof rawDecision === 'object' ? rawDecision : fallback;

    const send = typeof decision.send === 'boolean' ? decision.send : fallback.send;
    const typeRaw = String(decision.type || fallback.type || 'advice').toLowerCase();
    const type = PROACTIVE_TYPES.has(typeRaw) ? typeRaw : 'advice';
    const priorityRaw = Number(decision.priority);
    const fallbackPriority = Number(fallback.priority) || 3;
    const priority = clamp(Number.isFinite(priorityRaw) ? priorityRaw : fallbackPriority, 1, 5);
    const reason = String(decision.reason || fallback.reason || 'No reason provided.').trim();
    const toneHint = String(decision.tone_hint || fallback.tone_hint || 'direct and concise').trim();

    return { send, type, priority, reason, tone_hint: toneHint };
}

function formatTimeContextForPrompt(timeContext, signals, guardrails) {
    const lines = [];
    lines.push(
        `${timeContext.weekday}, ${timeContext.localDate}, ${timeContext.localTime} (${timeContext.timezone}) - ${timeContext.dayPart}`
    );

    if (signals.inactivityHours != null) {
        lines.push(`Inactivity: ${signals.inactivityHours.toFixed(1)}h since last recorded activity`);
    }

    if (guardrails.minutesSinceLastProactive != null) {
        lines.push(`Last proactive sent ${Math.round(guardrails.minutesSinceLastProactive)}m ago`);
    } else {
        lines.push('No previous proactive message logged yet');
    }

    if (signals.todayMood) {
        lines.push(`Mood today: ${signals.todayMood.mood}/5`);
    }

    return lines.join('\n');
}

/**
 * Generate a rich Daily Morning Briefing and send it across all channels.
 */
async function dailyBriefing() {
    console.log('[Scheduler] Generating Daily Morning Briefing...');
    try {
        const ctx = contextGraph.buildContextGraph();
        const signals = collectSignals(new Date());

        const briefingContextParts = [];
        briefingContextParts.push(`Date: ${ctx.timeContext.weekday}, ${ctx.timeContext.localDate}`);
        briefingContextParts.push(`Local time: ${ctx.timeContext.localTime} (${ctx.timeContext.timezone})`);
        briefingContextParts.push(`Pending tasks: ${signals.pendingTasksCount} (${signals.highPriorityPending} high priority)`);
        briefingContextParts.push(`Overdue tasks: ${signals.overdueTasks.length}`);
        briefingContextParts.push(`Due in 24h: ${signals.dueSoonTasks.length}`);

        if (ctx.memories && ctx.memories.length > 0) {
            briefingContextParts.push('Important long-term user context:');
            ctx.memories.slice(0, 5).forEach((memory) => {
                briefingContextParts.push(`- ${memory.mem_key}: ${memory.mem_value}`);
            });
        }

        if (ctx.goals && ctx.goals.length > 0) {
            briefingContextParts.push('Active goals:');
            ctx.goals.slice(0, 5).forEach((goal) => {
                briefingContextParts.push(`- ${goal.title} (${goal.progress}% progress, deadline: ${goal.deadline || 'none'})`);
            });
        }

        if (ctx.events && ctx.events.length > 0) {
            briefingContextParts.push('Upcoming events:');
            ctx.events.slice(0, 5).forEach((event) => {
                briefingContextParts.push(`- ${event.title} on ${event.date} (${event.importance})`);
            });
        }

        const system =
            'You are a high-quality AI productivity coach writing a morning briefing.' +
            ' Return 4-6 short bullets that are specific and prioritized, then one final line with the single most important next action.' +
            ' Mention urgency windows (today / next 24h) where relevant and avoid generic motivation.';

        const briefing = await llm.generate(briefingContextParts.join('\n'), system, {
            temperature: 0.65,
            num_predict: 320,
        });

        if (briefing && briefing.trim()) {
            const text = briefing.trim();
            db.addProactiveMessage('briefing', text, 'Daily Morning Briefing');

            sendPushToAll('Your Morning Briefing', text.substring(0, 220), 'briefing').catch(() => {});
            sendTelegramMessage(`*Morning Briefing*\n\n${text}`, {
                buttons: [
                    [
                        { text: 'Show Tasks', callback_data: 'show_tasks:0' },
                        { text: 'Log Task', callback_data: 'add_task_start' },
                    ],
                    [{ text: 'Menu', callback_data: 'show_menu' }],
                ],
            }).catch(() => {});

            console.log('[Scheduler] Morning briefing sent.');
        }
    } catch (err) {
        console.error('[Scheduler] Briefing error:', err.message);
    }
}

/**
 * Cognitive loop: Observe -> Reason -> Decide -> Act -> Reflect.
 */
async function cognitiveLoop() {
    if (isRunning) return;
    isRunning = true;
    console.log('[Scheduler] Running cognitive loop...');

    try {
        const now = new Date();
        const timeContext = contextGraph.getTimeContext(now);
        const signals = collectSignals(now);
        const guardrails = shouldSkipNow(signals, timeContext, now);

        if (guardrails.skip) {
            console.log(`[Scheduler] Skipped proactive send: ${guardrails.reasons.join('; ')}`);
            return;
        }

        const contextSummary = contextGraph.getContextSummary();
        const decisionContext = buildDecisionContext(signals, guardrails, timeContext);

        const fallback = fallbackDecision(signals, timeContext);
        let modelDecision = null;

        try {
            modelDecision = await llm.reasonProactiveAction(contextSummary, decisionContext);
        } catch (err) {
            console.warn(`[Scheduler] Reasoning fallback due to error: ${err.message}`);
        }

        const decision = sanitizeDecision(modelDecision, fallback);

        const timeContextPrompt = formatTimeContextForPrompt(timeContext, signals, guardrails);
        const message = await llm.generateCoachingMessage(contextSummary, decision.reason, {
            timeContext: timeContextPrompt,
            toneHint: decision.tone_hint,
        });

        const text = message && message.trim() ? message.trim() : buildFallbackMessage(decision, signals, timeContext);
        const title = formatTriggerTitle(decision.type);

        db.addProactiveMessage(decision.type, text, decision.reason);
        console.log(`[Scheduler] Proactive message sent [${decision.type}/p${decision.priority}]: ${decision.reason}`);

        sendPushToAll(title, text, decision.type).catch((err) => {
            console.warn('[Push] Error:', err.message);
        });
        sendTelegramMessage(`*${title.replace('Augment AI - ', '')}*\n\n${text}`, {
            buttons: [
                [
                    { text: 'Show Tasks', callback_data: 'show_tasks:0' },
                    { text: 'Need Help', callback_data: 'coach_me' },
                ],
                [{ text: 'Menu', callback_data: 'show_menu' }],
            ],
        }).catch(() => {});

        analyzeAndStorePatterns();
        console.log('[Scheduler] Pattern analysis updated.');
    } catch (err) {
        console.error('[Scheduler] Error in cognitive loop:', err.message);
    } finally {
        isRunning = false;
    }
}

/**
 * Reload dynamically scheduled cron reminders.
 */
function reloadCrons() {
    Object.values(activeCrons).forEach((task) => task.stop());
    activeCrons = {};

    const reminders = db.getActiveReminders();
    for (const reminder of reminders) {
        if (!cron.validate(reminder.time_rule)) continue;

        activeCrons[reminder.id] = cron.schedule(reminder.time_rule, () => {
            const msg = `It's time to focus on: ${reminder.title}`;
            db.addProactiveMessage('reminder', msg, 'Scheduled cron reminder');
            sendPushToAll('Augment AI - Reminder', msg, 'reminder').catch(() => {});
            sendTelegramMessage(`*Reminder*\n\n${msg}`, {
                buttons: [
                    [{ text: 'Snooze 15m', callback_data: `snooze15:${reminder.id}` }],
                    [
                        { text: 'Show Tasks', callback_data: 'show_tasks:0' },
                        { text: 'Need Help', callback_data: 'coach_me' },
                    ],
                ],
            }).catch(() => {});

            if (!reminder.is_recurring) {
                db.deactivateReminder(reminder.id);
                reloadCrons();
            }
        });
    }
}

/**
 * Start scheduler jobs.
 */
function startScheduler() {
    console.log('[Scheduler] Starting proactive scheduler and reminder engine...');

    // Run cognitive loop every 30 minutes.
    cron.schedule('*/30 * * * *', () => {
        cognitiveLoop();
    });

    // Daily Morning Briefing at 8:00 AM.
    cron.schedule('0 8 * * *', () => {
        dailyBriefing();
    });

    // Run one cycle shortly after startup.
    setTimeout(() => {
        cognitiveLoop();
    }, 5000);

    // Load cron-based reminders.
    reloadCrons();

    // One-off ISO reminder checker.
    cron.schedule('*/2 * * * * *', () => {
        const reminders = db.getActiveReminders();
        const now = Date.now();

        for (const reminder of reminders) {
            if (cron.validate(reminder.time_rule)) continue;

            const triggerTime = new Date(reminder.time_rule).getTime();
            if (!Number.isFinite(triggerTime) || now < triggerTime) continue;

            const msg = `Reminder: ${reminder.title}`;
            db.addProactiveMessage('reminder', msg, 'Scheduled time reminder');
            sendPushToAll('Augment AI - Reminder', msg, 'reminder').catch(() => {});
            sendTelegramMessage(`*Reminder*\n\n${msg}`, {
                buttons: [
                    [{ text: 'Snooze 15m', callback_data: `snooze15:${reminder.id}` }],
                    [
                        { text: 'Show Tasks', callback_data: 'show_tasks:0' },
                        { text: 'Need Help', callback_data: 'coach_me' },
                    ],
                ],
            }).catch(() => {});

            db.deactivateReminder(reminder.id);
        }
    });
}

module.exports = { startScheduler, cognitiveLoop, reloadCrons, dailyBriefing };
