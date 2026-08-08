import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import db from './db.js';

export const loginUserbot = async () => {
    console.log("Starting Userbot Authentication Process...");

    const apiId = parseInt(process.env.API_ID);
    const apiHash = process.env.API_HASH;

    if (!apiId || !apiHash) {
        console.error("API_ID or API_HASH is missing in .env");
        return;
    }

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({
        phoneNumber: async () => await input.text("Iltimos, telefon raqamingizni kiriting (masalan, +998901234567): "),
        password: async () => await input.text("Iltimos, ikki bosqichli autentifikatsiya parolini kiriting (agar yo'q bo'lsa, probel tugmasini bosing): "),
        phoneCode: async () => await input.text("Telegram'dan kelgan kodni kiriting: "),
        onError: (err) => console.log(err),
    });

    console.log("Siz muvaffaqiyatli kirdingiz!");
    const sessionString = client.session.save();
    console.log("Sessiya kodi:\n", sessionString);

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('userbot_session', sessionString);
    console.log("Sessiya ma'lumotlar bazasiga muvaffaqiyatli saqlandi. Botni qayta ishga tushiring.");

    await client.disconnect();
};

if (import.meta.url === `file://${process.argv[1]}`) {
    import('dotenv/config').then(() => {
        loginUserbot().then(() => process.exit(0)).catch(e => {
            console.error(e);
            process.exit(1);
        });
    });
}