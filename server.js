require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
const routes = require('./src/routes');
app.use('/api', routes);

// Fallback: serve index.html for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`\n AI Productivity Coach running at http://localhost:${PORT}\n`);

    // Start Telegram bot (if configured in .env)
    const { startBot } = require('./src/telegram');
    startBot();

    // Start the proactive scheduler
    const { startScheduler } = require('./src/scheduler');
    startScheduler();
});
