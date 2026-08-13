import 'dotenv/config';
import express from 'express';
import { Telegraf, session, Markup } from 'telegraf';
import db from './db.js';
import { processReceiptText } from './paymentProcessor.js';
import { initiateUserbotLogin, handleUserbotAuthInputs } from './userbotAuth.js';
import { startUserbot, isUserbotRunning } from './userbot.js';
import { getBalance, getProducts, placeOrder, getOrderStatus } from './apiIntegration.js';

// Global exception handlers to prevent the process from crashing
process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

let bot;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  
  // Use session for simple state management (admin states)
  bot.use(session());
  bot.use((ctx, next) => {
    if (!ctx.session) ctx.session = {};
    return next();
  });

  const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;
  const PAYMENT_ADMIN_ID = process.env.PAYMENT_ADMIN_ID ? parseInt(process.env.PAYMENT_ADMIN_ID) : null;

  // Keyboards
  const getMainMenu = () => {
    const products = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM product_keys WHERE product_id = p.id AND is_sold = 0) as stock FROM products p').all();
    
    let buttons = [
      [{ text: '💰 Balansim', callback_data: 'balansim', style: 'primary' }, { text: '➕ Balans to\'ldirish', callback_data: 'balans_toldirish', style: 'success' }]
    ];
    
    products.forEach(p => {
      buttons.push([{ text: `✨ ${p.name} (${p.stock} ta)`, callback_data: `product_${p.id}`, style: 'primary' }]);
    });
    
    buttons.push(
      [{ text: '📖 To\'liq qo\'llanma', callback_data: 'qollanma', style: 'primary' }],
      [{ text: '📋 Mening vazifalarim', callback_data: 'vazifalarim', style: 'primary' }, { text: '📜 Tranzaksiyalar', callback_data: 'tranzaksiyalar', style: 'primary' }],
      [{ text: '👥 Referal havolam', callback_data: 'referal', style: 'primary' }]
    );
    
    return Markup.inlineKeyboard(buttons);
  };

  const backButton = [{ text: '◀️ Asosiy menyu', callback_data: 'main_menu', style: 'danger' }];
  const adminBackButton = [{ text: '◀️ Admin menyu', callback_data: 'admin_menu', style: 'danger' }];

  const getAdminMenu = () => {
    return Markup.inlineKeyboard([
      [{ text: '📊 Statistika', callback_data: 'admin_stats', style: 'primary' }, { text: '👥 Foydalanuvchi boshqaruvi', callback_data: 'admin_user_manage', style: 'primary' }],
      [{ text: '📦 Tovarlar boshqaruvi', callback_data: 'admin_products', style: 'primary' }],
      [{ text: '🔑 Kalit (Havola) qo\'shish', callback_data: 'admin_add_key', style: 'primary' }],
      [{ text: '⚙️ Referal bonusni o\'zgartirish', callback_data: 'admin_set_bonus', style: 'primary' }],
      [{ text: '💳 Karta o\'zgartirish', callback_data: 'admin_set_card_number', style: 'primary' }, { text: '👤 Karta egasini o\'zgartirish', callback_data: 'admin_set_card_holder', style: 'primary' }],
      [{ text: '🤖 Userbot Sozlamalari', callback_data: 'admin_userbot_settings', style: 'primary' }],
      [{ text: '📢 Xabar yuborish (Broadcast)', callback_data: 'admin_broadcast', style: 'primary' }],
      [{ text: '🌐 API Boshqaruvi', callback_data: 'admin_api_manage', style: 'primary' }],
      [{ text: '◀️ Asosiy menyu', callback_data: 'main_menu', style: 'danger' }]
    ]);
  };

  // Helper functions
  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const setSetting = (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  
  const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  
  // Middleware to check blocked status
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const user = getUser(ctx.from.id);
      if (user && user.is_blocked) {
        if (ctx.callbackQuery) {
          return ctx.answerCbQuery("Siz bloklangansiz.", { show_alert: true });
        }
        return ctx.reply("Siz bloklangansiz. Botdan foydalana olmaysiz.");
      }
    }
    return next();
  });
  const createUser = (id, firstName, referrerId = null) => {
    db.prepare('INSERT INTO users (id, first_name, referrer_id) VALUES (?, ?, ?)').run(id, firstName, referrerId);
  };
  const addBalance = (id, amount) => {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, id);
  };
  const addTransaction = (userId, type, amount, description) => {
    db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(userId, type, amount, description);
  };

  // Commands
  bot.start((ctx) => {
    ctx.session.adminState = null;
    ctx.session.userState = null;
    let user = getUser(ctx.from.id);
    
    if (!user) {
      // Check for referral
      let referrerId = null;
      const args = ctx.message.text.split(' ');
      if (args.length > 1) {
        referrerId = parseInt(args[1]);
        if (referrerId && referrerId !== ctx.from.id) {
          const referrer = getUser(referrerId);
          if (referrer) {
            referrerId = referrer.id;
          } else {
            referrerId = null;
          }
        } else {
          referrerId = null;
        }
      }
      createUser(ctx.from.id, ctx.from.first_name, referrerId);
    }
    
    const welcomeMessage = `Assalomu alaykum! Bu bot orqali Google AI Pro uchun\naktivatsiya havolasini sotib olishingiz mumkin.\n\n🔗 Bir xaridda — bitta shaxsiy aktivatsiya havolasi\n\nPastdagi tugmalardan foydalaning`;
    ctx.reply(welcomeMessage, getMainMenu());
  });

  bot.command('cancel', (ctx) => {
    ctx.session.userState = null;
    ctx.session.adminState = null;
    ctx.reply('Bekor qilindi. Asosiy menyu:', getMainMenu());
  });

  bot.action('main_menu', (ctx) => {
    ctx.answerCbQuery();
    ctx.session.userState = null;
    const welcomeMessage = `Assalomu alaykum! Bu bot orqali Google AI Pro uchun\naktivatsiya havolasini sotib olishingiz mumkin.\n\n🔗 Bir xaridda — bitta shaxsiy aktivatsiya havolasi\n\nPastdagi tugmalardan foydalaning`;
    ctx.editMessageText(welcomeMessage, getMainMenu()).catch(console.error);
  });

  bot.command('admin', (ctx) => {
    if (ctx.from.id === ADMIN_ID) {
      ctx.session.adminState = null;
      ctx.reply('Admin paneliga xush kelibsiz:', getAdminMenu());
    } else {
      ctx.reply(`Kechirasiz, siz admin emassiz.\nSizning ID: ${ctx.from.id}`);
    }
  });

  bot.action('admin_menu', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id === ADMIN_ID) {
      ctx.session.adminState = null;
      ctx.editMessageText('Admin paneliga xush kelibsiz:', getAdminMenu()).catch(console.error);
    }
  });

  bot.action('admin_stats', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    
    const soldKeys = db.prepare('SELECT COUNT(*) as c FROM product_keys WHERE is_sold = 1').get().c;
    const availableKeys = db.prepare('SELECT COUNT(*) as c FROM product_keys WHERE is_sold = 0').get().c;
    const totalTopup = db.prepare('SELECT SUM(amount) as s FROM transactions WHERE type = ?').get('topup').s || 0;
    const usersCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    
    const text = `📊 Statistika:\n\n👥 Foydalanuvchilar soni: ${usersCount} ta\n🛍 Sotilgan tovarlar: ${soldKeys} ta\n📦 Ombordagi tovarlar: ${availableKeys} ta\n💳 Jami to'ldirilgan balans: ${totalTopup.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} so'm`;
    
    ctx.editMessageText(text, Markup.inlineKeyboard([
      [{ text: '📜 Sotuvlar tarixi', callback_data: 'admin_sales_history', style: 'primary' }],
      adminBackButton
    ]));
  });

  bot.action('admin_sales_history', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    
    const sales = db.prepare(`
      SELECT pk.sold_to, p.name, pk.sold_date 
      FROM product_keys pk 
      JOIN products p ON pk.product_id = p.id 
      WHERE pk.is_sold = 1 
      ORDER BY pk.sold_date DESC LIMIT 20
    `).all();
    
    if (sales.length === 0) {
      return ctx.editMessageText("Hozircha sotuvlar yo'q.", Markup.inlineKeyboard([
        [{ text: '◀️ Ortga', callback_data: 'admin_stats', style: 'danger' }]
      ]));
    }
    
    let text = "📜 Oxirgi 20 ta sotuvlar:\n\n";
    sales.forEach((s, idx) => {
      text += `${idx+1}. ID: ${s.sold_to} - ${s.name} (${s.sold_date})\n`;
    });
    
    ctx.editMessageText(text, Markup.inlineKeyboard([
      [{ text: '◀️ Ortga', callback_data: 'admin_stats', style: 'danger' }]
    ]));
  });

  bot.action('admin_user_manage', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    
    ctx.session.adminState = 'manage_user_id';
    ctx.editMessageText("Boshqarish uchun Foydalanuvchi ID sini kiriting:", Markup.inlineKeyboard([adminBackButton]));
  });

  bot.action(/^manage_user_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    
    const userId = parseInt(ctx.match[1]);
    const user = getUser(userId);
    if (!user) return ctx.editMessageText('Foydalanuvchi topilmadi.', Markup.inlineKeyboard([adminBackButton]));
    
    ctx.session.manageUserId = userId;
    
    const text = `👤 Foydalanuvchi: ${user.first_name}\n🆔 ID: ${user.id}\n💰 Balans: ${user.balance} so'm\n💸 Jami xarajat: ${user.total_paid} so'm\n\nHolat: ${user.is_blocked ? '🔴 Bloklangan' : '🟢 Faol'}`;
    
    ctx.editMessageText(text, Markup.inlineKeyboard([
      [{ text: '➕ Balans qo\'shish', callback_data: `admin_addbal_${userId}`, style: 'success' }, { text: '➖ Balans ayirish', callback_data: `admin_subbal_${userId}`, style: 'danger' }],
      [{ text: user.is_blocked ? '🟢 Blokdan chiqarish' : '🔴 Bloklash', callback_data: `admin_block_${userId}`, style: user.is_blocked ? 'success' : 'danger' }],
      [{ text: '📜 Tarixini ko\'rish', callback_data: `admin_uhistory_${userId}`, style: 'primary' }],
      adminBackButton
    ]));
  });

  bot.action(/^admin_addbal_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'add_user_balance';
    ctx.session.manageUserId = parseInt(ctx.match[1]);
    ctx.editMessageText("Qo'shiladigan summani kiriting:", Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: `manage_user_${ctx.match[1]}`, style: 'danger' }]]));
  });

  bot.action(/^admin_subbal_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'sub_user_balance';
    ctx.session.manageUserId = parseInt(ctx.match[1]);
    ctx.editMessageText("Ayriladigan summani kiriting:", Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: `manage_user_${ctx.match[1]}`, style: 'danger' }]]));
  });

  bot.action(/^admin_block_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const userId = parseInt(ctx.match[1]);
    const user = getUser(userId);
    if (user) {
      const newStatus = user.is_blocked ? 0 : 1;
      db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(newStatus, userId);
      ctx.editMessageText(`Foydalanuvchi muvaffaqiyatli ${newStatus ? 'bloklandi' : 'blokdan chiqarildi'}.`, Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: `manage_user_${userId}`, style: 'danger' }]]));
    }
  });

  bot.action(/^admin_uhistory_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const userId = parseInt(ctx.match[1]);
    
    const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 15').all(userId);
    const purchases = db.prepare('SELECT * FROM purchases WHERE user_id = ? ORDER BY date DESC LIMIT 15').all(userId);

    if (transactions.length === 0 && purchases.length === 0) {
      return ctx.editMessageText("Bu foydalanuvchida tranzaksiyalar va xaridlar yo'q.", Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: `manage_user_${userId}`, style: 'danger' }]]));
    }
    
    let text = "📜 Foydalanuvchi tarixi:\n\n";

    if (transactions.length > 0) {
      text += "💸 Tranzaksiyalar (Oxirgi 15 ta):\n";
      transactions.forEach(t => {
        let icon = t.type === 'topup' ? '➕' : (t.type === 'purchase' ? '➖' : '🎁');
        text += `${icon} ${t.amount} so'm | ${t.description} | ${t.date}\n`;
      });
      text += "\n";
    }

    if (purchases.length > 0) {
      text += "🛍 Xaridlar va Havolalar (Oxirgi 15 ta):\n";
      purchases.forEach(p => {
        text += `🛒 ${p.item_name} | ${p.date}\n🔗 Havola: ${p.link}\n\n`;
      });
    }
    
    ctx.editMessageText(text, Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: `manage_user_${userId}`, style: 'danger' }]]));
  });

  bot.command('addbal', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' ');
    if (parts.length !== 3) {
      return ctx.reply("Iltimos, formatni to'g'ri kiriting: /addbal [Foydalanuvchi_ID] [Summa]");
    }
    const userId = parseInt(parts[1]);
    const amount = parseInt(parts[2]);
    if (isNaN(userId) || isNaN(amount)) {
      return ctx.reply("ID va Summa raqam bo'lishi kerak.");
    }
    
    addBalance(userId, amount);
    addTransaction(userId, 'topup', amount, `Admin tomonidan qo'shildi`);
    ctx.reply(`✅ Foydalanuvchi ${userId} balansiga ${amount} so'm qo'shildi.`);
    
    try {
      ctx.telegram.sendMessage(userId, `🎉 Balansingiz admin tomonidan ${amount} so'mga to'ldirildi!`);
    } catch (e) {}
  });

  bot.command('balance', (ctx) => {
    const user = getUser(ctx.from.id);
    if (!user) return ctx.reply('Foydalanuvchi topilmadi. Iltimos /start ni bosing.');
    const text = `💰 Mening balansim\n\n💎 Balans: ${user.balance || 0} so'm\n🎫 Kreditlar: 0 ta\n📊 Jami to'langan: ${user.total_paid || 0} so'm\n\n💡 1 kredit = 19 900 so'm`;
    const balansMenu = Markup.inlineKeyboard([
      [{ text: '➕ Balans to\'ldirish', callback_data: 'balans_toldirish', style: 'success' }],
      backButton
    ]);
    ctx.reply(text, balansMenu);
  });

  bot.command('topup', (ctx) => {
    ctx.session.userState = 'topup_amount';
    const text = `➕ Balans to'ldirish\n\nTo'ldirmoqchi bo'lgan summangizni yozing (so'mda):\n\n📌 Minimal: 20 000 so'm\n📌 Maksimal: 1 000 000 so'm\n\nBekor qilish: /cancel`;
    ctx.reply(text);
  });

  bot.command('services', (ctx) => {
    ctx.reply(`Iltimos, menyudan tovar tanlang:`, getMainMenu());
  });

  bot.command('referral', (ctx) => {
    const user = getUser(ctx.from.id);
    if (!user) return;
    const botInfo = ctx.botInfo;
    const refLink = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    
    const text = `👥 Referal dasturi\n\n🔗 Sizning havolangiz:\n${refLink}\n\n🎁 Mukofot: Taklif qilgan do'stingiz tovar xarid qilganida, agar tovar uchun referal bonus belgilangan bo'lsa, sizga shu miqdorda bonus beriladi.\n\nℹ️ Oddiy balans to'ldirish bonus bermaydi. Bonus faqat muvaffaqiyatli yakunlangan mahsulot xarididan keyin tushadi.\n\n📊 Statistika:\n👤 Taklif qilgansiz: ${user.referral_count || 0} ta\n✅ Xarid qilgan do'stlar: ${user.referral_purchases || 0} ta\n💰 Umumiy daromad: ${user.referral_earnings || 0} so'm`;
    
    ctx.reply(text, Markup.inlineKeyboard([backButton]));
  });

  const handleHelpCommand = (ctx, edit = false) => {
    const products = db.prepare('SELECT id, name, guide FROM products').all();

    if (products.length === 0) {
      const text = "Hozircha tovarlar va qo'llanmalar mavjud emas.";
      if (edit) {
        ctx.editMessageText(text, Markup.inlineKeyboard([backButton])).catch(console.error);
      } else {
        ctx.reply(text, Markup.inlineKeyboard([backButton]));
      }
      return;
    }

    if (products.length === 1) {
      const text = products[0].guide || "Qo'llanma mavjud emas.";
      if (edit) {
        ctx.editMessageText(text, Markup.inlineKeyboard([backButton])).catch(console.error);
      } else {
        ctx.reply(text, Markup.inlineKeyboard([backButton]));
      }
      return;
    }

    let buttons = [];
    products.forEach(p => {
      buttons.push([{ text: `📖 ${p.name}`, callback_data: `show_guide_${p.id}`, style: 'primary' }]);
    });
    buttons.push(backButton);

    const text = "Qaysi tovar qo'llanmasini ko'rishni xohlaysiz?";
    if (edit) {
      ctx.editMessageText(text, Markup.inlineKeyboard(buttons)).catch(console.error);
    } else {
      ctx.reply(text, Markup.inlineKeyboard(buttons));
    }
  };

  bot.command('help', (ctx) => {
    handleHelpCommand(ctx, false);
  });

  // User Actions
  bot.action('balansim', (ctx) => {
    ctx.answerCbQuery();
    const user = getUser(ctx.from.id);
    if (!user) return ctx.reply('Foydalanuvchi topilmadi. Iltimos /start ni bosing.');
    
    const text = `💰 Mening balansim\n\n💎 Balans: ${user.balance || 0} so'm\n🎫 Kreditlar: 0 ta\n📊 Jami to'langan: ${user.total_paid || 0} so'm\n\n💡 1 kredit = 19 900 so'm`;
    const balansMenu = Markup.inlineKeyboard([
      [{ text: '➕ Balans to\'ldirish', callback_data: 'balans_toldirish', style: 'success' }],
      backButton
    ]);
    ctx.editMessageText(text, balansMenu).catch(console.error);
  });

  bot.action('balans_toldirish', (ctx) => {
    ctx.answerCbQuery();
    ctx.session.userState = 'topup_amount';
    const text = `➕ Balans to'ldirish\n\nTo'ldirmoqchi bo'lgan summangizni yozing (so'mda):\n\n📌 Minimal: 20 000 so'm\n📌 Maksimal: 1 000 000 so'm\n\nBekor qilish: /cancel`;
    ctx.editMessageText(text).catch((e) => {
      ctx.reply(text);
    });
  });

  bot.action('confirm_amount', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.session.userState === 'topup_confirm_amount') {
      const uniqueAmount = ctx.session.pendingTopupAlternative;
      
      const checkPending = db.prepare("SELECT COUNT(*) as count FROM pending_payments WHERE amount = ? AND created_at > datetime('now', '-15 minutes')");
      if (checkPending.get(uniqueAmount).count > 0) {
        return ctx.editMessageText("Kechirasiz, bu summa ham band bo'ldi. Iltimos qaytadan urinib ko'ring.", Markup.inlineKeyboard([backButton]));
      }

      db.prepare("INSERT INTO pending_payments (user_id, amount) VALUES (?, ?)").run(ctx.from.id, uniqueAmount);
         
      const cardNumber = getSetting('card_number') || '8600 1204 1234 5678';
      const cardHolder = getSetting('card_holder') || 'ISMI SHARIFI';
      
      const formattedAmount = uniqueAmount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
         
      const text = `✅ Buyurtma yaratildi!\n\n💵 To'lov summasi: ${formattedAmount} so'm\n💳 Karta raqami: <code>${cardNumber}</code>\n👤 Karta egasi: ${cardHolder}\n\n⏱ Muddati: 15 daqiqa\n\n⚠️ MUHIM: Aynan yuqoridagi summani o'tkazing!\nSumma bir xil bo'lmasa to'lov aniqlanmaydi.\n\n✨ To'lov avtomatik aniqlanadi va balansga qo'shiladi.`;
         
      ctx.session.userState = null;
      ctx.session.pendingTopupOriginal = null;
      ctx.session.pendingTopupAlternative = null;
         
      ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Asosiy menyu', callback_data: 'main_menu', style: 'danger' }]] } }).catch(console.error);
    }
  });

  // Product detail view (User)
  bot.action(/^product_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    const productId = parseInt(ctx.match[1]);
    const user = getUser(ctx.from.id);
    
    const product = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM product_keys WHERE product_id = p.id AND is_sold = 0) as stock, (SELECT COUNT(*) FROM product_keys WHERE product_id = p.id AND is_sold = 1) as sold FROM products p WHERE id = ?').get(productId);
    
    if (!product) return ctx.editMessageText("Tovar topilmadi.", Markup.inlineKeyboard([backButton]));
    
    const text = `✨ ${product.name}\n\n${product.description}\n\n💰 Narxi: ${product.price} so'm\n📦 Sotuvda: ${product.stock} ta\n📈 Sotilgan: ${product.sold} ta\n💳 Sizning balansingiz: ${user.balance || 0} so'm`;
    
    let buttons = [];
    if (product.stock > 0) {
      buttons.push([{ text: `🛒 Sotib olish — ${product.price} so'm`, callback_data: `buy_${product.id}`, style: 'success' }]);
    } else {
      buttons.push([{ text: '❌ Hozircha qolmagan', callback_data: 'empty_stock', style: 'danger' }]);
    }
    buttons.push([{ text: '📖 To\'liq qo\'llanma', callback_data: 'qollanma', style: 'primary' }]);
    buttons.push(backButton);
    
    ctx.editMessageText(text, Markup.inlineKeyboard(buttons)).catch(console.error);
  });

  bot.action('empty_stock', (ctx) => ctx.answerCbQuery("Ushbu tovar hozircha qolmagan.", { show_alert: true }));
  
  bot.action('add_product', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'add_product_name';
    ctx.reply("Yangi tovar nomini kiriting:\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^add_key_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const productId = parseInt(ctx.match[1]);
    ctx.session.adminState = 'add_key_text';
    ctx.session.pendingProductId = productId;
    ctx.reply("Yangi kalit (havola yoki kod) ni kiriting:\n\nBir nechta qo'shish uchun har birini yangi qatordan yozing.\nBekor qilish uchun /cancel");
  });

  bot.action(/^edit_prod_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const productId = parseInt(ctx.match[1]);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!p) return ctx.editMessageText('Tovar topilmadi', Markup.inlineKeyboard([adminBackButton]));
    
    ctx.editMessageText(`📦 Tovar: ${p.name}\n💰 Narxi: ${p.price}\n📝 Ma'lumot: ${p.description}\n🔗 API Ulash: ${p.api_service_id || 'Ulanmagan'}\n🎁 Referal bonus: ${p.referral_bonus ? p.referral_bonus + ' so\'m' : 'Belgilanmagan (Berilmaydi)'}\n\nQaysi qismini tahrirlaysiz?`, Markup.inlineKeyboard([
      [{ text: '✏️ Nomini', callback_data: `ep_name_${productId}`, style: 'primary' }, { text: '✏️ Narxini', callback_data: `ep_price_${productId}`, style: 'primary' }],
      [{ text: '📝 Ma\'lumotni', callback_data: `ep_desc_${productId}`, style: 'primary' }, { text: '📖 Qo\'llanmani', callback_data: `ep_guide_${productId}`, style: 'primary' }],
      [{ text: '🔗 API ulash (ID)', callback_data: `ep_api_${productId}`, style: 'primary' }, { text: '🎁 Referal bonus', callback_data: `ep_bonus_${productId}`, style: 'primary' }],
      [{ text: '🗑 O\'chirish', callback_data: `ep_del_${productId}`, style: 'danger' }],
      [{ text: '◀️ Ortga', callback_data: 'admin_products', style: 'danger' }]
    ]));
  });

  bot.action(/^ep_bonus_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'edit_prod_bonus';
    ctx.session.pendingProductId = parseInt(ctx.match[1]);
    ctx.editMessageText("Tovarning yangi referal bonusini kiriting (o'chirish/bermaslik uchun 0 ni yuboring):\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^ep_api_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'edit_prod_api';
    ctx.session.pendingProductId = parseInt(ctx.match[1]);
    ctx.editMessageText("Tovarni ulash uchun API Service ID ni kiriting (o'chirish uchun 0 ni yuboring):\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^ep_guide_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'edit_prod_guide';
    ctx.session.pendingProductId = parseInt(ctx.match[1]);
    ctx.editMessageText("Tovarning yangi qo'llanmasini kiriting:\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^ep_name_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'edit_prod_name';
    ctx.session.pendingProductId = parseInt(ctx.match[1]);
    ctx.editMessageText("Tovarning yangi nomini kiriting:\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^ep_price_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'edit_prod_price';
    ctx.session.pendingProductId = parseInt(ctx.match[1]);
    ctx.editMessageText("Tovarning yangi narxini kiriting:\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^ep_desc_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'edit_prod_desc';
    ctx.session.pendingProductId = parseInt(ctx.match[1]);
    ctx.editMessageText("Tovarning yangi ma'lumotini (description) kiriting:\n\nBekor qilish uchun /cancel");
  });

  bot.action(/^ep_del_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const productId = parseInt(ctx.match[1]);
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    db.prepare('DELETE FROM product_keys WHERE product_id = ?').run(productId);
    ctx.editMessageText("✅ Tovar o'chirildi.", Markup.inlineKeyboard([
      [{ text: '◀️ Ortga', callback_data: 'admin_products', style: 'danger' }]
    ]));
  });

  bot.action(/^buy_(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1]);
    const user = getUser(ctx.from.id);
    
    const product = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM product_keys WHERE product_id = p.id AND is_sold = 0) as stock FROM products p WHERE id = ?').get(productId);
    
    if (!product) return ctx.answerCbQuery("Tovar topilmadi.");
    if (product.stock <= 0) return ctx.answerCbQuery("Kechirasiz, ushbu tovar tugagan.", { show_alert: true });
    
    try {
      const purchasedKey = db.transaction(() => {
        // Double check balance inside transaction
        const currentUser = db.prepare('SELECT balance FROM users WHERE id = ?').get(ctx.from.id);
        if (currentUser.balance < product.price) {
          throw new Error('insufficient_balance');
        }

        // Find an available key and lock it
        const keyRow = db.prepare('SELECT * FROM product_keys WHERE product_id = ? AND is_sold = 0 LIMIT 1').get(productId);
        if (!keyRow) throw new Error('out_of_stock');

        // Atomically mark it as sold
        const updateResult = db.prepare('UPDATE product_keys SET is_sold = 1, sold_to = ?, sold_date = CURRENT_TIMESTAMP WHERE id = ? AND is_sold = 0').run(ctx.from.id, keyRow.id);
        if (updateResult.changes === 0) throw new Error('concurrency_conflict');

        // Deduct balance
        db.prepare('UPDATE users SET balance = balance - ?, total_paid = total_paid + ? WHERE id = ?').run(product.price, product.price, ctx.from.id);
        
        db.prepare('INSERT INTO purchases (user_id, item_name, link) VALUES (?, ?, ?)').run(
          ctx.from.id, product.name, keyRow.key_text
        );
        
        db.prepare('INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)').run(ctx.from.id, 'purchase', -product.price, `${product.name}: 1 ta xarid`);

        return keyRow;
      })();

      const checkStock = db.prepare('SELECT COUNT(*) as stock FROM product_keys WHERE product_id = ? AND is_sold = 0').get(productId).stock;

      if (checkStock === 0 && product.api_service_id) {
        // Trigger auto replenishment in background
        (async () => {
          try {
            const apiKey = getSetting('api_key');
            if (!apiKey) throw new Error("API kaliti kiritilmagan");
            const orderRes = await placeOrder(apiKey, product.api_service_id, 1);

            let finalKey = null;
            if (orderRes && (orderRes.order_id || orderRes.order)) {
              let orderId = orderRes.order_id || orderRes.order;
              // Poll for order status
              let maxAttempts = 10;
              while (maxAttempts > 0) {
                await new Promise(r => setTimeout(r, 5000));
                const statusRes = await getOrderStatus(apiKey, orderId);
                const orderData = statusRes.order || statusRes;
                if (orderData.status === 'Completed' || orderData.status === 'completed' || orderData.status === 'Success' || orderData.status === 'success') {
                  finalKey = orderData.link || orderData.key || orderData.result || `Order Completed: ${orderId}`;
                  break;
                }
                if (orderData.status === 'Canceled' || orderData.status === 'canceled' || orderData.status === 'Error' || orderData.status === 'error') {
                  throw new Error("Buyurtma API tomonidan bekor qilindi/xato");
                }
                maxAttempts--;
              }
            } else {
              // Maybe synchronous return?
              finalKey = orderRes.link || orderRes.key || JSON.stringify(orderRes);
            }

            if (finalKey) {
               db.prepare('INSERT INTO product_keys (product_id, key_text) VALUES (?, ?)').run(productId, finalKey);
               if (ADMIN_ID) {
                 await bot.telegram.sendMessage(ADMIN_ID, `🔄 <b>Avtomatik xarid muvaffaqiyatli!</b>\n\n🛍 Tovar: ${product.name}\n🔑 Yangi zaxira qo'shildi.`, { parse_mode: 'HTML' });
               }
            } else {
               throw new Error("Havola topilmadi (timeout)");
            }
          } catch (e) {
             if (ADMIN_ID) {
                 await bot.telegram.sendMessage(ADMIN_ID, `⚠️ <b>Avtomatik xarid xatosi:</b>\n\n🛍 Tovar: ${product.name}\n❌ Xato: ${e.message}`, { parse_mode: 'HTML' });
             }
          }
        })();
      }

      // Log purchase to channel if configured
      const purchaseChannelId = process.env.PURCHASE_CHANNEL_ID;
      if (purchaseChannelId) {
          try {
              await ctx.telegram.sendMessage(
                  purchaseChannelId,
                  `✅ Yangi xarid!\n\n🆔 Foydalanuvchi ID: ${ctx.from.id}\n👤 Ism: ${ctx.from.first_name}\n🛍 Mahsulot: ${product.name}\n💰 Narx: ${product.price} so'm\n📅 Vaqt: ${new Date().toLocaleString()}`
              );
          } catch (e) {
              console.error("Could not send purchase log to channel", e);
          }
      }

      // Referral bonus
      if (user.referrer_id && product.referral_bonus && product.referral_bonus > 0) {
        const referrer = getUser(user.referrer_id);
        if (referrer) {
          const refBonus = product.referral_bonus;
          addBalance(referrer.id, refBonus);
          db.prepare('UPDATE users SET referral_purchases = referral_purchases + 1, referral_earnings = referral_earnings + ? WHERE id = ?').run(refBonus, referrer.id);
          addTransaction(referrer.id, 'bonus', refBonus, 'Referal xaridi uchun maxsus bonus');
          try {
            ctx.telegram.sendMessage(referrer.id, `🎉 Taklif qilgan do'stingiz xaridni amalga oshirdi! Sizga ${refBonus} so'm bonus berildi.`);
          } catch (e) {}
        }
      }
      
      ctx.answerCbQuery('✅ Muvaffaqiyatli sotib oldingiz!', { show_alert: true });
      ctx.reply(`✅ Muvaffaqiyatli sotib oldingiz!\n\n${product.name} ma'lumotlari:\n${purchasedKey.key_text}\n\nBu havolani "📋 Mening vazifalarim" bo'limidan ham topishingiz mumkin.`, Markup.inlineKeyboard([backButton]));
    } catch (error) {
      if (error.message === 'insufficient_balance') {
        ctx.answerCbQuery(`❌ Balansingizda yetarli mablag' mavjud emas. Kerakli summa: ${product.price} so'm.`, { show_alert: true });
      } else if (error.message === 'out_of_stock' || error.message === 'concurrency_conflict') {
        ctx.answerCbQuery("Kechirasiz, tovar tugab qoldi. Iltimos qayta urinib ko'ring.", { show_alert: true });
      } else {
        console.error("Purchase error:", error);
        ctx.answerCbQuery("Xatolik yuz berdi. Iltimos keyinroq urinib ko'ring.", { show_alert: true });
      }
    }
  });

  bot.action('vazifalarim', (ctx) => {
    ctx.answerCbQuery();
    const purchases = db.prepare('SELECT * FROM purchases WHERE user_id = ? ORDER BY date DESC').all(ctx.from.id);
    if (purchases.length === 0) {
      ctx.editMessageText('Sizda hozircha sotib olingan obunalar yo\'q.', Markup.inlineKeyboard([backButton])).catch(console.error);
    } else {
      let text = '📋 Mening vazifalarim\n\n';
      purchases.forEach((p, i) => {
        text += `✅ ${p.item_name} — sotib olingan\n🔗 ${p.link}\n📅 ${new Date(p.date).toLocaleString()}\n\n`;
      });
      ctx.editMessageText(text, Markup.inlineKeyboard([backButton])).catch(console.error);
    }
  });

  bot.action('referal', (ctx) => {
    ctx.answerCbQuery();
    const user = getUser(ctx.from.id);
    const bonus = getSetting('referral_bonus') || '10000';
    const botInfo = ctx.botInfo;
    const refLink = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    
    const text = `👥 Referal dasturi\n\n🔗 Sizning havolangiz:\n${refLink}\n\n🎁 Mukofot: Taklif qilgan do'stingiz Gemini Pro havolasini muvaffaqiyatli xarid qilgan har safar sizga ${bonus} so'm balans bonusi beriladi.\n\nℹ️ Oddiy balans to'ldirish bonus bermaydi. Bonus faqat muvaffaqiyatli yakunlangan mahsulot xarididan keyin tushadi.\n\n📊 Statistika:\n👤 Taklif qilgansiz: ${user.referral_count || 0} ta\n✅ Xarid qilgan do'stlar: ${user.referral_purchases || 0} ta\n💰 Umumiy daromad: ${user.referral_earnings || 0} so'm`;
    
    ctx.editMessageText(text, Markup.inlineKeyboard([backButton])).catch(console.error);
  });

  bot.action('qollanma', (ctx) => {
    ctx.answerCbQuery();
    handleHelpCommand(ctx, true);
  });

  bot.action(/^show_guide_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    const productId = parseInt(ctx.match[1]);
    const product = db.prepare('SELECT guide FROM products WHERE id = ?').get(productId);
    if (!product) {
      return ctx.editMessageText('Tovar topilmadi.', Markup.inlineKeyboard([backButton])).catch(console.error);
    }
    const text = product.guide || "Qo'llanma mavjud emas.";
    ctx.editMessageText(text, Markup.inlineKeyboard([backButton])).catch(console.error);
  });
  
  bot.action('tranzaksiyalar', (ctx) => {
    ctx.answerCbQuery();
    const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 10').all(ctx.from.id);
    
    if (transactions.length === 0) {
      ctx.editMessageText('Tranzaksiyalar tarixi bo\'sh.', Markup.inlineKeyboard([backButton])).catch(console.error);
      return;
    }
    
    let text = '📜 Tranzaksiyalar tarixi\n\n';
    transactions.forEach(t => {
      const icon = t.amount >= 0 ? '🟢' : '🔴';
      const sign = t.amount >= 0 ? '+' : '';
      const typeStr = t.type === 'topup' ? 'To\'ldirish' : (t.type === 'purchase' ? 'Yechish' : 'Bonus');
      text += `${icon} ${sign}${Math.abs(t.amount)} so'm\n💸 ${typeStr}\n📅 ${new Date(t.date).toLocaleString()}\n💬 ${t.description}\n\n`;
    });
    
    ctx.editMessageText(text, Markup.inlineKeyboard([backButton])).catch(console.error);
  });

  bot.on('pre_checkout_query', (ctx) => {
    ctx.answerPreCheckoutQuery(true);
  });

  bot.on('successful_payment', (ctx) => {
    const payment = ctx.message.successful_payment;
    if (payment.currency === 'XTR') {
      const amountStars = payment.total_amount;
      const rate = parseInt(getSetting('star_rate') || '150');
      const som = amountStars * rate;
      addBalance(ctx.from.id, som);
      addTransaction(ctx.from.id, 'topup', som, `Stars orqali to'ldirish: ${amountStars} Stars`);
      ctx.reply(`✅ To'lov muvaffaqiyatli! Balansingizga ${som} so'm qo'shildi.`, getMainMenu());
    }
  });

  // processReceiptText is now imported from paymentProcessor.js

  // Admin Commands & States
  bot.action('admin_products', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const products = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM product_keys WHERE product_id = p.id AND is_sold = 0) as stock FROM products p').all();
    
    if (products.length === 0) {
      return ctx.editMessageText("Sizda hozircha tovarlar yo'q.", Markup.inlineKeyboard([
        [{ text: '➕ Yangi tovar qo\'shish', callback_data: 'add_product', style: 'success' }],
        adminBackButton
      ]));
    }

    let text = "📦 Barcha tovarlar:\n\n";
    let buttons = [];
    products.forEach(p => {
      text += `🆔 ID: ${p.id} | ${p.name}\n💰 Narx: ${p.price} so'm | 📦 Omborda: ${p.stock} ta\n\n`;
      buttons.push([{ text: `✏️ Tahrirlash: ${p.name}`, callback_data: `edit_prod_${p.id}`, style: 'primary' }]);
    });
    buttons.push([{ text: '➕ Yangi tovar qo\'shish', callback_data: 'add_product', style: 'success' }]);
    buttons.push(adminBackButton);

    ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
  });

  bot.action('admin_add_key', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const products = db.prepare('SELECT * FROM products').all();
    if (products.length === 0) return ctx.editMessageText("Oldin tovar qo'shing.", Markup.inlineKeyboard([adminBackButton]));
    
    let buttons = [];
    products.forEach(p => {
      buttons.push([{ text: `${p.name}`, callback_data: `add_key_${p.id}`, style: 'primary' }]);
    });
    buttons.push(adminBackButton);
    ctx.editMessageText("Qaysi tovarga kalit/havola qo'shmoqchisiz?", Markup.inlineKeyboard(buttons));
  });

  bot.action('admin_set_bonus', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'set_bonus';
    ctx.editMessageText(`Joriy bonus: ${getSetting('referral_bonus')} so'm.\nYangi bonusni faqat raqamlarda kiriting:`, Markup.inlineKeyboard([adminBackButton]));
  });

  bot.action('admin_set_card_number', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'set_card_number';
    ctx.editMessageText(`Joriy karta raqami: ${getSetting('card_number') || 'O\'rnatilmagan'}\nYangi karta raqamini kiriting:`, Markup.inlineKeyboard([adminBackButton]));
  });

  bot.action('admin_set_card_holder', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'set_card_holder';
    ctx.editMessageText(`Joriy karta egasi: ${getSetting('card_holder') || 'O\'rnatilmagan'}\nYangi karta egasi ism-familiyasi kiriting:`, Markup.inlineKeyboard([adminBackButton]));
  });

    bot.action('admin_userbot_settings', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = null;

    const status = isUserbotRunning() ? '🟢 Ishlayapti' : '🔴 To\'xtatilgan';
    const text = `🤖 Userbot Sozlamalari\n\nHolat: ${status}\n\nQuyidagi tugma orqali hisobni ulashingiz mumkin.`;

    ctx.editMessageText(text, Markup.inlineKeyboard([
      [{ text: '🔗 Hisob ulash', callback_data: 'admin_userbot_connect', style: 'success' }],
      adminBackButton
    ]));
  });

  bot.action('admin_userbot_connect', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    initiateUserbotLogin(ctx);
  });

  bot.action('admin_api_manage', async (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;

    const apiKey = getSetting('api_key');
    let balanceText = "No'malum";

    if (apiKey) {
      try {
        const balInfo = await getBalance(apiKey);
        balanceText = JSON.stringify(balInfo);
      } catch (err) {
        balanceText = "Xato: " + err.message;
      }
    }

    const text = `🌐 API Boshqaruvi\n\n🔑 API Kalit: ${apiKey ? 'O\'rnatilgan' : 'O\'rnatilmagan'}\n💰 API Balans: ${balanceText}`;

    ctx.editMessageText(text, Markup.inlineKeyboard([
      [{ text: '🔑 API Kalitni o\'zgartirish', callback_data: 'admin_set_api_key', style: 'primary' }],
      [{ text: '🛍 API dagi tovarlarni ko\'rish', callback_data: 'admin_api_products', style: 'primary' }],
      adminBackButton
    ])).catch(console.error);
  });

  bot.action('admin_set_api_key', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'set_api_key';
    ctx.editMessageText("Yangi API kalitni kiriting (bekor qilish uchun /cancel):", Markup.inlineKeyboard([
      [{ text: '◀️ Ortga', callback_data: 'admin_api_manage', style: 'danger' }]
    ])).catch(console.error);
  });

  bot.action('admin_api_products', async (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const apiKey = getSetting('api_key');
    if (!apiKey) return ctx.editMessageText("API kalit o'rnatilmagan.", Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: 'admin_api_manage', style: 'danger' }]]));

    ctx.editMessageText("Yuklanmoqda...").catch(console.error);
    try {
      const prods = await getProducts(apiKey);
      // Assuming prods is an array or object containing array of products.
      // We will slice to not exceed message limits
      let pList = Array.isArray(prods) ? prods : (prods.services || prods.data || []);

      let text = "🛍 API dagi tovarlar (Service ID lar):\n\n";
      pList.slice(0, 30).forEach(p => {
        text += `ID: ${p.service_id || p.id} | Nom: ${p.name || p.title}\n`;
      });
      if (pList.length === 0) text += "Hech narsa topilmadi.";

      ctx.editMessageText(text, Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: 'admin_api_manage', style: 'danger' }]]));
    } catch (err) {
      ctx.editMessageText("Xatolik: " + err.message, Markup.inlineKeyboard([[{ text: '◀️ Ortga', callback_data: 'admin_api_manage', style: 'danger' }]]));
    }
  });

  bot.action('admin_broadcast', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'broadcast_message';
    ctx.editMessageText(
      "📢 Xabar yuborish bo'limi:\n\nBarcha foydalanuvchilarga yubormoqchi bo'lgan xabaringizni yuboring.\nMatn, rasm yoki video jo'natishingiz mumkin.\n\nBekor qilish uchun /cancel tugmasini bosing.",
      Markup.inlineKeyboard([adminBackButton])
    );
  });

  bot.on('message', async (ctx, next) => {
    if (ctx.session.adminState === 'broadcast_message' && ctx.from.id === ADMIN_ID) {
      if (ctx.message.text && ctx.message.text.startsWith('/')) {
        return next();
      }

      ctx.session.adminState = null;
      ctx.reply("Yuborilmoqda... Bu jarayon orqa fonda amalga oshiriladi va bot ishini davom ettiradi. Tugagach sizga xabar beraman.");

      const users = db.prepare('SELECT id FROM users').all();

      // Run the broadcast in the background immediately without blocking Telegraf update processing
      (async () => {
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          try {
            await ctx.telegram.copyMessage(user.id, ctx.message.chat.id, ctx.message.message_id);
            successCount++;
          } catch (error) {
            failCount++;
            if (error.response && error.response.error_code === 403) {
               // Bot was blocked by the user, optional handle
            }
          }

          // Rate limiting for Telegram API (max 30 messages per second)
          // Lowering batch size and yielding event loop for smooth performance
          if (i > 0 && i % 20 === 0) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            // yield to event loop so other events can be processed
            await new Promise(resolve => setImmediate(resolve));
          }
        }

        try {
          await ctx.telegram.sendMessage(ctx.from.id, `✅ Xabar yuborish yakunlandi.\n\nMuvaqqiyatli: ${successCount} ta\nXatolik (Bloklaganlar): ${failCount} ta`, getAdminMenu());
        } catch (e) {
          console.error("Failed to notify admin about broadcast completion", e);
        }
      })();

      return;
    }
    return next();
  });

  bot.on('text', async (ctx) => {
    const state = ctx.session.adminState;
    
    if (ctx.session.userState === 'topup_amount') {
      const amountSum = parseInt(ctx.message.text.replace(/\D/g, ''));
      if (isNaN(amountSum) || amountSum < 20000 || amountSum > 1000000) {
        return ctx.reply("Iltimos, 20 000 dan 1 000 000 gacha bo'lgan to'g'ri summani kiritishni unutmang.\nBekor qilish uchun /cancel");
      }
      
      let uniqueAmount = amountSum;
      let isUnique = false;
      const checkPending = db.prepare("SELECT COUNT(*) as count FROM pending_payments WHERE amount = ? AND created_at > datetime('now', '-15 minutes')");
      
      if (checkPending.get(amountSum).count === 0) {
        isUnique = true;
      } else {
        for (let i = 1; i < 100; i++) {
          if (checkPending.get(amountSum + i).count === 0) {
            uniqueAmount = amountSum + i;
            isUnique = true;
            break;
          }
        }
        
        if (!isUnique) {
          return ctx.reply("Hozirda bu summa uchun juda ko'p so'rovlar mavjud. Iltimos, birozdan so'ng yoki boshqa summa bilan urinib ko'ring.");
        }
        
        ctx.session.userState = 'topup_confirm_amount';
        ctx.session.pendingTopupAlternative = uniqueAmount;
        ctx.session.pendingTopupOriginal = amountSum;
        
        const diff = uniqueAmount - amountSum;
        const formattedOriginal = amountSum.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
        const formattedAlternative = uniqueAmount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
        
        const text = `⚠️ ${formattedOriginal} so'm summasi hozirda band.\n\nBiz sizga ${formattedAlternative} so'm taklif qilamiz.\nFarq atigi ${diff} so'm.\n\nDavom etasizmi?`;
        
        return ctx.reply(text, Markup.inlineKeyboard([
          [{ text: '✅ Davom etish', callback_data: 'confirm_amount', style: 'success' }, { text: '❌ Bekor qilish', callback_data: 'main_menu', style: 'danger' }]
        ]));
      }

      db.prepare("INSERT INTO pending_payments (user_id, amount) VALUES (?, ?)").run(ctx.from.id, uniqueAmount);
         
      const cardNumber = getSetting('card_number') || '8600 1204 1234 5678';
      const cardHolder = getSetting('card_holder') || 'ISMI SHARIFI';
      
      const formattedAmount = uniqueAmount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
         
      const text = `✅ Buyurtma yaratildi!\n\n💵 To'lov summasi: ${formattedAmount} so'm\n💳 Karta raqami: <code>${cardNumber}</code>\n👤 Karta egasi: ${cardHolder}\n\n⏱ Muddati: 15 daqiqa\n\n⚠️ MUHIM: Aynan yuqoridagi summani o'tkazing!\nSumma bir xil bo'lmasa to'lov aniqlanmaydi.\n\n✨ To'lov avtomatik aniqlanadi va balansga qo'shiladi.`;
         
      ctx.session.userState = null;
      ctx.session.pendingTopup = null;
         
      return ctx.replyWithHTML(text, Markup.inlineKeyboard([backButton]));
    }

    if (ctx.session.userState === 'waiting_for_receipt') {
      ctx.session.userState = null;
      ctx.session.pendingTopup = null;
      return ctx.reply("Bekor qilindi.", getMainMenu());
    }

    if (ctx.from.id === ADMIN_ID && state) {
      if (state.startsWith('userbot_auth_')) {
          handleUserbotAuthInputs(ctx, state, bot).catch(console.error);
          return;
      }
      if (state === 'add_product_name') {
        ctx.session.newProduct = { name: ctx.message.text };
        ctx.session.adminState = 'add_product_desc';
        ctx.reply("Endi tovar haqida qisqacha ma'lumot (description) kiriting:");
      } else if (state === 'add_product_desc') {
        ctx.session.newProduct.description = ctx.message.text;
        ctx.session.adminState = 'add_product_price';
        ctx.reply("Endi tovar narxini kiriting (faqat raqam):");
      } else if (state === 'add_product_price') {
        const val = parseInt(ctx.message.text.replace(/\D/g, ''));
        if (isNaN(val)) return ctx.reply('Faqat raqam kiriting.');
        ctx.session.newProduct.price = val;
        ctx.session.adminState = 'add_product_guide';
        ctx.reply("Endi tovar uchun qo'llanma matnini kiriting:");
      } else if (state === 'add_product_guide') {
        ctx.session.newProduct.guide = ctx.message.text;
        ctx.session.adminState = 'add_product_bonus';
        ctx.reply("Endi ushbu tovar uchun maxsus referal bonus summasini kiriting (ixtiyoriy, agar bermoqchi bo'lmasangiz 0 ni yuboring):");
      } else if (state === 'add_product_bonus') {
        let bonusVal = parseInt(ctx.message.text.replace(/\D/g, ''));
        if (isNaN(bonusVal)) bonusVal = 0; // fallback if text was entered
        ctx.session.newProduct.referral_bonus = bonusVal > 0 ? bonusVal : null;

        const p = ctx.session.newProduct || {};
        if (!p.name || !p.description || !p.price) {
            ctx.session.adminState = null;
            return ctx.reply('Xatolik: Tovar ma\'lumotlari toliq emas. Iltimos qaytadan urinib ko\'ring.', getAdminMenu());
        }
        try {
            db.prepare('INSERT INTO products (name, description, price, guide, referral_bonus) VALUES (?, ?, ?, ?, ?)').run(p.name, p.description, p.price, p.guide, p.referral_bonus);
            ctx.session.adminState = null;
            ctx.session.newProduct = null;
            return ctx.reply('✅ Yangi tovar muvaffaqiyatli qo\'shildi!', getAdminMenu());
        } catch (e) {
            console.error(e);
            ctx.reply('Xatolik yuz berdi: ' + e.message);
        }
      } else if (state === 'edit_prod_name') {
        db.prepare('UPDATE products SET name = ? WHERE id = ?').run(ctx.message.text, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        return ctx.reply('✅ Tovar nomi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_desc') {
        db.prepare('UPDATE products SET description = ? WHERE id = ?').run(ctx.message.text, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        return ctx.reply('✅ Tovar ma\'lumoti muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_price') {
        const val = parseInt(ctx.message.text);
        if (isNaN(val)) return ctx.reply('Faqat raqam kiriting.');
        db.prepare('UPDATE products SET price = ? WHERE id = ?').run(val, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        return ctx.reply('✅ Tovar narxi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_guide') {
        db.prepare('UPDATE products SET guide = ? WHERE id = ?').run(ctx.message.text, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        return ctx.reply('✅ Tovar qo\'llanmasi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_api') {
        let val = ctx.message.text.trim();
        if (val === '0') val = null;
        db.prepare('UPDATE products SET api_service_id = ? WHERE id = ?').run(val, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        return ctx.reply('✅ Tovar API ID muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_bonus') {
        let val = parseInt(ctx.message.text.replace(/\D/g, ''));
        if (isNaN(val) || val <= 0) val = null;
        db.prepare('UPDATE products SET referral_bonus = ? WHERE id = ?').run(val, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        return ctx.reply('✅ Tovar referal bonusi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'add_key_text') {
        const lines = ctx.message.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return ctx.reply("Kamida 1 ta kalit yozing.");
        const stmt = db.prepare('INSERT INTO product_keys (product_id, key_text) VALUES (?, ?)');
        const addKeys = db.transaction((keys) => {
          for (const key of keys) stmt.run(ctx.session.pendingProductId, key);
        });
        addKeys(lines);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        ctx.reply(`✅ ${lines.length} ta kalit muvaffaqiyatli qo'shildi!`, getAdminMenu());
      } else if (state === 'set_bonus') {
        const val = parseInt(ctx.message.text);
        if (isNaN(val)) return ctx.reply('Faqat raqam kiriting.');
        setSetting('referral_bonus', val.toString());
        ctx.session.adminState = null;
        return ctx.reply('✅ Bonus muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'set_card_number') {
        setSetting('card_number', ctx.message.text);
        ctx.session.adminState = null;
        return ctx.reply('✅ Karta raqami muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'set_card_holder') {
        setSetting('card_holder', ctx.message.text);
        ctx.session.adminState = null;
        return ctx.reply('✅ Karta egasi ism-familiyasi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'set_api_key') {
        setSetting('api_key', ctx.message.text.trim());
        ctx.session.adminState = null;
        return ctx.reply('✅ API Kalit muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'manage_user_id') {
        const userId = parseInt(ctx.message.text);
        if (isNaN(userId)) return ctx.reply('Faqat raqam (User ID) kiriting.');
        const user = getUser(userId);
        if (!user) return ctx.reply('Foydalanuvchi topilmadi.', getAdminMenu());
        
        ctx.session.adminState = null;
        ctx.session.manageUserId = userId;
        
        const text = `👤 Foydalanuvchi: ${user.first_name}\n🆔 ID: ${user.id}\n💰 Balans: ${user.balance} so'm\n💸 Jami xarajat: ${user.total_paid} so'm\n\nHolat: ${user.is_blocked ? '🔴 Bloklangan' : '🟢 Faol'}`;
        
        ctx.reply(text, Markup.inlineKeyboard([
          [{ text: '➕ Balans qo\'shish', callback_data: `admin_addbal_${userId}`, style: 'success' }, { text: '➖ Balans ayirish', callback_data: `admin_subbal_${userId}`, style: 'danger' }],
          [{ text: user.is_blocked ? '🟢 Blokdan chiqarish' : '🔴 Bloklash', callback_data: `admin_block_${userId}`, style: user.is_blocked ? 'success' : 'danger' }],
          [{ text: '📜 Tarixini ko\'rish', callback_data: `admin_uhistory_${userId}`, style: 'primary' }],
          adminBackButton
        ]));
      } else if (state === 'add_user_balance') {
        const amount = parseInt(ctx.message.text);
        if (isNaN(amount)) return ctx.reply('Faqat raqam kiriting.');
        const userId = ctx.session.manageUserId;
        addBalance(userId, amount);
        addTransaction(userId, 'topup', amount, `Admin tomonidan qo'shildi`);
        ctx.session.adminState = null;
        ctx.reply(`✅ Foydalanuvchi ${userId} balansiga ${amount} so'm qo'shildi.`, getAdminMenu());
        try {
          ctx.telegram.sendMessage(userId, `🎉 Balansingiz admin tomonidan ${amount} so'mga to'ldirildi!`);
        } catch (e) {}
      } else if (state === 'sub_user_balance') {
        const amount = parseInt(ctx.message.text);
        if (isNaN(amount)) return ctx.reply('Faqat raqam kiriting.');
        const userId = ctx.session.manageUserId;
        addBalance(userId, -amount);
        addTransaction(userId, 'topup', -amount, `Admin tomonidan ayrildi`);
        ctx.session.adminState = null;
        ctx.reply(`✅ Foydalanuvchi ${userId} balansidan ${amount} so'm ayrildi.`, getAdminMenu());
        try {
          ctx.telegram.sendMessage(userId, `📉 Balansingizdan admin tomonidan ${amount} so'm ayrildi.`);
        } catch (e) {}
      }
    } else {
      if (ctx.message.text !== '⬅️ Asosiy menyu' && !ctx.message.text.startsWith('/')) {
        let isReceipt = false;
        if (ctx.from.id === ADMIN_ID) {
          isReceipt = await processReceiptText(ctx.message.text, ctx, "Bot (Qo'lda jo'natilgan)", bot);
        }
        
        if (!isReceipt) {
          ctx.reply(`Iltimos, menyudan kerakli bo'limni tanlang:`, getMainMenu());
        }
      }
    }
  });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  

// Auto-cancel pending payments older than 15 minutes
setInterval(() => {
  try {
    const expiredPayments = db.prepare("SELECT rowid as id, user_id, amount FROM pending_payments WHERE created_at <= datetime('now', '-15 minutes')").all();

    for (const payment of expiredPayments) {
      db.prepare('DELETE FROM pending_payments WHERE rowid = ?').run(payment.id);

      const formattedAmount = payment.amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
      const text = `⚠️ Diqqat!\n\nSizning ${formattedAmount} so'm miqdoridagi balans to'ldirish buyurtmangiz uchun ajratilgan 15 daqiqa vaqt tugadi va u avtomatik tarzda bekor qilindi.`;

      bot.telegram.sendMessage(payment.user_id, text).catch(err => {
        // Ignored if user blocked the bot or isn't reachable
      });
    }
  } catch (err) {
    console.error('Error auto-cancelling payments:', err);
  }
}, 60 * 1000); // Check every minute

bot.launch().catch(err => console.error('Failed to launch bot:', err));
  console.log('Telegram bot is running.');
  setTimeout(() => {
    startUserbot(bot).catch(console.error);
  }, 2000);
} else {
  console.warn('[AI Studio] TELEGRAM_BOT_TOKEN is not set. Bot will not start.');
}

app.get('/', (req, res) => {
  res.send('Telegram Bot Server is running. Please configure your TELEGRAM_BOT_TOKEN.');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', botActive: !!bot });
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
