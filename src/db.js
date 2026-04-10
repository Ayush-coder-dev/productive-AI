const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'coach.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT DEFAULT 'productivity',
    deadline TEXT,
    progress INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER,
    title TEXT NOT NULL,
    deadline TEXT,
    status TEXT DEFAULT 'pending',
    priority TEXT DEFAULT 'medium',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date TEXT,
    importance TEXT DEFAULT 'medium',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    task TEXT,
    duration_min INTEGER DEFAULT 0,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    confidence REAL DEFAULT 0.5,
    detected_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proactive_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    trigger TEXT,
    read INTEGER DEFAULT 0,
    sent_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mem_key TEXT UNIQUE NOT NULL,
    mem_value TEXT NOT NULL,
    importance REAL DEFAULT 0.5,
    source TEXT DEFAULT 'chat',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mood_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mood INTEGER NOT NULL CHECK(mood BETWEEN 1 AND 5),
    note TEXT,
    logged_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    subscription_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    time_rule TEXT NOT NULL,
    is_recurring INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Try to add session_id if table already exists (migration)
try {
  db.exec(`ALTER TABLE chat_history ADD COLUMN session_id TEXT`);
} catch (err) {
  // column already exists
}

// Migrate legacy null session_id chats
try {
  const missingSessionCount = db.prepare(`SELECT count(*) as c FROM chat_history WHERE session_id IS NULL`).get().c;
  if (missingSessionCount > 0) {
      const legacyId = 'legacy-chat';
      db.prepare(`INSERT OR IGNORE INTO chat_sessions (id, title) VALUES (?, 'Legacy Chat')`).run(legacyId);
      db.prepare(`UPDATE chat_history SET session_id = ? WHERE session_id IS NULL`).run(legacyId);
  }
} catch(err) {
  console.error("Migration error:", err);
}

// ── Goals ───────────────────────────────────────────────
const addGoal = db.prepare(`INSERT INTO goals (title, type, deadline, progress, status) VALUES (?, ?, ?, ?, ?)`);
const getGoals = db.prepare(`SELECT * FROM goals ORDER BY created_at DESC`);
const getGoalById = db.prepare(`SELECT * FROM goals WHERE id = ?`);
const updateGoalProgress = db.prepare(`UPDATE goals SET progress = ? WHERE id = ?`);
const updateGoalStatus = db.prepare(`UPDATE goals SET status = ? WHERE id = ?`);
const deleteGoal = db.prepare(`DELETE FROM goals WHERE id = ?`);
const getActiveGoals = db.prepare(`SELECT * FROM goals WHERE status = 'active' ORDER BY deadline ASC`);

// ── Tasks ───────────────────────────────────────────────
const addTask = db.prepare(`INSERT INTO tasks (goal_id, title, deadline, status, priority) VALUES (?, ?, ?, ?, ?)`);
const getTasks = db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`);
const getTasksByGoal = db.prepare(`SELECT * FROM tasks WHERE goal_id = ? ORDER BY created_at DESC`);
const updateTaskStatus = db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`);
const getPendingTasks = db.prepare(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY deadline ASC`);
const getTaskById = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
const deleteTask = db.prepare(`DELETE FROM tasks WHERE id = ?`);

// ── Events ──────────────────────────────────────────────
const addEvent = db.prepare(`INSERT INTO events (title, date, importance) VALUES (?, ?, ?)`);
const getEvents = db.prepare(`SELECT * FROM events ORDER BY date ASC`);
const getUpcomingEvents = db.prepare(`SELECT * FROM events WHERE date(date) >= date('now') ORDER BY date ASC`);

// ── Activity Logs ───────────────────────────────────────
const logActivity = db.prepare(`INSERT INTO activity_logs (action, task, duration_min, timestamp) VALUES (?, ?, ?, ?)`);
const getActivityLogs = db.prepare(`SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT ?`);
const getLastActivity = db.prepare(`SELECT * FROM activity_logs ORDER BY timestamp DESC LIMIT 1`);
const getActivityBetween = db.prepare(`SELECT * FROM activity_logs WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`);

// ── Habits ──────────────────────────────────────────────
const addHabit = db.prepare(`INSERT INTO habits (name, description, confidence) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET confidence = ?, description = ?, detected_at = datetime('now')`);
const getHabits = db.prepare(`SELECT * FROM habits ORDER BY confidence DESC`);

// ── Proactive Messages ──────────────────────────────────
const addProactiveMessage = db.prepare(`INSERT INTO proactive_messages (type, content, trigger) VALUES (?, ?, ?)`);
const getRecentProactive = db.prepare(`SELECT * FROM proactive_messages ORDER BY sent_at DESC LIMIT ?`);
const getUnreadProactive = db.prepare(`SELECT * FROM proactive_messages WHERE read = 0 ORDER BY sent_at DESC`);
const markProactiveRead = db.prepare(`UPDATE proactive_messages SET read = 1 WHERE id = ?`);
const getProactiveCountToday = db.prepare(`SELECT COUNT(*) as count FROM proactive_messages WHERE date(sent_at) = date('now')`);
const getLastProactive = db.prepare(`SELECT * FROM proactive_messages ORDER BY sent_at DESC LIMIT 1`);

// â”€â”€ User Memory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const upsertUserMemory = db.prepare(`
  INSERT INTO user_memory (mem_key, mem_value, importance, source, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(mem_key) DO UPDATE SET
    mem_value = excluded.mem_value,
    importance = CASE
      WHEN excluded.importance > user_memory.importance THEN excluded.importance
      ELSE user_memory.importance
    END,
    source = excluded.source,
    updated_at = datetime('now')
`);
const getUserMemories = db.prepare(`SELECT * FROM user_memory ORDER BY importance DESC, updated_at DESC LIMIT ?`);
const getUserMemoryByKey = db.prepare(`SELECT * FROM user_memory WHERE mem_key = ?`);
const deleteUserMemoryByKey = db.prepare(`DELETE FROM user_memory WHERE mem_key = ?`);

// ── Chat Sessions ───────────────────────────────────────
const createChatSession = db.prepare(`INSERT INTO chat_sessions (id, title) VALUES (?, ?)`);
const getChatSessions = db.prepare(`SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 50`);
const updateChatSessionTitle = db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`);
const updateChatSessionTime = db.prepare(`UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`);
const deleteChatSession = db.prepare(`DELETE FROM chat_sessions WHERE id = ?`);

// ── Chat History ────────────────────────────────────────
const addChatMessage = db.prepare(`INSERT INTO chat_history (session_id, role, content) VALUES (?, ?, ?)`);
const getChatHistory = db.prepare(`SELECT * FROM chat_history WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`);
const getRecentChat = db.prepare(`SELECT * FROM chat_history WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`);
const clearChatHistoryForSession = db.prepare(`DELETE FROM chat_history WHERE session_id = ?`);
const clearAllChatHistory = db.prepare(`DELETE FROM chat_history`);

// ── Mood Logs ───────────────────────────────────────────
const addMoodLog = db.prepare(`INSERT INTO mood_logs (mood, note) VALUES (?, ?)`);
const getMoodLogs = db.prepare(`SELECT * FROM mood_logs ORDER BY logged_at DESC LIMIT ?`);
const getTodayMood = db.prepare(`SELECT * FROM mood_logs WHERE date(logged_at) = date('now') ORDER BY logged_at DESC LIMIT 1`);

// ── Push Subscriptions ──────────────────────────────
const addPushSubscription = db.prepare(`INSERT OR REPLACE INTO push_subscriptions (endpoint, subscription_json) VALUES (?, ?)`);
const getPushSubscriptions = db.prepare(`SELECT * FROM push_subscriptions`);
const removePushSubscription = db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`);
const removePushSubscriptionByEndpoint = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`);

// ── Reminders ───────────────────────────────────────────
const addReminder = db.prepare(`INSERT INTO reminders (title, time_rule, is_recurring) VALUES (?, ?, ?)`);
const getActiveReminders = db.prepare(`SELECT * FROM reminders WHERE is_active = 1`);
const getReminderById = db.prepare(`SELECT * FROM reminders WHERE id = ?`);
const deactivateReminder = db.prepare(`UPDATE reminders SET is_active = 0 WHERE id = ?`);
const deleteReminder = db.prepare(`DELETE FROM reminders WHERE id = ?`);

module.exports = {
  db,
  // Goals
  addGoal: (title, type = 'productivity', deadline = null, progress = 0, status = 'active') => addGoal.run(title, type, deadline, progress, status),
  getGoals: () => getGoals.all(),
  getGoalById: (id) => getGoalById.get(id),
  updateGoalProgress: (id, progress) => updateGoalProgress.run(progress, id),
  updateGoalStatus: (id, status) => updateGoalStatus.run(status, id),
  deleteGoal: (id) => deleteGoal.run(id),
  getActiveGoals: () => getActiveGoals.all(),

  // Tasks
  addTask: (goalId, title, deadline = null, status = 'pending', priority = 'medium') => addTask.run(goalId, title, deadline, status, priority),
  getTasks: () => getTasks.all(),
  getTasksByGoal: (goalId) => getTasksByGoal.all(goalId),
  updateTaskStatus: (id, status) => updateTaskStatus.run(status, id),
  getPendingTasks: () => getPendingTasks.all(),
  getTaskById: (id) => getTaskById.get(id),
  deleteTask: (id) => deleteTask.run(id),

  // Events
  addEvent: (title, date, importance = 'medium') => addEvent.run(title, date, importance),
  getEvents: () => getEvents.all(),
  getUpcomingEvents: () => getUpcomingEvents.all(),

  // Activity Logs
  logActivity: (action, task = null, durationMin = 0, timestamp = null) => {
    const ts = timestamp || new Date().toISOString();
    return logActivity.run(action, task, durationMin, ts);
  },
  getActivityLogs: (limit = 50) => getActivityLogs.all(limit),
  getLastActivity: () => getLastActivity.get(),
  getActivityBetween: (start, end) => getActivityBetween.all(start, end),

  // Habits
  addHabit: (name, description, confidence) => addHabit.run(name, description, confidence, confidence, description),
  getHabits: () => getHabits.all(),

  // Proactive Messages
  addProactiveMessage: (type, content, trigger) => addProactiveMessage.run(type, content, trigger),
  getRecentProactive: (limit = 10) => getRecentProactive.all(limit),
  getUnreadProactive: () => getUnreadProactive.all(),
  markProactiveRead: (id) => markProactiveRead.run(id),
  getProactiveCountToday: () => getProactiveCountToday.get().count,
  getLastProactive: () => getLastProactive.get(),

  // User Memory
  upsertUserMemory: (key, value, importance = 0.5, source = 'chat') =>
    upsertUserMemory.run(key, value, importance, source),
  getUserMemories: (limit = 50) => getUserMemories.all(limit),
  getUserMemoryByKey: (key) => getUserMemoryByKey.get(key),
  deleteUserMemoryByKey: (key) => deleteUserMemoryByKey.run(key),

  // Chat Sessions
  createChatSession: (id, title = 'New Chat') => createChatSession.run(id, title),
  getChatSessions: () => getChatSessions.all(),
  updateChatSessionTitle: (id, title) => updateChatSessionTitle.run(title, id),
  updateChatSessionTime: (id) => updateChatSessionTime.run(id),
  deleteChatSession: (id) => {
    clearChatHistoryForSession.run(id);
    deleteChatSession.run(id);
  },

  // Chat History
  addChatMessage: (sessionId, role, content) => {
    if (sessionId) updateChatSessionTime.run(sessionId);
    return addChatMessage.run(sessionId, role, content);
  },
  getChatHistory: (sessionId, limit = 100) => getChatHistory.all(sessionId, limit),
  getRecentChat: (sessionId, limit = 10) => getRecentChat.all(sessionId, limit),
  clearAllChatHistory: () => clearAllChatHistory.run(),

  // Mood
  addMoodLog: (mood, note = null) => addMoodLog.run(mood, note),
  getMoodLogs: (limit = 30) => getMoodLogs.all(limit),
  getTodayMood: () => getTodayMood.get(),

  // Push Subscriptions
  addPushSubscription: (endpoint, json) => addPushSubscription.run(endpoint, json),
  getPushSubscriptions: () => getPushSubscriptions.all(),
  removePushSubscription: (id) => removePushSubscription.run(id),
  removePushSubscriptionByEndpoint: (endpoint) => removePushSubscriptionByEndpoint.run(endpoint),

  // Reminders
  addReminder: (title, timeRule, isRecurring = 0) => addReminder.run(title, timeRule, isRecurring),
  getActiveReminders: () => getActiveReminders.all(),
  getReminderById: (id) => getReminderById.get(id),
  deactivateReminder: (id) => deactivateReminder.run(id),
  deleteReminder: (id) => deleteReminder.run(id),
};
