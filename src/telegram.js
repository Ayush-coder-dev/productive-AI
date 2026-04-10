const { Telegraf, Markup } = require('telegraf');
const db = require('./db');
const llm = require('./llm');
const contextGraph = require('./contextGraph');
const { detectStreaks } = require('./patternAnalyzer');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? String(process.env.TELEGRAM_CHAT_ID) : null;

const TASKS_PAGE_SIZE = 5;

let bot = null;
let resolvedChatId = ALLOWED_CHAT_ID;
let shutdownHandlersRegistered = false;
let botLaunchInProgress = false;
let botLaunchAttempts = 0;

const BOT_MAX_LAUNCH_ATTEMPTS = 5;
const BOT_RETRY_DELAY_MS = 5000;

// Per-chat flow state for button-driven forms.
const chatStates = new Map();

function getTargetChatId() {
    return resolvedChatId || ALLOWED_CHAT_ID || null;
}

function setChatState(chatId, state) {
    if (!state) {
        chatStates.delete(chatId);
        return;
    }
    chatStates.set(chatId, state);
}

function getChatState(chatId) {
    return chatStates.get(chatId) || null;
}

function normalizeInlineButtons(buttons) {
    if (!Array.isArray(buttons)) return null;
    const rows = [];

    for (const row of buttons) {
        if (!Array.isArray(row) || row.length === 0) continue;
        const normalizedRow = [];

        for (const button of row) {
            if (!button || typeof button.text !== 'string' || typeof button.callback_data !== 'string') continue;
            normalizedRow.push({ text: button.text, callback_data: button.callback_data });
        }

        if (normalizedRow.length > 0) rows.push(normalizedRow);
    }

    return rows.length > 0 ? rows : null;
}

function scheduleBotLaunchRetry(reason = 'unknown') {
    if (!bot || botLaunchAttempts >= BOT_MAX_LAUNCH_ATTEMPTS) {
        console.error('[Telegram] Launch retry exhausted. Please ensure only one bot process is running.');
        return;
    }

    setTimeout(() => {
        launchBot(reason);
    }, BOT_RETRY_DELAY_MS);
}

async function launchBot(retryReason = null) {
    if (!bot || botLaunchInProgress) return;

    botLaunchInProgress = true;
    botLaunchAttempts += 1;

    if (retryReason) {
        console.warn(`[Telegram] Retrying launch (#${botLaunchAttempts}) due to: ${retryReason}`);
    }

    try {
        // Ensure polling mode is clean when bot was previously configured with a webhook.
        await bot.telegram.deleteWebhook();
        await bot.launch({ dropPendingUpdates: false });
        botLaunchAttempts = 0;
        console.log('[Telegram] Bot is running and listening for messages...');
    } catch (err) {
        const message = err?.message || String(err);
        console.error('[Telegram] Failed to start bot:', message);

        // Most common startup conflict: another process is consuming getUpdates.
        if (message.includes('409') || message.toLowerCase().includes('conflict')) {
            scheduleBotLaunchRetry('Telegram polling conflict (409)');
        }
    } finally {
        botLaunchInProgress = false;
    }
}

function getDateStringFromOffset(daysOffset) {
    const date = new Date();
    date.setDate(date.getDate() + daysOffset);
    return date.toISOString().split('T')[0];
}

function parseDateInput(rawInput) {
    const input = String(rawInput || '').trim().toLowerCase();
    if (!input) return { ok: false };

    if (input === 'none' || input === 'skip' || input === 'no') {
        return { ok: true, value: null };
    }

    if (input === 'today') {
        return { ok: true, value: getDateStringFromOffset(0) };
    }

    if (input === 'tomorrow') {
        return { ok: true, value: getDateStringFromOffset(1) };
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
        return { ok: false };
    }

    const parsed = new Date(`${input}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
        return { ok: false };
    }

    return { ok: true, value: input };
}

function parsePriority(inputValue) {
    const input = String(inputValue || '').trim().toLowerCase();
    if (input === 'high' || input === 'h') return 'high';
    if (input === 'medium' || input === 'm') return 'medium';
    if (input === 'low' || input === 'l') return 'low';
    return null;
}

function isAuthorizedChat(chatId) {
    return true;
}

function buildTasksPage(page = 0) {
    const tasks = db.getPendingTasks();
    const totalPages = Math.max(1, Math.ceil(tasks.length / TASKS_PAGE_SIZE));
    const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);

    if (tasks.length === 0) {
        return {
            page: 0,
            text: 'No pending tasks right now.',
            buttons: [
                [{ text: 'Log Task', callback_data: 'add_task_start' }],
                [{ text: 'Menu', callback_data: 'show_menu' }],
            ],
        };
    }

    const start = safePage * TASKS_PAGE_SIZE;
    const visible = tasks.slice(start, start + TASKS_PAGE_SIZE);

    let text = `Pending Tasks (${tasks.length})\nPage ${safePage + 1}/${totalPages}\n\n`;
    visible.forEach((task, index) => {
        const number = start + index + 1;
        text += `${number}. ${task.title}`;
        if (task.deadline) text += `\n   Due: ${task.deadline}`;
        if (task.priority) text += `\n   Priority: ${task.priority}`;
        text += '\n';
    });

    const buttons = [];
    for (const task of visible) {
        const shortTitle = task.title.length > 28 ? `${task.title.slice(0, 28)}...` : task.title;
        buttons.push([{ text: `Complete: ${shortTitle}`, callback_data: `complete_task:${task.id}:${safePage}` }]);
    }

    const navRow = [];
    if (safePage > 0) navRow.push({ text: 'Prev', callback_data: `tasks_page:${safePage - 1}` });
    if (safePage < totalPages - 1) navRow.push({ text: 'Next', callback_data: `tasks_page:${safePage + 1}` });
    if (navRow.length > 0) buttons.push(navRow);

    buttons.push([
        { text: 'Log Task', callback_data: 'add_task_start' },
        { text: 'Menu', callback_data: 'show_menu' },
    ]);

    return { page: safePage, text, buttons };
}

function buildGoalsSummary() {
    const goals = db.getActiveGoals();
    const allTasks = db.getTasks();

    if (goals.length === 0) {
        return 'No active goals right now.';
    }

    let text = `Active Goals (${goals.length})\n\n`;
    goals.forEach((goal, index) => {
        const goalTasks = allTasks.filter((task) => task.goal_id === goal.id);
        const done = goalTasks.filter((task) => task.status === 'completed').length;
        text += `${index + 1}. ${goal.title}\n`;
        text += `   Progress: ${done}/${goalTasks.length} steps`;
        if (goal.deadline) text += ` | Deadline: ${goal.deadline}`;
        text += '\n';
    });

    return text;
}

function buildQuickStatus() {
    const tasks = db.getPendingTasks();
    const goals = db.getActiveGoals();
    const streaks = detectStreaks(db.getActivityLogs(100));

    let text = 'Quick Status\n\n';
    text += `Active Goals: ${goals.length}\n`;
    text += `Pending Tasks: ${tasks.length}\n`;
    text += `Current Streak: ${streaks.currentStreak} days\n`;
    text += `Longest Streak: ${streaks.longestStreak} days\n`;

    if (tasks.length > 0) {
        text += '\nTop Tasks:\n';
        tasks.slice(0, 5).forEach((task, index) => {
            text += `${index + 1}. ${task.title}${task.deadline ? ` (Due: ${task.deadline})` : ''}\n`;
        });
    }

    return text;
}

function mainMenuMarkup() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('Log Task', 'add_task_start'), Markup.button.callback('Show Tasks', 'show_tasks:0')],
        [Markup.button.callback('Show Goals', 'show_goals'), Markup.button.callback('Status', 'show_status')],
        [Markup.button.callback('Morning Briefing', 'briefing_now'), Markup.button.callback('Check-in', 'show_checkin')],
    ]);
}

function checkinMarkup() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('1', 'mood_set:1'),
            Markup.button.callback('2', 'mood_set:2'),
            Markup.button.callback('3', 'mood_set:3'),
            Markup.button.callback('4', 'mood_set:4'),
            Markup.button.callback('5', 'mood_set:5'),
        ],
        [Markup.button.callback('Need Help', 'coach_me'), Markup.button.callback('Menu', 'show_menu')],
    ]);
}

function deadlinePickerMarkup() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('Today', 'task_deadline:today'), Markup.button.callback('Tomorrow', 'task_deadline:tomorrow')],
        [Markup.button.callback('No Deadline', 'task_deadline:none'), Markup.button.callback('Custom Date', 'task_deadline:custom')],
    ]);
}

function priorityPickerMarkup() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('High', 'task_priority:high'),
            Markup.button.callback('Medium', 'task_priority:medium'),
            Markup.button.callback('Low', 'task_priority:low'),
        ],
    ]);
}

async function sendMainMenu(ctx, text = 'Choose an action:') {
    await ctx.reply(text, mainMenuMarkup());
}

async function sendCheckinPrompt(ctx) {
    await ctx.reply('How is your focus level right now? (1 low - 5 great)', checkinMarkup());
}

async function sendTasksPage(ctx, page = 0, edit = false) {
    const { text, buttons } = buildTasksPage(page);
    const options = { reply_markup: { inline_keyboard: buttons } };

    if (edit) {
        try {
            await ctx.editMessageText(text, options);
            return;
        } catch {
            // Fall back to sending a new message.
        }
    }

    await ctx.reply(text, options);
}

async function sendGoalsSummary(ctx, edit = false) {
    const text = buildGoalsSummary();
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Show Tasks', callback_data: 'show_tasks:0' }],
                [{ text: 'Menu', callback_data: 'show_menu' }],
            ],
        },
    };

    if (edit) {
        try {
            await ctx.editMessageText(text, options);
            return;
        } catch {
            // Fall back to sending a new message.
        }
    }

    await ctx.reply(text, options);
}

async function sendStatusSummary(ctx, edit = false) {
    const text = buildQuickStatus();
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Show Tasks', callback_data: 'show_tasks:0' }, { text: 'Show Goals', callback_data: 'show_goals' }],
                [{ text: 'Menu', callback_data: 'show_menu' }],
            ],
        },
    };

    if (edit) {
        try {
            await ctx.editMessageText(text, options);
            return;
        } catch {
            // Fall back to sending a new message.
        }
    }

    await ctx.reply(text, options);
}

async function askTaskDeadline(ctx) {
    await ctx.reply(
        'Set a deadline for this task. Choose a button or type `today`, `tomorrow`, `none`, or `YYYY-MM-DD`.',
        deadlinePickerMarkup()
    );
}

async function askTaskPriority(ctx) {
    await ctx.reply('Choose a priority (or type high/medium/low):', priorityPickerMarkup());
}

async function finalizeTaskCreation(ctx, chatId, priority) {
    const state = getChatState(chatId);
    if (!state || state.mode !== 'add_task') {
        await ctx.reply('Task flow not found. Tap Log Task to start again.');
        return;
    }

    const title = String(state.draft.title || '').trim();
    const deadline = state.draft.deadline || null;
    const normalizedPriority = parsePriority(priority) || 'medium';

    if (!title) {
        setChatState(chatId, null);
        await ctx.reply('Task title is missing. Please start again.');
        return;
    }

    db.addTask(null, title, deadline, 'pending', normalizedPriority);
    db.logActivity('task_created', title, 0);

    setChatState(chatId, null);

    let summary = `Task added: ${title}\nPriority: ${normalizedPriority}`;
    if (deadline) summary += `\nDeadline: ${deadline}`;

    await ctx.reply(summary);
    await sendMainMenu(ctx, 'Saved. What next?');
}

async function handleAddTaskText(ctx, chatId, message) {
    const state = getChatState(chatId);
    if (!state || state.mode !== 'add_task') return false;

    const text = String(message || '').trim();
    if (!text) {
        await ctx.reply('Please send a valid text response.');
        return true;
    }

    if (state.step === 'title') {
        state.draft.title = text;
        state.step = 'deadline';
        setChatState(chatId, state);
        await askTaskDeadline(ctx);
        return true;
    }

    if (state.step === 'deadline_custom' || state.step === 'deadline') {
        const parsed = parseDateInput(text);
        if (!parsed.ok) {
            await ctx.reply('Please send `today`, `tomorrow`, `none`, or a date in `YYYY-MM-DD` format.');
            return true;
        }
        state.draft.deadline = parsed.value;
        state.step = 'priority';
        setChatState(chatId, state);
        await askTaskPriority(ctx);
        return true;
    }

    if (state.step === 'priority') {
        const priority = parsePriority(text);
        if (!priority) {
            await ctx.reply('Please choose High, Medium, or Low.');
            return true;
        }
        await finalizeTaskCreation(ctx, chatId, priority);
        return true;
    }

    setChatState(chatId, null);
    return false;
}

/**
 * Send a message to the active Telegram chat.
 * Used by scheduler for proactive notifications.
 */
async function sendTelegramMessage(text, options = {}) {
    const chatId = getTargetChatId();
    if (!bot || !chatId) {
        console.warn('[Telegram] Cannot send message: bot not started or chat ID unknown.');
        return;
    }

    const message = String(text || '').trim();
    if (!message) return;

    const inlineKeyboard = normalizeInlineButtons(options.buttons);
    const chunks = message.match(/[\s\S]{1,4000}/g) || [];

    try {
        for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index];
            const isLast = index === chunks.length - 1;
            const payload = isLast && inlineKeyboard
                ? { reply_markup: { inline_keyboard: inlineKeyboard } }
                : {};

            try {
                await bot.telegram.sendMessage(chatId, chunk, {
                    parse_mode: 'Markdown',
                    ...payload,
                });
            } catch {
                await bot.telegram.sendMessage(chatId, chunk, payload);
            }
        }
    } catch (err) {
        console.error('[Telegram] Failed to send message:', err.message);
    }
}

/**
 * Start Telegram polling bot.
 */
function startBot() {
    if (!BOT_TOKEN) {
        console.warn('[Telegram] TELEGRAM_BOT_TOKEN missing in .env - Telegram bot disabled.');
        return;
    }

    if (bot) {
        console.log('[Telegram] Bot already started.');
        return;
    }

    bot = new Telegraf(BOT_TOKEN);

    bot.catch((err, ctx) => {
        const updateType = ctx?.updateType || 'unknown';
        console.error(`[Telegram] Unhandled bot error (${updateType}):`, err.message);
    });

    // Allow all chats by default and keep last active chat as proactive target.
    bot.use(async (ctx, next) => {
        if (!ctx.chat) return next();

        const chatId = String(ctx.chat.id);
        resolvedChatId = chatId;
        return next();
    });

    bot.start(async (ctx) => {
        const chatId = String(ctx.chat.id);
        console.log(`[Telegram] Connected chat ID: ${chatId}`);
        if (!ALLOWED_CHAT_ID) {
            console.log(`[Telegram] Tip: set TELEGRAM_CHAT_ID=${chatId} in .env to lock this bot to your chat.`);
        }

        await ctx.reply(
            `Augment AI Coach connected.\n\n` +
            `Chat ID: ${chatId}\n\n` +
            `Use /menu for actions and /id to copy your chat ID.`
        );
        await sendMainMenu(ctx);
    });

    bot.command('id', async (ctx) => {
        await ctx.reply(`Your chat ID is: ${ctx.chat.id}`);
    });

    bot.command('menu', async (ctx) => {
        await sendMainMenu(ctx);
    });

    bot.command('status', async (ctx) => {
        await sendStatusSummary(ctx);
    });

    bot.command('goals', async (ctx) => {
        await sendGoalsSummary(ctx);
    });

    bot.command('tasks', async (ctx) => {
        await sendTasksPage(ctx, 0, false);
    });

    bot.command('checkin', async (ctx) => {
        await sendCheckinPrompt(ctx);
    });

    bot.command('briefing', async (ctx) => {
        await ctx.reply('Generating your briefing...');
        try {
            const { dailyBriefing } = require('./scheduler');
            await dailyBriefing();
        } catch (err) {
            await ctx.reply(`Briefing error: ${err.message}`);
        }
    });

    bot.action('show_menu', async (ctx) => {
        await ctx.answerCbQuery();
        await sendMainMenu(ctx);
    });

    bot.action('show_goals', async (ctx) => {
        await ctx.answerCbQuery();
        await sendGoalsSummary(ctx, true);
    });

    bot.action('show_status', async (ctx) => {
        await ctx.answerCbQuery();
        await sendStatusSummary(ctx, true);
    });

    bot.action('show_checkin', async (ctx) => {
        await ctx.answerCbQuery();
        await sendCheckinPrompt(ctx);
    });

    bot.action(/^show_tasks:(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        await ctx.answerCbQuery();
        await sendTasksPage(ctx, page, true);
    });

    bot.action(/^tasks_page:(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        await ctx.answerCbQuery();
        await sendTasksPage(ctx, page, true);
    });

    bot.action(/^complete_task:(\d+):(\d+)$/, async (ctx) => {
        const taskId = parseInt(ctx.match[1], 10);
        const page = parseInt(ctx.match[2], 10) || 0;
        const task = db.getTaskById(taskId);

        if (task && task.status !== 'completed') {
            db.updateTaskStatus(taskId, 'completed');
            db.logActivity('completed_task', task.title, 0);
            await ctx.answerCbQuery('Task marked completed.');
        } else {
            await ctx.answerCbQuery('Task already completed.');
        }

        await sendTasksPage(ctx, page, true);
    });

    bot.action('add_task_start', async (ctx) => {
        const chatId = String(ctx.chat.id);
        setChatState(chatId, {
            mode: 'add_task',
            step: 'title',
            draft: {
                title: '',
                deadline: null,
            },
        });

        await ctx.answerCbQuery();
        await ctx.reply('Great. Send the task title first.');
    });

    bot.action(/^task_deadline:(today|tomorrow|none|custom)$/, async (ctx) => {
        const chatId = String(ctx.chat.id);
        const state = getChatState(chatId);
        if (!state || state.mode !== 'add_task') {
            await ctx.answerCbQuery('Start with Log Task first.');
            return;
        }

        const choice = ctx.match[1];
        await ctx.answerCbQuery();

        if (choice === 'custom') {
            state.step = 'deadline_custom';
            setChatState(chatId, state);
            await ctx.reply('Send deadline in YYYY-MM-DD format.');
            return;
        }

        if (choice === 'today') state.draft.deadline = getDateStringFromOffset(0);
        if (choice === 'tomorrow') state.draft.deadline = getDateStringFromOffset(1);
        if (choice === 'none') state.draft.deadline = null;

        state.step = 'priority';
        setChatState(chatId, state);
        await askTaskPriority(ctx);
    });

    bot.action(/^task_priority:(high|medium|low)$/, async (ctx) => {
        const chatId = String(ctx.chat.id);
        const state = getChatState(chatId);
        if (!state || state.mode !== 'add_task') {
            await ctx.answerCbQuery('Start with Log Task first.');
            return;
        }

        const priority = ctx.match[1];
        await ctx.answerCbQuery();
        await finalizeTaskCreation(ctx, chatId, priority);
    });

    bot.action(/^mood_set:(\d)$/, async (ctx) => {
        const mood = parseInt(ctx.match[1], 10);
        db.addMoodLog(mood, 'Telegram check-in');
        await ctx.answerCbQuery(`Mood ${mood}/5 logged.`);
        await ctx.reply(`Thanks. Logged your mood as ${mood}/5.`);
    });

    bot.action('briefing_now', async (ctx) => {
        await ctx.answerCbQuery('Generating briefing...');
        try {
            const { dailyBriefing } = require('./scheduler');
            await dailyBriefing();
            await ctx.reply('Briefing generated and sent.');
        } catch (err) {
            await ctx.reply(`Briefing error: ${err.message}`);
        }
    });

    bot.action('coach_me', async (ctx) => {
        await ctx.answerCbQuery('Thinking...');
        try {
            const contextSummary = contextGraph.getContextSummary();
            const message = await llm.generateCoachingMessage(
                contextSummary,
                'User tapped Need Help from a Telegram quick action.'
            );
            await ctx.reply(message || 'Take one small next step now: pick one task and do 10 focused minutes.');
        } catch (err) {
            await ctx.reply(`Could not generate coaching message: ${err.message}`);
        }
    });

    bot.action(/^snooze15:(\d+)$/, async (ctx) => {
        const reminderId = parseInt(ctx.match[1], 10);
        const reminder = db.getReminderById(reminderId);
        const title = reminder?.title || 'Focus task';

        const triggerTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        db.addReminder(`Snoozed: ${title}`, triggerTime, 0);

        const { reloadCrons } = require('./scheduler');
        reloadCrons();

        await ctx.answerCbQuery('Snoozed for 15 minutes.');
        await ctx.reply(`Okay. I will remind you again in 15 minutes for: ${title}`);
    });

    bot.on('text', async (ctx) => {
        const chatId = String(ctx.chat.id);
        const message = String(ctx.message.text || '');

        // Ignore slash commands in generic text handler.
        if (message.startsWith('/')) return;

        // If user is in a form flow, handle that first.
        const consumedByFlow = await handleAddTaskText(ctx, chatId, message);
        if (consumedByFlow) return;

        try {
            const sessionId = `telegram-${chatId}`;

            // Ensure session exists
            try {
                db.createChatSession(sessionId, 'Telegram Chat');
            } catch {
                // Session already exists.
            }

            db.addChatMessage(sessionId, 'user', message);

            // Reuse same extraction pipeline as web chat.
            const routesModule = require('./routes');
            if (typeof routesModule.extractAndStore === 'function') {
                routesModule.extractAndStore(message, sessionId).catch((err) =>
                    console.warn('[Telegram] Extraction error:', err.message)
                );
            }

            db.logActivity('chat', null, 1);

            const contextSummary = contextGraph.getContextSummary();
            const recentChat = db.getRecentChat(sessionId, 6);
            const chatHistoryStr = recentChat
                .reverse()
                .map((chat) => `${chat.role}: ${chat.content}`)
                .join('\n');

            await ctx.sendChatAction('typing');

            const reply = await llm.coachReply(contextSummary, chatHistoryStr, message);
            db.addChatMessage(sessionId, 'assistant', reply);

            await ctx.reply(reply);
        } catch (err) {
            console.error('[Telegram] Chat error:', err);
            await ctx.reply(
                `I could not generate a full reply right now (${err.message}). ` +
                `Please try again in a few seconds.`
            );
        }
    });

    launchBot();

    if (!shutdownHandlersRegistered) {
        shutdownHandlersRegistered = true;
        process.once('SIGINT', () => {
            if (bot) bot.stop('SIGINT');
        });
        process.once('SIGTERM', () => {
            if (bot) bot.stop('SIGTERM');
        });
    }
}

module.exports = { startBot, sendTelegramMessage };
