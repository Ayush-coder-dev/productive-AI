# Telegram Mobile Interface Setup

This app can run as a Telegram chat interface while your local laptop does all LLM processing.

## How Message Flow Works

1. You send a message from Telegram on mobile.
2. Telegram cloud forwards it to your running Node.js app (polling bot).
3. Node.js sends it to your local Ollama model.
4. The response is sent back through Telegram to your phone.

If your laptop is off/sleeping, the bot cannot process messages.

## One-Time Setup

1. Create a bot with `@BotFather` and copy the token.
2. Put the token in `.env`:

```env
TELEGRAM_BOT_TOKEN=your_token_here
```

3. Start the app:

```bash
npm run dev
```

4. Open your bot in Telegram and send `/start`.
5. Send `/id` to get your chat id.
6. (Recommended) lock the bot to your chat by adding this in `.env`:

```env
TELEGRAM_CHAT_ID=your_numeric_chat_id
```

7. Restart the app.

## Telegram Commands

- `/start` connect bot and register active chat
- `/id` show your chat id
- `/menu` open interactive action menu
- `/status` quick goals/tasks/streak snapshot
- `/goals` list active goals
- `/tasks` list pending tasks
- `/checkin` log focus/mood using option buttons
- `/briefing` trigger morning briefing now

## Interactive UI Features

- Inline action menu with buttons for tasks, goals, status, briefing, and check-ins
- Button-driven task creation flow (title -> deadline -> priority)
- One-tap task completion from task list buttons
- Quick-action proactive alerts (snooze reminder, show tasks, need help)

## Proactive Notifications to Telegram

Scheduler messages are sent to Telegram in addition to existing channels:

- Daily morning briefing
- Cognitive-loop coaching nudges
- Recurring cron reminders
- One-time timestamp reminders
