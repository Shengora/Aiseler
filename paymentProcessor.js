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

export const processReceiptText = async (text, ctx, sourceName) => {
    // 2. Yulduzcha (*) bilan keluvchi tekstlar
    // Matndagi yulduzcha, ostki chiziq kabi belgilarni tozalaymiz
    const cleanedText = text.replace(/[*_~`]/g, '');

    // Extract configured card number last 4 digits
    const cardNumber = getSetting('card_number') || '';
    const last4Match = cardNumber.match(/\d{4}$/);
    if (last4Match) {
      const last4 = last4Match[0];
      // If the incoming message doesn't contain the last 4 digits of the card, ignore it
      // This prevents processing receipts meant for other cards
      if (!cleanedText.includes(last4)) {
        return false;
      }
    }

    // Regex for standard bank/payment bot receipt messages (e.g. HUMOcardbot, Click, Payme SMS style)
    // Looking for amount (Tushum: / Kirim: / Qabul qilindi: / Mablag' tushdi / Yangi tolov / ➕)
    let amountMatch = cleanedText.match(/(?:Tushum|Kirim|Qabul qilindi|Mablag' tushdi|Yangi tolov|➕)[\s:-]*([0-9\s,.]+)\s*(?:UZS|so'm)?/i);
    if (!amountMatch) return false;

    let cleanStr = amountMatch[1];
    if (cleanStr.includes(',')) {
      cleanStr = cleanStr.split(',')[0]; // Discard decimals (e.g. ,00)
    }
    cleanStr = cleanStr.replace(/\D/g, ''); // Remove all dots/spaces to get final number
    const amount = parseInt(cleanStr);

    if (amount > 0) {
      // First check pending payments by exact amount
      const pendingPayment = db.prepare("SELECT rowid as id, * FROM pending_payments WHERE amount = ? AND created_at > datetime('now', '-15 minutes') ORDER BY created_at DESC LIMIT 1").get(amount);

      if (pendingPayment) {
        const userId = pendingPayment.user_id;
        const user = getUser(userId);

        if (user) {
          addBalance(userId, amount);
          addTransaction(userId, 'topup', amount, `Avto-tasdiq (${sourceName}): Karta orqali`);

          // Remove the pending payment
          db.prepare('DELETE FROM pending_payments WHERE rowid = ?').run(pendingPayment.id);

          try {
            await ctx.telegram.sendMessage(userId, `✅ Karta to'lovingiz avtomatik tasdiqlandi! Balansingizga ${amount} so'm qo'shildi.`);
            const ADMIN_ID = process.env.ADMIN_ID;
            if (ADMIN_ID) {
                await ctx.telegram.sendMessage(ADMIN_ID, `✅ ${sourceName} orqali avtomatik tasdiqlandi (Summa orqali):\nID: ${userId}\nFoydalanuvchi: ${user.first_name}\nSumma: ${amount} so'm qo'shildi.`);
            }
          } catch (e) {
            console.error("Could not send auto-approve message", e);
          }
          return true;
        }
      } else {
        // Look for User ID in comments as a fallback
        const userIdMatch = cleanedText.match(/ID[\s:-]*(\d+)/i) || cleanedText.match(/(?:Izoh|Comment)[\s:-]*(\d+)/i);
        if (userIdMatch) {
          const userId = parseInt(userIdMatch[1]);
          const user = getUser(userId);

          if (user) {
            addBalance(userId, amount);
            addTransaction(userId, 'topup', amount, `Avto-tasdiq (${sourceName}): Karta orqali (Izohdan)`);
            try {
              await ctx.telegram.sendMessage(userId, `✅ Karta to'lovingiz tasdiqlandi! Balansingizga ${amount} so'm qo'shildi.`);
              const ADMIN_ID = process.env.ADMIN_ID;
              if (ADMIN_ID) {
                  await ctx.telegram.sendMessage(ADMIN_ID, `✅ ${sourceName} orqali avtomatik tasdiqlandi (Izohdan):\nID: ${userId}\nFoydalanuvchi: ${user.first_name}\nSumma: ${amount} so'm qo'shildi.`);
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
};