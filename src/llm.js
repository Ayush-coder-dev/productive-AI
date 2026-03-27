const MODEL = process.env.OLLAMA_MODEL || 'llama3:8b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

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

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return data.message?.content || '';
}

/**
 * Chat with the coach AI.
 */
async function chat(systemPrompt, userMessage) {
    return generate(userMessage, systemPrompt);
}

/**
 * Extract structured tasks/goals/events from a user message.
 * Returns JSON array of extracted items.
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
- If the user asks for a persistent objective, provide a highly detailed, comprehensive quest-like roadmap in "roadmap_steps". Do NOT give 3 steps. You MUST provide at least 8 to 12 distinct, actionable steps that walk the user completely from start to finish.
- If the user asks for a daily/weekly reminder or a cron job, add it to "reminders" with a standard 5-part cron expression for "time_rule".
- If the user specifies a relative or exact one-time reminder (e.g., "in 15 minutes" or "at 3 PM"), strictly calculate the exact future ISO timestamp based on the CURRENT TIME and provide that timestamp for "time_rule" with "is_recurring" set to false.
- If the user asks to remove/delete/cancel reminders or cron jobs, use "remove_reminders".
  - Use {"all": true} when they mean all reminders.
  - Use {"titles":[...], "match_mode":"contains"} when they mention reminder names loosely.
- CURRENT DATE: ${new Date().toISOString().split('T')[0]}
- CURRENT EXACT TIME (ISO): ${new Date().toISOString()}
Only include fields that are present in the message. If nothing can be extracted, return {}.`;

    const response = await generate(message, system, { temperature: 0.1, num_predict: 800 });

    // Parse JSON from response, handling potential markdown wrapping
    try {
        let jsonStr = response.trim();
        // Strip markdown code blocks if present
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();
        // Strip <think> blocks from reasoning models
        jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // Find the first { ... } block
        const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (braceMatch) jsonStr = braceMatch[0];
        return JSON.parse(jsonStr);
    } catch (e) {
        console.warn('LLM extraction parse error:', e.message);
        return {};
    }
}

/**
 * Generate a coaching message given context.
 */
async function generateCoachingMessage(contextSummary, triggerReason) {
    const system = `You are a supportive, insightful, and highly creative productivity coach AI. 
Generate a personalized, unique, and dynamic coaching message (2-3 sentences max).
CRITICAL RULES:
- Never use generic or cliché phrases like "You've got this", "Keep it up", "Time to shine", "Great job".
- Base your message deeply on the provided context. Notice subtle patterns and mention them.
- Be slightly informal, direct, and actionable, like a high-end human coach.
- Vary your tone—sometimes be challenging, sometimes reflective, sometimes deeply empathetic.
- Assume the user already knows *what* to do, but needs edge or distinct perspective.`;

    const prompt = `User Context:\n${contextSummary}\n\nCurrent Trigger: ${triggerReason}\n\nDeliver a highly distinct, non-repetitive coaching message addressing this trigger:`;

    return generate(prompt, system, { temperature: 0.9, num_predict: 200 });
}

/**
 * Generate a conversational response as the coach.
 */
async function coachReply(contextSummary, chatHistory, userMessage) {
    const system = `You are a proactive AI productivity coach. You help users stay productive, track their goals, and build good habits.

Your personality:
- Supportive but honest
- Direct and actionable
- You remember the user's context and reference it naturally
- You ask follow-up questions to understand the user better
- You celebrate wins and gently challenge procrastination

User context:
${contextSummary}

Recent conversation:
${chatHistory}

Respond naturally in 2-4 sentences. If the user mentions a goal, task, event, or activity, acknowledge it and offer relevant advice.`;

    return generate(userMessage, system, { temperature: 0.7, num_predict: 300 });
}

/**
 * Generate a short 2-4 word title for a new chat session based on the first message.
 */
async function generateChatTitle(firstMessage) {
    const system = `You generate incredibly short (2-4 words max) thread titles based on a user's initial message. Return ONLY the text for the title, no quotes, no extra words.`;
    const prompt = `Message: "${firstMessage}"\n\nTitle:`;
    try {
        const title = await generate(prompt, system, { temperature: 0.3, num_predict: 20 });
        return title.trim().replace(/^"|"$/g, '');
    } catch {
        return "Chat";
    }
}

module.exports = { generate, chat, extractFromMessage, generateCoachingMessage, coachReply, generateChatTitle };
