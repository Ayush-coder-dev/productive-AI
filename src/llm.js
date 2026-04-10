const MODEL = process.env.OLLAMA_MODEL || 'llama3:8b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_TIMEOUT_MS = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS || '90000', 10);

/**
 * Call Ollama local chat endpoint.
 */
async function generate(prompt, system = '', options = {}) {
    const url = `${OLLAMA_HOST}/api/chat`;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const body = {
        model: MODEL,
        messages,
        stream: false,
        options: {
            temperature: options.temperature ?? 0.7,
            num_predict: options.num_predict ?? 512,
        },
    };

    const controller = new AbortController();
    const timeoutMs = Number.isFinite(OLLAMA_TIMEOUT_MS) ? Math.max(5000, OLLAMA_TIMEOUT_MS) : 90000;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.message?.content || '';
}

function parseJsonResponse(response, fallback = {}) {
    try {
        let jsonStr = String(response || '').trim();
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();

        jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (braceMatch) jsonStr = braceMatch[0];

        return JSON.parse(jsonStr);
    } catch {
        return fallback;
    }
}

/**
 * Chat with the coach AI.
 */
async function chat(systemPrompt, userMessage) {
    return generate(userMessage, systemPrompt);
}

/**
 * Extract structured tasks/goals/events from a user message.
 */
async function extractFromMessage(message) {
    const system = `You are a data extraction assistant for an AI productivity coach. Extract structured information from the user's message.
Return ONLY a valid JSON object with these optional fields:
{
  "goals": [{"title": "...", "type": "productivity|learning|health|other", "deadline": "YYYY-MM-DD or null", "roadmap_steps": ["step 1", "step 2", "step 3", "step 4", "step 5", "step 6", "step 7", "step 8"]}],
  "tasks": [{"title": "...", "deadline": "YYYY-MM-DD or null", "priority": "high|medium|low", "goal_title": "related goal or null"}],
  "events": [{"title": "...", "date": "YYYY-MM-DD", "importance": "high|medium|low"}],
  "activities": [{"action": "...", "task": "...", "duration_min": number}],
  "reminders": [{"title": "...", "time_rule": "cron expression (e.g. '0 10 * * *') or specific date/time", "is_recurring": true|false}],
  "remove_reminders": {"all": true|false, "titles": ["..."], "match_mode": "exact|contains"}
}
Rules:
- If the user asks for a persistent objective, provide a highly detailed roadmap in "roadmap_steps" with at least 8-12 distinct, actionable steps.
- If the user asks for a daily/weekly reminder or a cron job, add it to "reminders" with a standard 5-part cron expression.
- If the user specifies a relative or exact one-time reminder (e.g., "in 15 minutes" or "at 3 PM"), calculate the exact future ISO timestamp based on the CURRENT TIME and set "is_recurring" to false.
- Never return a cron expression for relative one-time reminders.
- If the user asks to remove/delete/cancel reminders or cron jobs, use "remove_reminders".
- CURRENT DATE: ${new Date().toISOString().split('T')[0]}
- CURRENT EXACT TIME (ISO): ${new Date().toISOString()}
Only include fields that are present in the message. If nothing can be extracted, return {}.`;

    const response = await generate(message, system, { temperature: 0.1, num_predict: 900 });
    return parseJsonResponse(response, {});
}

/**
 * Extract durable user memory (long-term facts/preferences) from a message.
 */
async function extractUserMemories(message, recentChat = '', contextSummary = '') {
    const system = `You extract long-term user memory for a personal coaching assistant.
Return ONLY strict JSON with shape:
{
  "memories": [
    {"key": "snake_case_key", "value": "fact", "importance": 0.0}
  ]
}
Rules:
- Capture only durable facts/preferences/constraints that should be remembered for future chats.
- Ignore one-time tasks, temporary scheduling details, and obvious short-lived statements.
- Good memories include: identity, preferred coaching style, chronic constraints, recurring routines, long-term goals, motivation patterns, preferred work times.
- Key must be snake_case and concise.
- Importance range 0.0 to 1.0. Use >0.75 for explicit high-impact facts.
- If no durable memory exists, return {"memories": []}.
- Never include anything not supported by the message/context.`;

    const prompt = `Message:\n${message}\n\nRecent chat:\n${recentChat}\n\nContext:\n${contextSummary}\n\nExtract durable memories.`;
    const response = await generate(prompt, system, { temperature: 0.1, num_predict: 400 });
    const parsed = parseJsonResponse(response, { memories: [] });

    if (!parsed || !Array.isArray(parsed.memories)) {
        return { memories: [] };
    }

    return { memories: parsed.memories };
}

/**
 * Decide whether proactive message should be sent now, and why.
 */
async function reasonProactiveAction(contextSummary, decisionContext) {
    const system = `You are the reasoning engine for proactive coaching notifications.
Return ONLY JSON:
{
  "send": true,
  "type": "reminder|challenge|motivation|advice|planning|reflection",
  "priority": 1,
  "reason": "short reason",
  "tone_hint": "short tone style"
}
Rules:
- send=false if interruption risk is high and no urgent reason exists.
- Prefer urgency + relevance + timing fit (time of day, deadlines, inactivity, mood).
- priority is 1-5 where 5 is urgent.
- reason must be specific and grounded in provided signals.
- Never output prose, only valid JSON.`;

    const prompt = `Context summary:\n${contextSummary}\n\nDecision context:\n${decisionContext}\n\nReturn best proactive decision.`;
    const response = await generate(prompt, system, { temperature: 0.2, num_predict: 300 });
    const parsed = parseJsonResponse(response, null);

    if (!parsed || typeof parsed.send !== 'boolean') {
        return {
            send: true,
            type: 'advice',
            priority: 3,
            reason: 'Fallback proactive decision due to parser uncertainty.',
            tone_hint: 'direct and concise',
        };
    }

    return {
        send: parsed.send,
        type: parsed.type || 'advice',
        priority: Number(parsed.priority) || 3,
        reason: parsed.reason || 'No reason provided.',
        tone_hint: parsed.tone_hint || 'direct and concise',
    };
}

/**
 * Generate a coaching message given context and trigger.
 */
async function generateCoachingMessage(contextSummary, triggerReason, options = {}) {
    const timeContext = options.timeContext || '';
    const toneHint = options.toneHint || 'direct, grounded, practical';

    const system = `You are a supportive but sharp productivity coach.
Write 2-4 concise sentences.
Rules:
- Ground the response in concrete context, not generic cheerleading.
- Explain "why now" in one short clause using the provided time context/signal.
- Give one immediate next step the user can do in 5-20 minutes.
- Keep tone ${toneHint}.
- Avoid cliches like "you got this".`;

    const prompt = `User context:\n${contextSummary}\n\nTime context:\n${timeContext}\n\nTrigger reason:\n${triggerReason}\n\nGenerate the proactive coaching message.`;
    return generate(prompt, system, { temperature: 0.8, num_predict: 240 });
}

/**
 * Generate a conversational response as the coach.
 */
async function coachReply(contextSummary, chatHistory, userMessage) {
    const system = `You are a proactive AI productivity coach.
You help users stay productive, track goals, and build habits.

Rules:
- Be supportive but honest.
- Reference saved long-term user memory and current context naturally.
- Give concrete, time-aware advice when possible.
- Keep response 2-5 sentences unless user asks for deep detail.`;

    const prompt = `User context:\n${contextSummary}\n\nRecent conversation:\n${chatHistory}\n\nUser message:\n${userMessage}`;
    return generate(prompt, system, { temperature: 0.7, num_predict: 360 });
}

/**
 * Generate a short 2-4 word title for a new chat session based on the first message.
 */
async function generateChatTitle(firstMessage) {
    const system = `You generate short (2-4 words max) thread titles based on a user's initial message. Return only the title text.`;
    const prompt = `Message: "${firstMessage}"\n\nTitle:`;
    try {
        const title = await generate(prompt, system, { temperature: 0.3, num_predict: 20 });
        return title.trim().replace(/^"|"$/g, '');
    } catch {
        return 'Chat';
    }
}

module.exports = {
    generate,
    chat,
    extractFromMessage,
    extractUserMemories,
    reasonProactiveAction,
    generateCoachingMessage,
    coachReply,
    generateChatTitle,
};
