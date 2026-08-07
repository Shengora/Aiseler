import WebSocket from 'ws';
import db from './db.js';

export class StarKerakClient {
  constructor(apiKey, bot, getSetting, addBalance, addTransaction, getUser) {
    this.apiKey = apiKey;
    this.bot = bot;
    this.wssUrl = 'wss://check.paystars.uz/api/ws/payments';
    this.ws = null;
    this.reconnectTimeout = null;
    this.getSetting = getSetting;
    this.addBalance = addBalance;
    this.addTransaction = addTransaction;
    this.getUser = getUser;
  }

  connect() {
    if (!this.apiKey) {
      console.log('StarKerak API Key yo\'q, WebSocket ishga tushmadi.');
      return;
    }
    
    const url = `${this.wssUrl}?api_key=${this.apiKey}`;
    console.log('StarKerak serveriga ulanilmoqda...');
    
    this.ws = new WebSocket(url);
    this.pingInterval = null;

    this.ws.on('open', () => {
      console.log('✅ StarKerak serveriga muvaffaqiyatli ulandi! To\'lovlarni kutmoqda...');
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000); // 30 seconds heartbeat
    });

    this.ws.on('message', async (data) => {
      try {
        const payment = JSON.parse(data.toString());
        console.log('Yangi to\'lov:', payment);
        await this.handlePayment(payment);
      } catch (err) {
        console.error('To\'lovni qayta ishlashda xatolik:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('StarKerak WebSocket yopildi. 5 soniyadan keyin qayta ulanadi...');
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('StarKerak WebSocket xatosi:', err.message);
      if (this.pingInterval) clearInterval(this.pingInterval);
      this.ws.close();
    });
  }

  scheduleReconnect() {
    if (!this.reconnectTimeout) {
      this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
    }
  }

  async handlePayment(payment) {
    const amount = parseInt(payment.amount);
    if (!amount) return;
    
    // Check if there is a matching pending payment by exact amount within the last 15 minutes
    const pendingPayment = db.prepare("SELECT rowid as id, * FROM pending_payments WHERE amount = ? AND created_at > datetime('now', '-15 minutes') ORDER BY created_at DESC LIMIT 1").get(amount);
    
    if (pendingPayment) {
      const userId = pendingPayment.user_id;
      const user = this.getUser(userId);
      
      if (user) {
        this.addBalance(userId, amount);
        this.addTransaction(userId, 'topup', amount, `Avto-tasdiq (StarKerak): Karta orqali`);
        
        // Remove the pending payment to prevent double credit
        db.prepare('DELETE FROM pending_payments WHERE rowid = ?').run(pendingPayment.id);
        
        try {
          await this.bot.telegram.sendMessage(userId, `✅ Karta to'lovingiz avtomatik tasdiqlandi! Balansingizga ${amount} so'm qo'shildi.`);
        } catch (e) {
          console.error("Could not send auto-approve message", e);
        }
      }
    } else {
      // Fallback to checking comments for ID just in case
      const fullText = `${payment.text || ''} ${payment.comment || ''}`.toLowerCase();
      const idMatch = fullText.match(/\b\d{8,12}\b/); 
      
      if (idMatch) {
        const userId = parseInt(idMatch[0]);
        const user = this.getUser(userId);
        
        if (user) {
          this.addBalance(userId, amount);
          this.addTransaction(userId, 'topup', amount, `Avto-tasdiq (StarKerak): Karta orqali (Izohdan)`);
          
          try {
            await this.bot.telegram.sendMessage(userId, `✅ Karta to'lovingiz avtomatik tasdiqlandi! Balansingizga ${amount} so'm qo'shildi.`);
          } catch (e) {
            console.error("Could not send auto-approve message", e);
          }
        }
      } else {
        console.log('To\'lov bo\'yicha kutilayotgan so\'rov yoki izohda foydalanuvchi IDsi topilmadi.');
      }
    }
  }
}
