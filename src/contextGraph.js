const db = require('./db');

function parseDateLike(value, endOfDayForDateOnly = false) {
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

function getTimeContext(now = new Date()) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
    const hour = now.getHours();

    let dayPart = 'night';
    if (hour >= 5 && hour < 12) dayPart = 'morning';
    else if (hour >= 12 && hour < 17) dayPart = 'afternoon';
    else if (hour >= 17 && hour < 22) dayPart = 'evening';

    return {
        iso: now.toISOString(),
        timezone,
        weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
        localDate: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
        localTime: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        hour,
        dayPart,
        isWeekend: now.getDay() === 0 || now.getDay() === 6,
    };
}

function classifyDeadlines(tasks, now = new Date()) {
    const nowMs = now.getTime();
    const in24hMs = nowMs + 24 * 60 * 60 * 1000;
    const in7dMs = nowMs + 7 * 24 * 60 * 60 * 1000;

    let overdue = 0;
    let due24h = 0;
    let due7d = 0;
    let noDeadline = 0;

    for (const task of tasks) {
        if (!task.deadline) {
            noDeadline++;
            continue;
        }

        const dueDate = parseDateLike(task.deadline, true);
        if (!dueDate) {
            noDeadline++;
            continue;
        }
        const dueAt = dueDate.getTime();

        if (dueAt < nowMs) overdue++;
        else if (dueAt <= in24hMs) due24h++;
        else if (dueAt <= in7dMs) due7d++;
    }

    return { overdue, due24h, due7d, noDeadline };
}

function hoursSince(timestamp) {
    if (!timestamp) return null;
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts)) return null;
    return Math.max(0, (Date.now() - ts) / (1000 * 60 * 60));
}

/**
 * Build a structured context graph from the database.
 * Returns an object representing the user's full context.
 */
function buildContextGraph() {
    const now = new Date();
    const timeContext = getTimeContext(now);

    const goals = db.getActiveGoals();
    const allTasks = db.getTasks();
    const pendingTasks = allTasks.filter((task) => task.status === 'pending');
    const events = db.getUpcomingEvents();
    const habits = db.getHabits();
    const recentActivity = db.getActivityLogs(30);
    const lastActivity = db.getLastActivity();
    const todayMood = db.getTodayMood();
    const memories = db.getUserMemories(20);

    const goalTree = goals.map((goal) => ({
        ...goal,
        tasks: allTasks.filter((task) => task.goal_id === goal.id),
    }));

    const unassignedTasks = pendingTasks.filter((task) => !task.goal_id);
    const deadlineStats = classifyDeadlines(pendingTasks, now);

    return {
        timeContext,
        goals: goalTree,
        unassignedTasks,
        events,
        habits,
        recentActivity,
        lastActivity,
        todayMood,
        memories,
        stats: {
            totalGoals: goals.length,
            totalPendingTasks: pendingTasks.length,
            totalCompletedTasks: allTasks.filter((task) => task.status === 'completed').length,
            highPriorityPending: pendingTasks.filter((task) => task.priority === 'high').length,
            overdueTasks: deadlineStats.overdue,
            dueIn24Hours: deadlineStats.due24h,
            dueIn7Days: deadlineStats.due7d,
            noDeadlineTasks: deadlineStats.noDeadline,
        },
    };
}

/**
 * Generate a concise text summary of the context graph for the LLM system prompt.
 */
function getContextSummary() {
    const ctx = buildContextGraph();
    const lines = [];

    lines.push('## Time Context');
    lines.push(
        `- ${ctx.timeContext.weekday}, ${ctx.timeContext.localDate}, ${ctx.timeContext.localTime} (${ctx.timeContext.timezone}) ` +
        `- ${ctx.timeContext.dayPart}${ctx.timeContext.isWeekend ? ', weekend' : ', weekday'}`
    );

    if (ctx.memories.length > 0) {
        lines.push('## Long-term User Memory');
        ctx.memories.slice(0, 8).forEach((memory) => {
            const weight = Number(memory.importance || 0).toFixed(2);
            lines.push(`- ${memory.mem_key}: ${memory.mem_value} (importance ${weight})`);
        });
    }

    if (ctx.goals.length > 0) {
        lines.push('## Active Goals');
        ctx.goals.forEach((goal) => {
            lines.push(`- ${goal.title} (${goal.type}, progress: ${goal.progress}%, deadline: ${goal.deadline || 'none'})`);
            goal.tasks.slice(0, 6).forEach((task) => {
                lines.push(`  - Task: ${task.title} [${task.status}] (deadline: ${task.deadline || 'none'}, priority: ${task.priority})`);
            });
        });
    }

    if (ctx.unassignedTasks.length > 0) {
        lines.push('## Pending Tasks (No Goal)');
        ctx.unassignedTasks.slice(0, 8).forEach((task) => {
            lines.push(`- ${task.title} (deadline: ${task.deadline || 'none'}, priority: ${task.priority})`);
        });
    }

    if (ctx.events.length > 0) {
        lines.push('## Upcoming Events');
        ctx.events.slice(0, 8).forEach((event) => {
            lines.push(`- ${event.title} on ${event.date} (importance: ${event.importance})`);
        });
    }

    if (ctx.habits.length > 0) {
        lines.push('## Detected Habits');
        ctx.habits.slice(0, 6).forEach((habit) => {
            lines.push(`- ${habit.name}: ${habit.description || ''} (confidence: ${(habit.confidence * 100).toFixed(0)}%)`);
        });
    }

    if (ctx.recentActivity.length > 0) {
        lines.push('## Recent Activity');
        ctx.recentActivity.slice(0, 6).forEach((activity) => {
            lines.push(`- ${activity.action}${activity.task ? `: ${activity.task}` : ''} (${activity.duration_min}min) at ${activity.timestamp}`);
        });
    }

    if (ctx.todayMood) {
        lines.push(`## Mood Today: ${ctx.todayMood.mood}/5${ctx.todayMood.note ? ` (${ctx.todayMood.note})` : ''}`);
    }

    lines.push('## Critical Signals');
    lines.push(
        `- ${ctx.stats.totalGoals} active goals, ${ctx.stats.totalPendingTasks} pending tasks, ` +
        `${ctx.stats.highPriorityPending} high-priority pending`
    );
    lines.push(
        `- Deadlines: ${ctx.stats.overdueTasks} overdue, ${ctx.stats.dueIn24Hours} due in 24h, ${ctx.stats.dueIn7Days} due in 7d, ` +
        `${ctx.stats.noDeadlineTasks} without deadline`
    );

    if (ctx.lastActivity) {
        const hours = hoursSince(ctx.lastActivity.timestamp);
        const human = hours == null ? ctx.lastActivity.timestamp : `${hours.toFixed(1)}h ago`;
        lines.push(`- Last activity: ${ctx.lastActivity.timestamp} (${human})`);
    } else {
        lines.push('- No activity recorded yet.');
    }

    return lines.join('\n');
}

module.exports = { buildContextGraph, getContextSummary, getTimeContext };
