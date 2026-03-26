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
        extractAndStore(message).catch(err => console.warn('Extraction error:', err.message));

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
        res.status(500).json({ error: 'Failed to generate response. Is Ollama running?' });
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

// ── Tasks ───────────────────────────────────────────────
router.get('/tasks', (req, res) => {
    res.json(db.getTasks());
});

router.post('/tasks', (req, res) => {
    const { goal_id, title, deadline, status, priority } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const result = db.addTask(goal_id || null, title, deadline, status, priority);
    res.json({ id: result.lastInsertRowid, message: 'Task added' });
});

router.patch('/tasks/:id', (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'Status is required' });
    db.updateTaskStatus(req.params.id, status);

    // If completing a task, log activity
    if (status === 'completed') {
        const task = db.getTaskById(req.params.id);
        if (task) db.logActivity('completed_task', task.title, 0);
    }

    res.json({ message: 'Task updated' });
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
async function extractAndStore(message) {
    const extracted = await llm.extractFromMessage(message);

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
        let addedCron = false;
        for (const r of extracted.reminders) {
            db.addReminder(r.title, r.time_rule, r.is_recurring ? 1 : 0);
            addedCron = true;
        }
        if (addedCron) {
            // Tell the scheduler to pick up the new cron jobs immediately
            const { reloadCrons } = require('./scheduler');
            reloadCrons();
        }
    }
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

// ── Google Integrations ─────────────────────────────────
const googleAuth = require('./googleAuth');
const googleCalendar = require('./googleCalendar');
const gmail = require('./gmail');
const { dailyBriefing } = require('./scheduler');

router.get('/google/status', (req, res) => {
    res.json({ connected: googleAuth.isConnected(), hasCredentials: googleAuth.hasCredentials() });
});

router.post('/google/save-credentials', (req, res) => {
    const { client_id, client_secret } = req.body;
    if (!client_id || !client_secret) return res.status(400).json({ error: 'Both client_id and client_secret are required' });
    googleAuth.saveCredentials(client_id, client_secret);
    res.json({ success: true });
});

router.get('/google/auth-url', (req, res) => {
    if (!googleAuth.hasCredentials()) {
        return res.status(400).json({ error: 'Google credentials not configured. Use the Connect Google button to set them up.' });
    }
    const url = googleAuth.getAuthUrl();
    if (!url) return res.status(500).json({ error: 'Failed to generate auth URL' });
    res.json({ url });
});

router.get('/google/callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).send('Missing authorization code');
        await googleAuth.handleCallback(code);
        res.send('<html><body style="background:#0B0B0F;color:#F0F0F5;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h1 style="color:#2DD4A0">✓ Google Connected!</h1><p>You can close this tab and return to Augment AI.</p></div></body></html>');
    } catch (err) {
        res.status(500).send('OAuth error: ' + err.message);
    }
});

router.get('/google/disconnect', (req, res) => {
    googleAuth.disconnect();
    res.json({ success: true });
});

router.get('/google/calendar/today', async (req, res) => {
    try {
        const events = await googleCalendar.getTodayEvents();
        res.json(events);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/google/gmail/unread', async (req, res) => {
    try {
        const emails = await gmail.getUnreadSummary(5);
        res.json(emails);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Test endpoint to manually trigger a daily briefing
router.post('/briefing/trigger', async (req, res) => {
    try {
        await dailyBriefing();
        res.json({ success: true, message: 'Briefing triggered' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
