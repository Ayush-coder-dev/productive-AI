const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const TOKEN_PATH = path.join(__dirname, '..', 'data', 'google_tokens.json');
const CREDS_PATH = path.join(__dirname, '..', 'data', 'google_creds.json');

const REDIRECT_URI = 'http://localhost:3000/api/google/callback';

const SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
];

function getCredentials() {
    // Try file-based config first, then env vars
    if (fs.existsSync(CREDS_PATH)) {
        return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    }
    const id = process.env.GOOGLE_CLIENT_ID || '';
    const secret = process.env.GOOGLE_CLIENT_SECRET || '';
    if (id && secret) return { client_id: id, client_secret: secret };
    return null;
}

function saveCredentials(clientId, clientSecret) {
    fs.writeFileSync(CREDS_PATH, JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2));
}

function createOAuth2Client() {
    const creds = getCredentials();
    if (!creds) return null;
    return new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
}

function getAuthUrl() {
    const client = createOAuth2Client();
    if (!client) return null;
    return client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: SCOPES,
    });
}

async function handleCallback(code) {
    const client = createOAuth2Client();
    if (!client) throw new Error('Google credentials not configured');
    const { tokens } = await client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    return tokens;
}

function getAuthClient() {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const client = createOAuth2Client();
    if (!client) return null;
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    client.setCredentials(tokens);

    client.on('tokens', (newTokens) => {
        const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        const merged = { ...existing, ...newTokens };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });

    return client;
}

function isConnected() {
    return fs.existsSync(TOKEN_PATH) && !!getCredentials();
}

function hasCredentials() {
    return !!getCredentials();
}

function disconnect() {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
}

module.exports = { getAuthUrl, handleCallback, getAuthClient, isConnected, disconnect, hasCredentials, saveCredentials };
