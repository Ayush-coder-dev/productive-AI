const express = require('express');
const router = express.Router();
const db = require('./db');
const llm = require('./llm');
const contextGraph = require('./contextGraph');
const analytics = require('./analytics');
const { analyzeAndStorePatterns, detectStreaks } = require('./patternAnalyzer');
const { cognitiveLoop } = require('./scheduler');
const crypto = require('crypto');
const { VAPID_PUBLIC } = require('./pushNotify');

// ── Chat ────────────────────────────────────────────────
router.post('/chat', async (req, res) => {
    try {
        let { message, session_id } = req.body;
        if (!message) return res.status(400).json({ error: 'Message is required' });

        // Generate session ID if not provided
        let isNewSession = false;
        if (!session_id) {
            session_id = crypto.randomUUID();
            db.createChatSession(session_id, 'New Chat');
            isNewSession = true;
        }

        // Save user message
        db.addChatMessage(session_id, 'user', message);

        // Extract structured data from message in background
        extractAndStore(message, session_id).catch(err => console.warn('Extraction error:', err.message));

        // Log a chat activity
        db.logActivity('chat', null, 1);

        // Build context and recent chat
        const contextSummary = contextGraph.getContextSummary();
        const recentChat = db.getRecentChat(session_id, 6);
        const chatHistoryStr = recentChat.reverse().map(m => `${m.role}: ${m.content}`).join('\n');

        // Generate reply
        const replyPromise = llm.coachReply(contextSummary, chatHistoryStr, message);
        
        // If it's a new session, optionally generate a title concisely in the background
        if (isNewSession) {
            llm.generateChatTitle(message).then(title => {
                if(title) db.updateChatSessionTitle(session_id, title);
            }).catch(() => {});
        }

        const reply = await replyPromise;

        // Save assistant reply
        db.addChatMessage(session_id, 'assistant', reply);

        res.json({ reply, session_id, extracted: true });
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: `AI error: ${err.message}` });
    }
});

router.get('/chat/sessions', (req, res) => {
    res.json(db.getChatSessions());
});

router.delete('/chat/sessions/:id', (req, res) => {
    db.deleteChatSession(req.params.id);
    res.json({ message: 'Session deleted' });
});

router.get('/chat/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const sessionId = req.query.session_id;
    if (!sessionId) return res.json([]);
    res.json(db.getChatHistory(sessionId, limit));
});

// ── Goals ───────────────────────────────────────────────
router.get('/goals', (req, res) => {
    const goals = db.getGoals();
    const tasks = db.getTasks();
    // Attach tasks to each goal
    const enriched = goals.map(g => ({
        ...g,
        tasks: tasks.filter(t => t.goal_id === g.id),
    }));
    res.json(enriched);
});

router.post('/goals', (req, res) => {
    const { title, type, deadline, progress, status } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const result = db.addGoal(title, type, deadline, progress, status);
    res.json({ id: result.lastInsertRowid, message: 'Goal added' });
});

router.patch('/goals/:id', (req, res) => {
    const { progress, status } = req.body;
    if (progress !== undefined) db.updateGoalProgress(req.params.id, progress);
    if (status) db.updateGoalStatus(req.params.id, status);
    res.json({ message: 'Goal updated' });
});

router.delete('/goals/:id', (req, res) => {
    db.deleteGoal(req.params.id);
    res.json({ message: 'Goal discarded' });
});

// ── Tasks ───────────────────────────────────────────────
router.get('/tasks', (req, res) => {
    res.json(db.getTasks());
});

router.post('/tasks', async (req, res) => {
    const { goal_id, title, deadline, status, priority } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const result = db.addTask(goal_id || null, title, deadline, status, priority);
    
    res.json({ id: result.lastInsertRowid, message: 'Task added' });
});

router.patch('/tasks/:id', async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });
    db.updateTaskStatus(req.params.id, status);

    const task = db.getTaskById(req.params.id);

    // If completing a task, log activity
    if (status === 'completed' && task) {
        db.logActivity('completed_task', task.title, 0);
    }

    res.json({ message: 'Task updated' });
});

router.delete('/tasks/:id', (req, res) => {
    db.deleteTask(req.params.id);
    res.json({ message: 'Task deleted' });
});

// ── Events ──────────────────────────────────────────────
router.get('/events', (req, res) => {
    res.json(db.getEvents());
});

router.post('/events', (req, res) => {
    const { title, date, importance } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    db.addEvent(title, date, importance);
    res.json({ message: 'Event added' });
});

// ── Reminders ───────────────────────────────────────────
router.get('/reminders/active', (req, res) => {
    res.json(db.getActiveReminders());
});

// ── Activity ────────────────────────────────────────────
router.get('/activity', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(db.getActivityLogs(limit));
});

router.post('/activity', (req, res) => {
    const { action, task, duration_min, timestamp } = req.body;
    if (!action) return res.status(400).json({ error: 'Action is required' });
    db.logActivity(action, task, duration_min || 0, timestamp);
    res.json({ message: 'Activity logged' });
});

// ── Analytics ───────────────────────────────────────────
router.get('/analytics/daily', (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    res.json(analytics.getDailyStats(date));
});

router.get('/analytics/weekly', (req, res) => {
    const date = req.query.start || (() => {
        const d = new Date();
        d.setDate(d.getDate() - d.getDay()); // start of week (Sunday)
        return d.toISOString().split('T')[0];
    })();
    res.json(analytics.getWeeklyStats(date));
});

router.get('/analytics/monthly', (req, res) => {
    const month = req.query.month || new Date().toISOString().substring(0, 7);
    res.json(analytics.getMonthlyStats(month));
});

router.get('/analytics/timeline', (req, res) => {
    const days = parseInt(req.query.days) || 30;
    res.json(analytics.getProductivityTimeline(days));
});

// ── Habits ──────────────────────────────────────────────
router.get('/habits', (req, res) => {
    res.json(db.getHabits());
});

router.post('/habits/analyze', (req, res) => {
    const habits = analyzeAndStorePatterns();
    res.json({ habits, message: 'Pattern analysis complete' });
});

// ── Proactive Messages ──────────────────────────────────
router.get('/proactive', (req, res) => {
    res.json(db.getRecentProactive(10)); // For the sidebar feed
});

router.get('/proactive/unread', (req, res) => {
    res.json(db.getUnreadProactive()); // For the popups
});

router.patch('/proactive/:id/read', (req, res) => {
    db.markProactiveRead(req.params.id);
    res.json({ message: 'Marked as read' });
});

// ── Streaks ─────────────────────────────────────────────
router.get('/streaks', (req, res) => {
    const logs = db.getActivityLogs(200);
    res.json(detectStreaks(logs));
});

// ── Context ─────────────────────────────────────────────
router.get('/context', (req, res) => {
    res.json(contextGraph.buildContextGraph());
});

router.get('/memory', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(db.getUserMemories(limit));
});

router.delete('/memory/:key', (req, res) => {
    db.deleteUserMemoryByKey(req.params.key);
    res.json({ message: 'Memory deleted' });
});

// ── Trigger (manual) ────────────────────────────────────
router.post('/trigger', async (req, res) => {
    try {
        await cognitiveLoop();
        res.json({ message: 'Cognitive loop triggered' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Helper: extract data from chat and store ────────────
async function extractAndStore(message, sessionId = null) {
    const extracted = await llm.extractFromMessage(message);
    let reminderConfigChanged = false;
    const relativeReminderTime = parseRelativeReminderTime(message);
    const removeAllByMessage = shouldRemoveAllReminders(message);

    if (extracted.goals) {
        for (const g of extracted.goals) {
            const res = db.addGoal(g.title, g.type || 'productivity', g.deadline || null);
            if (g.roadmap_steps && Array.isArray(g.roadmap_steps)) {
                for (const step of g.roadmap_steps) {
                    db.addTask(res.lastInsertRowid, step, null, 'pending', 'medium');
                }
            }
        }
    }
    if (extracted.tasks) {
        for (const t of extracted.tasks) {
            // Try to link to a goal
            let goalId = null;
            if (t.goal_title) {
                const goals = db.getGoals();
                const match = goals.find(g => g.title.toLowerCase().includes(t.goal_title.toLowerCase()));
                if (match) goalId = match.id;
            }
            db.addTask(goalId, t.title, t.deadline || null, 'pending', t.priority || 'medium');
        }
    }
    if (extracted.events) {
        for (const e of extracted.events) {
            db.addEvent(e.title, e.date, e.importance || 'medium');
        }
    }
    if (extracted.activities) {
        for (const a of extracted.activities) {
            db.logActivity(a.action, a.task || null, a.duration_min || 0);
        }
    }
    if (extracted.reminders) {
        for (const r of extracted.reminders) {
            let title = String(r.title || '').trim();
            let timeRule = typeof r.time_rule === 'string' ? r.time_rule.trim() : '';
            let isRecurring = r.is_recurring ? 1 : 0;

            // Hard guardrail: any relative-time reminder in message is always one-time ISO.
            if (relativeReminderTime) {
                timeRule = relativeReminderTime;
                isRecurring = 0;
            }

            if (!title) title = inferReminderTitleFromMessage(message) || 'Reminder';
            if (!timeRule) continue;

            // Avoid duplicate active reminders for same title (common after repeated "in 10 sec" tests).
            const activeReminders = db.getActiveReminders();
            const titleNorm = title.toLowerCase();
            for (const existing of activeReminders) {
                const existingNorm = String(existing.title || '').trim().toLowerCase();
                const sameTopic = existingNorm === titleNorm || existingNorm.includes(titleNorm) || titleNorm.includes(existingNorm);
                if (sameTopic) {
                    db.deactivateReminder(existing.id);
                }
            }

            db.addReminder(title, timeRule, isRecurring);
            reminderConfigChanged = true;
        }
    }
    if (extracted.remove_reminders || removeAllByMessage) {
        const activeReminders = db.getActiveReminders();
        const removeConfig = extracted.remove_reminders || {};
        const mode = removeConfig.match_mode === 'exact' ? 'exact' : 'contains';
        const titles = Array.isArray(removeConfig.titles)
            ? removeConfig.titles.map(t => String(t || '').trim().toLowerCase()).filter(Boolean)
            : [];

        const shouldRemoveAll = !!removeConfig.all || removeAllByMessage || (!titles.length && /reminder|cron/i.test(String(message || '')));

        if (shouldRemoveAll) {
            for (const r of activeReminders) db.deactivateReminder(r.id);
            reminderConfigChanged = activeReminders.length > 0 || reminderConfigChanged;
        } else if (titles.length > 0) {
            for (const r of activeReminders) {
                const title = String(r.title || '').toLowerCase();
                const isMatch = titles.some(t => mode === 'exact' ? title === t : title.includes(t));
                if (isMatch) {
                    db.deactivateReminder(r.id);
                    reminderConfigChanged = true;
                }
            }
        }
    }
    if (reminderConfigChanged) {
        // Tell the scheduler to pick up reminder changes immediately.
        const { reloadCrons } = require('./scheduler');
        reloadCrons();
    }

    try {
        await extractAndStoreMemories(message, sessionId);
    } catch (err) {
        console.warn('Memory extraction error:', err.message);
    }
}

function normalizeMemoryKey(rawKey) {
    const key = String(rawKey || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!key) return '';
    return key.slice(0, 64);
}

function clampImportance(rawImportance) {
    const n = Number(rawImportance);
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
}

async function extractAndStoreMemories(message, sessionId = null) {
    if (!message || String(message).trim().split(/\s+/).length < 4) return;

    let recentChat = '';
    try {
        let selectedSessionId = sessionId;
        if (!selectedSessionId) {
            const sessions = db.getChatSessions();
            if (sessions.length > 0) selectedSessionId = sessions[0].id;
        }

        if (selectedSessionId) {
            recentChat = db.getRecentChat(selectedSessionId, 8)
                .reverse()
                .map(m => `${m.role}: ${m.content}`)
                .join('\n');
        }
    } catch {
        recentChat = '';
    }

    const contextSummary = contextGraph.getContextSummary();
    const memoryResult = await llm.extractUserMemories(message, recentChat, contextSummary);
    if (!memoryResult || !Array.isArray(memoryResult.memories)) return;

    for (const memory of memoryResult.memories) {
        const key = normalizeMemoryKey(memory.key);
        const value = String(memory.value || '').trim();
        if (!key || !value) continue;

        const importance = clampImportance(memory.importance);
        db.upsertUserMemory(key, value.slice(0, 500), importance, 'chat');
    }
}

function parseRelativeReminderTime(message) {
    if (!message) return null;
    const text = String(message).toLowerCase();
    const match = text.match(/\b(?:in|after)\s*(\d+)\s*(seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)\b/);
    if (!match) return null;

    const amount = parseInt(match[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const unit = match[2];
    let ms = 0;
    if (unit === 's' || unit.startsWith('sec')) ms = amount * 1000;
    else if (unit === 'm' || unit.startsWith('min')) ms = amount * 60 * 1000;
    else ms = amount * 60 * 60 * 1000;

    return new Date(Date.now() + ms).toISOString();
}

function inferReminderTitleFromMessage(message) {
    if (!message) return '';
    const raw = String(message);
    const text = raw.toLowerCase();

    const afterFor = text.match(/\bfor\s+(.+)$/);
    if (afterFor && afterFor[1]) {
        const cleaned = afterFor[1]
            .replace(/\b(?:in|after)\s*\d+\s*(?:seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)\b/gi, '')
            .replace(/[.?!]+$/g, '')
            .trim();
        if (cleaned.length >= 2) return cleaned;
    }

    const remindTo = text.match(/\bremind me to\s+(.+)$/);
    if (remindTo && remindTo[1]) {
        const cleaned = remindTo[1]
            .replace(/\b(?:in|after)\s*\d+\s*(?:seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h)\b/gi, '')
            .replace(/[.?!]+$/g, '')
            .trim();
        if (cleaned.length >= 2) return cleaned;
    }

    return '';
}

function shouldRemoveAllReminders(message) {
    if (!message) return false;
    const text = String(message).toLowerCase();
    const hasRemoveVerb = /\b(remove|delete|cancel|clear|discard|stop)\b/.test(text);
    const hasReminderWord = /\b(reminder|reminders|cron|crons)\b/.test(text);
    return hasRemoveVerb && hasReminderWord;
}

// ── Productivity Score ──────────────────────────────────
router.get('/analytics/score', (req, res) => {
    res.json(analytics.getProductivityScore());
});

// ── Mood ────────────────────────────────────────────────
router.get('/mood', (req, res) => {
    const limit = parseInt(req.query.limit) || 30;
    res.json(db.getMoodLogs(limit));
});

router.get('/mood/today', (req, res) => {
    res.json(db.getTodayMood() || null);
});

router.post('/mood', (req, res) => {
    const { mood, note } = req.body;
    if (!mood || mood < 1 || mood > 5) return res.status(400).json({ error: 'Mood must be 1-5' });
    db.addMoodLog(mood, note || null);
    res.json({ message: 'Mood logged' });
});

// ── Clear Chat ──────────────────────────────────────────
router.delete('/chat/history', (req, res) => {
    db.clearAllChatHistory();
    res.json({ message: 'Chat history cleared' });
});

// ── Push Notifications ──────────────────────────────────
router.get('/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC });
});

router.post('/push/subscribe', (req, res) => {
    try {
        const subscription = req.body;
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ error: 'Invalid subscription' });
        }
        db.addPushSubscription(subscription.endpoint, JSON.stringify(subscription));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/push/unsubscribe', (req, res) => {
    try {
        const { endpoint } = req.body;
        if (endpoint) db.removePushSubscriptionByEndpoint(endpoint);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const { dailyBriefing } = require('./scheduler');

// Test endpoint to manually trigger a daily briefing
router.post('/briefing/trigger', async (req, res) => {
    try {
        await dailyBriefing();
        res.json({ success: true, message: 'Briefing triggered' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.extractAndStore = extractAndStore;
module.exports = router;
