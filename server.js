import 'dotenv/config';
import express from 'express';
import { Telegraf, session, Markup } from 'telegraf';
import db from './db.js';
import { processReceiptText } from './paymentProcessor.js';
import { initiateUserbotLogin, handleUserbotAuthInputs } from './userbotAuth.js';
import { startUserbot, isUserbotRunning } from './userbot.js';

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
      [Markup.button.callback('💰 Balansim', 'balansim'), Markup.button.callback('➕ Balans to\'ldirish', 'balans_toldirish')]
    ];
    
    products.forEach(p => {
      buttons.push([Markup.button.callback(`✨ ${p.name} (${p.stock} ta)`, `product_${p.id}`)]);
    });
    
    buttons.push(
      [Markup.button.callback('📖 To\'liq qo\'llanma', 'qollanma')],
      [Markup.button.callback('📋 Mening vazifalarim', 'vazifalarim'), Markup.button.callback('📜 Tranzaksiyalar', 'tranzaksiyalar')],
      [Markup.button.callback('👥 Referal havolam', 'referal')]
    );
    
    return Markup.inlineKeyboard(buttons);
  };

  const backButton = [Markup.button.callback('◀️ Asosiy menyu', 'main_menu')];
  const adminBackButton = [Markup.button.callback('◀️ Admin menyu', 'admin_menu')];

  const getAdminMenu = () => {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📊 Statistika', 'admin_stats'), Markup.button.callback('👥 Foydalanuvchi boshqaruvi', 'admin_user_manage')],
      [Markup.button.callback('📦 Tovarlar boshqaruvi', 'admin_products')],
      [Markup.button.callback('🔑 Kalit (Havola) qo\'shish', 'admin_add_key')],
      [Markup.button.callback('⚙️ Referal bonusni o\'zgartirish', 'admin_set_bonus')],
      [Markup.button.callback('💳 Karta o\'zgartirish', 'admin_set_card_number'), Markup.button.callback('👤 Karta egasini o\'zgartirish', 'admin_set_card_holder')],
      [Markup.button.callback('🤖 Userbot Sozlamalari', 'admin_userbot_settings')],
      [Markup.button.callback('◀️ Asosiy menyu', 'main_menu')]
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
    
    const welcomeMessage = `🌟 Gemini Worker Service\n\nKerakli bo'limni tanlang:`;
    ctx.reply(welcomeMessage, getMainMenu());
  });

  bot.command('cancel', (ctx) => {
    ctx.session.userState = null;
    ctx.reply('Bekor qilindi. Asosiy menyu:', getMainMenu());
  });

  bot.action('main_menu', (ctx) => {
    ctx.answerCbQuery();
    ctx.session.userState = null;
    const welcomeMessage = `🌟 Gemini Worker Service\n\nKerakli bo'limni tanlang:`;
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
      [Markup.button.callback('📜 Sotuvlar tarixi', 'admin_sales_history')],
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
        [Markup.button.callback('◀️ Ortga', 'admin_stats')]
      ]));
    }
    
    let text = "📜 Oxirgi 20 ta sotuvlar:\n\n";
    sales.forEach((s, idx) => {
      text += `${idx+1}. ID: ${s.sold_to} - ${s.name} (${s.sold_date})\n`;
    });
    
    ctx.editMessageText(text, Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Ortga', 'admin_stats')]
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
      [Markup.button.callback('➕ Balans qo\'shish', `admin_addbal_${userId}`), Markup.button.callback('➖ Balans ayirish', `admin_subbal_${userId}`)],
      [Markup.button.callback(user.is_blocked ? '🟢 Blokdan chiqarish' : '🔴 Bloklash', `admin_block_${userId}`)],
      [Markup.button.callback('📜 Tarixini ko\'rish', `admin_uhistory_${userId}`)],
      adminBackButton
    ]));
  });

  bot.action(/^admin_addbal_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'add_user_balance';
    ctx.session.manageUserId = parseInt(ctx.match[1]);
    ctx.editMessageText("Qo'shiladigan summani kiriting:", Markup.inlineKeyboard([[Markup.button.callback('◀️ Ortga', `manage_user_${ctx.match[1]}`)]]));
  });

  bot.action(/^admin_subbal_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminState = 'sub_user_balance';
    ctx.session.manageUserId = parseInt(ctx.match[1]);
    ctx.editMessageText("Ayriladigan summani kiriting:", Markup.inlineKeyboard([[Markup.button.callback('◀️ Ortga', `manage_user_${ctx.match[1]}`)]]));
  });

  bot.action(/^admin_block_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const userId = parseInt(ctx.match[1]);
    const user = getUser(userId);
    if (user) {
      const newStatus = user.is_blocked ? 0 : 1;
      db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(newStatus, userId);
      ctx.editMessageText(`Foydalanuvchi muvaffaqiyatli ${newStatus ? 'bloklandi' : 'blokdan chiqarildi'}.`, Markup.inlineKeyboard([[Markup.button.callback('◀️ Ortga', `manage_user_${userId}`)]]));
    }
  });

  bot.action(/^admin_uhistory_(\d+)$/, (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const userId = parseInt(ctx.match[1]);
    
    const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 15').all(userId);
    if (transactions.length === 0) {
      return ctx.editMessageText("Bu foydalanuvchida tranzaksiyalar yo'q.", Markup.inlineKeyboard([[Markup.button.callback('◀️ Ortga', `manage_user_${userId}`)]]));
    }
    
    let text = "📜 Foydalanuvchi tarixi (Oxirgi 15 ta):\n\n";
    transactions.forEach(t => {
      let icon = t.type === 'topup' ? '➕' : (t.type === 'purchase' ? '➖' : '🎁');
      text += `${icon} ${t.amount} so'm | ${t.description} | ${t.date}\n`;
    });
    
    ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback('◀️ Ortga', `manage_user_${userId}`)]]));
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
      [Markup.button.callback('➕ Balans to\'ldirish', 'balans_toldirish')],
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
    const bonus = getSetting('referral_bonus') || '10000';
    const botInfo = ctx.botInfo;
    const refLink = `https://t.me/${botInfo.username}?start=${ctx.from.id}`;
    
    const text = `👥 Referal dasturi\n\n🔗 Sizning havolangiz:\n${refLink}\n\n🎁 Mukofot: Taklif qilgan do'stingiz Gemini Pro havolasini muvaffaqiyatli xarid qilgan har safar sizga ${bonus} so'm balans bonusi beriladi.\n\nℹ️ Oddiy balans to'ldirish bonus bermaydi. Bonus faqat muvaffaqiyatli yakunlangan mahsulot xarididan keyin tushadi.\n\n📊 Statistika:\n👤 Taklif qilgansiz: ${user.referral_count || 0} ta\n✅ Xarid qilgan do'stlar: ${user.referral_purchases || 0} ta\n💰 Umumiy daromad: ${user.referral_earnings || 0} so'm`;
    
    ctx.reply(text, Markup.inlineKeyboard([backButton]));
  });

  bot.command('help', (ctx) => {
    const price = getSetting('gemini_price') || '36000';
    const text = `📖 GEMINI PRO 18 oy qo'llanmasi\n\n🎬 Qo'llanma video: Sotib olish bo'yicha video qo'llanma\n\nNarxi: ${price} so'm — 1 ta aktivatsiya havolasi\n\nQanday sotib olinadi?\n1️⃣ Asosiy menyudagi GEMINI PRO 18 oy tugmasini bosing.\n2️⃣ Sotib olish tugmasini bosing. Har xaridda bitta havola beriladi.\n3️⃣ Balans, Payme, Click yoki Uzum orqali to'lovni yakunlang.\n4️⃣ To'lov tasdiqlangach, shaxsiy havolangiz shu chatga avtomatik yuboriladi.\n\nHavoladan qanday foydalaniladi?\n1️⃣ Havolani 24 soat ichida oching.\n2️⃣ Obuna qo'shmoqchi bo'lgan Google akkauntingizga kiring.\n3️⃣ Google ko'rsatmalarini oxirigacha bajaring va tasdiqlash oynasini yopmang.\n4️⃣ Aktivatsiya yakunlangach, Gemini ilovasi yoki gemini.google.com orqali tekshiring.\n\nMuhim qoidalar\n• Har bir havola faqat bir marta va bitta Google akkauntda ishlatiladi.\n• Havolani boshqa odamga yubormang va ommaga ulashmang.\n• Google qo'shimcha tasdiqlash so'rasa, aynan o'zingizning akkauntingizda tasdiqlang.\n• Obuna muddati Google va hamkor operator rejasi shartlariga bog'liq; odatda 18 oygacha faol bo'ladi.\n\n💬 Savol yoki muammo bo'lsa: @shenGorauz \n\n📌 Buyruqlar:\n/start — Asosiy menyu\n/help — To'liq qo'llanma\n/balance — Balans\n/topup — Balans to'ldirish\n/services — GEMINI PRO 18 oy\n/referral — Referal havolam\n/cancel — Bekor qilish`;
    ctx.reply(text, Markup.inlineKeyboard([backButton]));
  });

  // User Actions
  bot.action('balansim', (ctx) => {
    ctx.answerCbQuery();
    const user = getUser(ctx.from.id);
    if (!user) return ctx.reply('Foydalanuvchi topilmadi. Iltimos /start ni bosing.');
    
    const text = `💰 Mening balansim\n\n💎 Balans: ${user.balance || 0} so'm\n🎫 Kreditlar: 0 ta\n📊 Jami to'langan: ${user.total_paid || 0} so'm\n\n💡 1 kredit = 19 900 so'm`;
    const balansMenu = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Balans to\'ldirish', 'balans_toldirish')],
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
         
      ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[Markup.button.callback('◀️ Asosiy menyu', 'main_menu')]] } }).catch(console.error);
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
      buttons.push([Markup.button.callback(`🛒 Sotib olish — ${product.price} so'm`, `buy_${product.id}`)]);
    } else {
      buttons.push([Markup.button.callback('❌ Hozircha qolmagan', 'empty_stock')]);
    }
    buttons.push([Markup.button.callback('📖 To\'liq qo\'llanma', 'qollanma')]);
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
    
    ctx.editMessageText(`📦 Tovar: ${p.name}\n💰 Narxi: ${p.price}\n📝 Ma'lumot: ${p.description}\n\nQaysi qismini tahrirlaysiz?`, Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Nomini', `ep_name_${productId}`), Markup.button.callback('✏️ Narxini', `ep_price_${productId}`)],
      [Markup.button.callback('📝 Ma\'lumotni', `ep_desc_${productId}`)],
      [Markup.button.callback('🗑 O\'chirish', `ep_del_${productId}`)],
      [Markup.button.callback('◀️ Ortga', 'admin_products')]
    ]));
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
      [Markup.button.callback('◀️ Ortga', 'admin_products')]
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
      if (user.referrer_id) {
        const referrer = getUser(user.referrer_id);
        if (referrer) {
          const refBonus = parseInt(getSetting('referral_bonus') || '10000');
          addBalance(referrer.id, refBonus);
          db.prepare('UPDATE users SET referral_purchases = referral_purchases + 1, referral_earnings = referral_earnings + ? WHERE id = ?').run(refBonus, referrer.id);
          addTransaction(referrer.id, 'bonus', refBonus, 'Referal xaridi uchun bonus');
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
    const price = getSetting('gemini_price') || '36000';
    const text = `📖 GEMINI PRO 18 oy qo'llanmasi\n\n🎬 Qo'llanma video: Sotib olish bo'yicha video qo'llanma\n\nNarxi: ${price} so'm — 1 ta aktivatsiya havolasi\n\nQanday sotib olinadi?\n1️⃣ Asosiy menyudagi GEMINI PRO 18 oy tugmasini bosing.\n2️⃣ Sotib olish tugmasini bosing. Har xaridda bitta havola beriladi.\n3️⃣ Balans, Payme, Click yoki Uzum orqali to'lovni yakunlang.\n4️⃣ To'lov tasdiqlangach, shaxsiy havolangiz shu chatga avtomatik yuboriladi.\n\nHavoladan qanday foydalaniladi?\n1️⃣ Havolani 24 soat ichida oching.\n2️⃣ Obuna qo'shmoqchi bo'lgan Google akkauntingizga kiring.\n3️⃣ Google ko'rsatmalarini oxirigacha bajaring va tasdiqlash oynasini yopmang.\n4️⃣ Aktivatsiya yakunlangach, Gemini ilovasi yoki gemini.google.com orqali tekshiring.\n\nMuhim qoidalar\n• Har bir havola faqat bir marta va bitta Google akkauntda ishlatiladi.\n• Havolani boshqa odamga yubormang va ommaga ulashmang.\n• Google qo'shimcha tasdiqlash so'rasa, aynan o'zingizning akkauntingizda tasdiqlang.\n• Obuna muddati Google va hamkor operator rejasi shartlariga bog'liq; odatda 18 oygacha faol bo'ladi.\n\n💬 Savol yoki muammo bo'lsa: @shenGorauz \n\n📌 Buyruqlar:\n/start — Asosiy menyu\n/help — To'liq qo'llanma\n/balance — Balans\n/topup — Balans to'ldirish\n/services — GEMINI PRO 18 oy\n/referral — Referal havolam\n/cancel — Bekor qilish`;
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

  bot.on('business_message', async (ctx) => {
    // Only accept business messages from the Main Admin or the Payment Admin
    if (ctx.from.id !== ADMIN_ID && ctx.from.id !== PAYMENT_ADMIN_ID) return;
    
    // Check if the business message is from the connected admin account
    const message = ctx.businessMessage;
    if (!message || !message.text) return;
    
    await processReceiptText(message.text, ctx, "Business", bot);
  });

  // Admin Commands & States
  bot.action('admin_products', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    const products = db.prepare('SELECT p.*, (SELECT COUNT(*) FROM product_keys WHERE product_id = p.id AND is_sold = 0) as stock FROM products p').all();
    
    if (products.length === 0) {
      return ctx.editMessageText("Sizda hozircha tovarlar yo'q.", Markup.inlineKeyboard([
        [Markup.button.callback('➕ Yangi tovar qo\'shish', 'add_product')],
        adminBackButton
      ]));
    }

    let text = "📦 Barcha tovarlar:\n\n";
    let buttons = [];
    products.forEach(p => {
      text += `🆔 ID: ${p.id} | ${p.name}\n💰 Narx: ${p.price} so'm | 📦 Omborda: ${p.stock} ta\n\n`;
      buttons.push([Markup.button.callback(`✏️ Tahrirlash: ${p.name}`, `edit_prod_${p.id}`)]);
    });
    buttons.push([Markup.button.callback('➕ Yangi tovar qo\'shish', 'add_product')]);
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
      buttons.push([Markup.button.callback(`${p.name}`, `add_key_${p.id}`)]);
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
      [Markup.button.callback('🔗 Hisob ulash', 'admin_userbot_connect')],
      adminBackButton
    ]));
  });

  bot.action('admin_userbot_connect', (ctx) => {
    ctx.answerCbQuery();
    if (ctx.from.id !== ADMIN_ID) return;
    initiateUserbotLogin(ctx);
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
          [Markup.button.callback('✅ Davom etish', 'confirm_amount'), Markup.button.callback('❌ Bekor qilish', 'main_menu')]
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
          return await handleUserbotAuthInputs(ctx, state, bot);
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
        const val = parseInt(ctx.message.text);
        if (isNaN(val)) return ctx.reply('Faqat raqam kiriting.');
        const p = ctx.session.newProduct;
        db.prepare('INSERT INTO products (name, description, price) VALUES (?, ?, ?)').run(p.name, p.description, val);
        ctx.session.adminState = null;
        ctx.session.newProduct = null;
        ctx.reply('✅ Yangi tovar muvaffaqiyatli qo\'shildi!', getAdminMenu());
      } else if (state === 'edit_prod_name') {
        db.prepare('UPDATE products SET name = ? WHERE id = ?').run(ctx.message.text, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        ctx.reply('✅ Tovar nomi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_desc') {
        db.prepare('UPDATE products SET description = ? WHERE id = ?').run(ctx.message.text, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        ctx.reply('✅ Tovar ma\'lumoti muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'edit_prod_price') {
        const val = parseInt(ctx.message.text);
        if (isNaN(val)) return ctx.reply('Faqat raqam kiriting.');
        db.prepare('UPDATE products SET price = ? WHERE id = ?').run(val, ctx.session.pendingProductId);
        ctx.session.adminState = null;
        ctx.session.pendingProductId = null;
        ctx.reply('✅ Tovar narxi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
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
        ctx.reply('✅ Bonus muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'set_card_number') {
        setSetting('card_number', ctx.message.text);
        ctx.session.adminState = null;
        ctx.reply('✅ Karta raqami muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'set_card_holder') {
        setSetting('card_holder', ctx.message.text);
        ctx.session.adminState = null;
        ctx.reply('✅ Karta egasi ism-familiyasi muvaffaqiyatli o\'zgartirildi!', getAdminMenu());
      } else if (state === 'manage_user_id') {
        const userId = parseInt(ctx.message.text);
        if (isNaN(userId)) return ctx.reply('Faqat raqam (User ID) kiriting.');
        const user = getUser(userId);
        if (!user) return ctx.reply('Foydalanuvchi topilmadi.', getAdminMenu());
        
        ctx.session.adminState = null;
        ctx.session.manageUserId = userId;
        
        const text = `👤 Foydalanuvchi: ${user.first_name}\n🆔 ID: ${user.id}\n💰 Balans: ${user.balance} so'm\n💸 Jami xarajat: ${user.total_paid} so'm\n\nHolat: ${user.is_blocked ? '🔴 Bloklangan' : '🟢 Faol'}`;
        
        ctx.reply(text, Markup.inlineKeyboard([
          [Markup.button.callback('➕ Balans qo\'shish', `admin_addbal_${userId}`), Markup.button.callback('➖ Balans ayirish', `admin_subbal_${userId}`)],
          [Markup.button.callback(user.is_blocked ? '🟢 Blokdan chiqarish' : '🔴 Bloklash', `admin_block_${userId}`)],
          [Markup.button.callback('📜 Tarixini ko\'rish', `admin_uhistory_${userId}`)],
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
