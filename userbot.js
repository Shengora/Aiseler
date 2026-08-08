import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import db from './db.js';
import { processReceiptText } from './paymentProcessor.js';

let client = null;
let isRunning = false;

// Queue mechanism to prevent race conditions
const messageQueue = [];
let isProcessingQueue = false;

async function processQueue(telegramBot) {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    try {
        while (messageQueue.length > 0) {
            const message = messageQueue.shift();
            try {
                await processReceiptText(message.text, null, "Userbot", telegramBot);
            } catch (error) {
                console.error("Error processing userbot message in queue:", error);
            }
            // Ensure sequential processing with a delay between each message
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } finally {
        isProcessingQueue = false;
        // In case a message was pushed exactly as we exited the loop
        if (messageQueue.length > 0) {
            processQueue(telegramBot);
        }
    }
}

export async function startUserbot(telegramBot) {
    if (isRunning) return;

    const apiId = process.env.API_ID ? parseInt(process.env.API_ID) : null;
    const apiHash = process.env.API_HASH;

    if (!apiId || !apiHash) {
        console.log("API_ID or API_HASH not found in .env, Userbot cannot start.");
        return;
    }

    const sessionStr = db.prepare('SELECT value FROM settings WHERE key = ?').get('userbot_session')?.value || process.env.USERBOT_SESSION;
    if (!sessionStr) {
        console.log("No Userbot session found in database or .env.");
        return;
    }

    const stringSession = new StringSession(sessionStr);

    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    try {
        await client.connect();
        console.log("Userbot connected successfully.");
        isRunning = true;

        client.addEventHandler((event) => {
            const message = event.message;
            if (message && message.peerId) {
                (async () => {
                    try {
                        const sender = await message.getSender();
                        if (sender && sender.username && message.text) {
                            const username = sender.username.toLowerCase();
                            if (username === 'humocardbot' || username === 'uzcard_bot' || username === 'uzcardbot') {
                                console.log(`Received message from ${sender.username} via Userbot`);
                                messageQueue.push({ text: message.text });
                                processQueue(telegramBot);
                            }
                        }
                    } catch (e) {
                         // Ignore errors here
                    }
                })();
            }
        }, new (await import('telegram/events/index.js')).NewMessage({}));

    } catch (error) {
        console.error("Failed to start Userbot:", error);
        isRunning = false;
    }
}

export function stopUserbot() {
    if (client) {
        client.disconnect();
        client = null;
    }
    isRunning = false;
}

export function isUserbotRunning() {
    return isRunning;
}
