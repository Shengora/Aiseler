import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'bot.db');
let db;

try {
  db = new Database(dbPath);
} catch (error) {
  console.error("CRITICAL ERROR: Failed to initialize better-sqlite3 database.");
  console.error(error);
  process.exit(1); // Exit explicitly so it doesn't just hang or crash mysteriously
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    first_name TEXT,
    balance INTEGER DEFAULT 0,
    total_paid INTEGER DEFAULT 0,
    referral_count INTEGER DEFAULT 0,
    referral_purchases INTEGER DEFAULT 0,
    referral_earnings INTEGER DEFAULT 0,
    referrer_id INTEGER,
    is_blocked INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    item_name TEXT,
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    link TEXT
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT, -- 'topup', 'purchase', 'bonus'
    amount INTEGER,
    description TEXT,
    date DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_payments (
    user_id INTEGER,
    amount INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    price INTEGER,
    guide TEXT
  );

  CREATE TABLE IF NOT EXISTS product_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    key_text TEXT,
    is_sold INTEGER DEFAULT 0,
    sold_to INTEGER,
    sold_date DATETIME
  );
`);

// Ensure 'guide' column exists in case of an older database
try {
  db.prepare('ALTER TABLE products ADD COLUMN guide TEXT').run();
} catch (e) {
  // Ignore error if column already exists
}

// Add a default product if not exists
const checkProduct = db.prepare('SELECT COUNT(*) as count FROM products WHERE id = 1').get();
if (checkProduct.count === 0) {
  const defaultGuide = `📖 GEMINI PRO 18 oy qo'llanmasi

🎬 Qo'llanma video: Sotib olish bo'yicha video qo'llanma

Qanday sotib olinadi?
1️⃣ Asosiy menyudagi GEMINI PRO 18 oy tugmasini bosing.
2️⃣ Sotib olish tugmasini bosing. Har xaridda bitta havola beriladi.
3️⃣ Balans, Payme, Click yoki Uzum orqali to'lovni yakunlang.
4️⃣ To'lov tasdiqlangach, shaxsiy havolangiz shu chatga avtomatik yuboriladi.

Havoladan qanday foydalaniladi?
1️⃣ Havolani 24 soat ichida oching.
2️⃣ Obuna qo'shmoqchi bo'lgan Google akkauntingizga kiring.
3️⃣ Google ko'rsatmalarini oxirigacha bajaring va tasdiqlash oynasini yopmang.
4️⃣ Aktivatsiya yakunlangach, Gemini ilovasi yoki gemini.google.com orqali tekshiring.

Muhim qoidalar
• Har bir havola faqat bir marta va bitta Google akkauntda ishlatiladi.
• Havolani boshqa odamga yubormang va ommaga ulashmang.
• Google qo'shimcha tasdiqlash so'rasa, aynan o'zingizning akkauntingizda tasdiqlang.
• Obuna muddati Google va hamkor operator rejasi shartlariga bog'liq; odatda 18 oygacha faol bo'ladi.

💬 Savol yoki muammo bo'lsa: @shenGorauz

📌 Buyruqlar:
/start — Asosiy menyu
/help — To'liq qo'llanma
/balance — Balans
/topup — Balans to'ldirish
/services — GEMINI PRO 18 oy
/referral — Referal havolam
/cancel — Bekor qilish`;
  db.prepare('INSERT INTO products (id, name, description, price, guide) VALUES (?, ?, ?, ?, ?)').run(
    1, 'GEMINI PRO 18 oy', 'Google AI Pro uchun tayyor shaxsiy aktivatsiya havolasi.', 36000, defaultGuide
  );
}

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('gemini_price', '50000');
insertSetting.run('referral_bonus', '5000');
insertSetting.run('star_rate', '150'); // 1 Star = 150 so'm
insertSetting.run('gemini_link', 'https://t.me/example_private_channel');

export default db;
