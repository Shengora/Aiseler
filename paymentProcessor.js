import db from './db.js';

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export const addBalance = (id, amount) => {
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, id);
};

export const addTransaction = (userId, type, amount, description) => {
  db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(userId, type, amount, description);
};

export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;

export const setSetting = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);

export async function processReceiptText(text, ctxOrNull, sourceName, telegramBot) {
  const cleanText = text.replace(/[*_~]/g, '');

  const cardNumber = getSetting('card_number') || '';
  const last4Match = cardNumber.match(/\d{4}$/);
  if (last4Match) {
    const last4 = last4Match[0];
    if (!cleanText.includes(last4)) {
      return false;
    }
  }

  let amountMatch = cleanText.match(/(?:Tushum|Kirim|Qabul qilindi|Mablag' tushdi|Yangi tolov|➕)[\s:-]*([0-9\s,.]+)\s*(?:UZS|so'm)?/i);
  if (!amountMatch) return false;

  let cleanStr = amountMatch[1];
  if (cleanStr.includes(',')) {
    cleanStr = cleanStr.split(',')[0];
  }
  cleanStr = cleanStr.replace(/\D/g, '');
  const amount = parseInt(cleanStr);

  if (amount > 0) {
    const pendingPayment = db.prepare("SELECT rowid as id, * FROM pending_payments WHERE amount = ? AND created_at > datetime('now', '-15 minutes') ORDER BY created_at DESC LIMIT 1").get(amount);

    if (pendingPayment) {
      const userId = pendingPayment.user_id;
      const user = getUser(userId);

      if (user) {
        addBalance(userId, amount);
        addTransaction(userId, 'topup', amount, `Avto-tasdiq (${sourceName}): Karta orqali`);
        db.prepare('DELETE FROM pending_payments WHERE rowid = ?').run(pendingPayment.id);

        if (ctxOrNull) {
          ctxOrNull.reply(`✅ To'lov tasdiqlandi (Summa orqali):\nID: ${userId}\nFoydalanuvchi: ${user.first_name}\nSumma: ${amount} so'm qo'shildi.`).catch(console.error);
        }
        try {
          if (telegramBot) {
              await telegramBot.telegram.sendMessage(userId, `✅ To'lov tasdiqlandi! Balansingizga ${amount} so'm qo'shildi.`);
              const adminIdStr = process.env.ADMIN_ID;
              if (adminIdStr) {
                  await telegramBot.telegram.sendMessage(parseInt(adminIdStr), `✅ Yangi balans to'ldirish (Summa orqali):\nID: ${userId}\nSumma: ${amount} so'm`);
              }
          }
        } catch (e) {
          console.error("Could not send auto-approve message", e);
        }
        return true;
      }
    } else {
      const userIdMatch = cleanText.match(/ID[\s:-]*(\d+)/i) || cleanText.match(/(?:Izoh|Comment)[\s:-]*(\d+)/i);
      if (userIdMatch) {
        const userId = parseInt(userIdMatch[1]);
        const user = getUser(userId);

        if (user) {
          addBalance(userId, amount);
          addTransaction(userId, 'topup', amount, `Avto-tasdiq (${sourceName}): Karta orqali (Izohdan)`);
          if (ctxOrNull) {
            ctxOrNull.reply(`✅ To'lov tasdiqlandi (Izohdan):\nID: ${userId}\nFoydalanuvchi: ${user.first_name}\nSumma: ${amount} so'm qo'shildi.`).catch(console.error);
          }
          try {
            if (telegramBot) {
                await telegramBot.telegram.sendMessage(userId, `✅ To'lov tasdiqlandi! Balansingizga ${amount} so'm qo'shildi.`);
                const adminIdStr = process.env.ADMIN_ID;
                if (adminIdStr) {
                    await telegramBot.telegram.sendMessage(parseInt(adminIdStr), `✅ Yangi balans to'ldirish (Izohdan):\nID: ${userId}\nSumma: ${amount} so'm`);
                }
            }
          } catch (e) {
            console.error("Could not send auto-approve message", e);
          }
          return true;
        }
      }
    }
  }
  return false;
}
