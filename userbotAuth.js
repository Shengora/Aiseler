import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import db from './db.js';
import { startUserbot } from './userbot.js';

let tempClient = null;
let phoneCodePromise = null;
let phoneCodeResolve = null;
let passwordPromise = null;
let passwordResolve = null;

export async function initiateUserbotLogin(ctx) {
    const apiId = process.env.API_ID ? parseInt(process.env.API_ID) : null;
    const apiHash = process.env.API_HASH;

    if (!apiId || !apiHash) {
        return ctx.reply("API_ID yoki API_HASH .env faylida mavjud emas!");
    }

    ctx.session.adminState = 'userbot_auth_phone';
    ctx.reply("Userbot ulanishi uchun telefon raqamini xalqaro formatda kiriting (masalan: +998901234567):");
}

export async function handleUserbotAuthInputs(ctx, state, telegramBot) {
    if (state === 'userbot_auth_phone') {
        const phoneNumber = ctx.message.text;
        ctx.reply("Kuting, SMS yuborilmoqda...");

        const apiId = process.env.API_ID ? parseInt(process.env.API_ID) : null;
        const apiHash = process.env.API_HASH;

        tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
        });

        try {
            await tempClient.start({
                phoneNumber: async () => phoneNumber,
                password: async () => {
                    ctx.session.adminState = 'userbot_auth_password';
                    ctx.reply("Ikki bosqichli autentifikatsiya parolini kiriting:");
                    passwordPromise = new Promise((resolve) => {
                        passwordResolve = resolve;
                    });
                    return await passwordPromise;
                },
                phoneCode: async () => {
                    ctx.session.adminState = 'userbot_auth_code';
                    ctx.reply("Telegramdan kelgan tasdiqlash kodini kiriting:");
                    phoneCodePromise = new Promise((resolve) => {
                        phoneCodeResolve = resolve;
                    });
                    return await phoneCodePromise;
                },
                onError: (err) => console.log(err),
            });

            const sessionString = tempClient.session.save();
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('userbot_session', sessionString);

            ctx.session.adminState = null;
            ctx.reply("✅ Userbot muvaffaqiyatli ulandi! Endi u fonda ishlaydi.");

            // Start the actual userbot
            await startUserbot(telegramBot);

        } catch (error) {
            console.error("Login error:", error);
            ctx.session.adminState = null;
            ctx.reply(`Xatolik yuz berdi: ${error.message}`);
        }
    } else if (state === 'userbot_auth_code') {
        if (phoneCodeResolve) {
            phoneCodeResolve(ctx.message.text);
            ctx.reply("Kod qabul qilindi, tekshirilmoqda...");
        }
    } else if (state === 'userbot_auth_password') {
        if (passwordResolve) {
            passwordResolve(ctx.message.text);
            ctx.reply("Parol qabul qilindi, tekshirilmoqda...");
        }
    }
}
