import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { NewMessage } from 'telegram/events/index.js';
import db from './db.js';
import { processReceiptText } from './paymentProcessor.js';

export const startUserbot = async (botApp) => {
    const apiId = parseInt(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    let envSession = process.env.USERBOT_SESSION || '';

    if (!apiId || !apiHash) {
        console.warn("Userbot API_ID or API_HASH is missing. Userbot won't start.");
        return;
    }

    // Attempt to get session from DB first, fallback to .env
    const dbSessionSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('userbot_session');
    let sessionString = dbSessionSetting?.value || envSession;

    if (!sessionString) {
        console.warn("Userbot session string is missing. Please login via admin panel or provide USERBOT_SESSION in .env");
        return;
    }

    const stringSession = new StringSession(sessionString);
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    try {
        await client.connect();
        console.log("Userbot connected successfully.");

        // We use a queue to prevent race conditions during DB updates
        let isProcessing = false;
        const processingQueue = [];

        const processNext = async () => {
            if (isProcessing || processingQueue.length === 0) return;
            isProcessing = true;

            const messageEvent = processingQueue.shift();
            const messageText = messageEvent.message.text;

            try {
                 await processReceiptText(messageText, botApp, 'Userbot (HUMO/Uzcard)');
            } catch (err) {
                 console.error("Error processing userbot message:", err);
            } finally {
                isProcessing = false;
                processNext();
            }
        };

        client.addEventHandler(async (event) => {
            const sender = await event.message.getSender();
            // Typically @HUMOcardbot or similar
            if (sender && (sender.username === 'HUMOcardbot' || sender.username === 'UzcardBot' || sender.bot)) {
                 processingQueue.push(event);
                 processNext();
            }
        }, new NewMessage({ incoming: true }));

    } catch (error) {
        console.error("Userbot connection failed:", error);

        // If the session from DB failed, notify admin and delete it so we can fallback to env
        if (dbSessionSetting?.value && error.message.includes('session')) {
            const adminId = process.env.ADMIN_ID;
            if (adminId && botApp) {
                try {
                     await botApp.telegram.sendMessage(adminId, "⚠️ Userbot'ning Admin Panel'dagi sessiyasi yaroqsiz bo'lib qoldi va o'chirildi. Iltimos qaytadan bog'lang yoki .env dagi sessiya ishlatilmoqda.");
                } catch(e) {}
            }
            db.prepare("DELETE FROM settings WHERE key = 'userbot_session'").run();
        }
    }
};