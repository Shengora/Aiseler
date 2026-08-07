import asyncio
import json
import logging
import aiohttp

class StarKerakClient:
    def __init__(self, api_key: str, wss_url: str = "wss://check.paystars.uz/api/ws/payments"):
        """
        StarKerak Python Client
        :param api_key: WebApp dagi 'Sozlamalar' bo'limidan olingan API Kalit
        :param wss_url: Websocket server manzili (agar o'zgarsa)
        """
        self.api_key = api_key
        self.wss_url = wss_url
        self.rest_url = wss_url.replace("wss://", "https://").replace("ws/", "")
        self._on_payment_handler = None
        self._running = False
        self.last_payment_id = None
        self.logger = logging.getLogger("StarKerakClient")
        
        if not self.logger.handlers:
            logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(message)s")

    def on_payment(self, func):
        """
        Yangi to'lov tushganda ishga tushadigan funksiya (Decorator).
        """
        self._on_payment_handler = func
        return func

    async def get_history(self, limit: int = 50):
        """
        O'tmishdagi to'lovlar tarixini olish.
        """
        url = f"{self.rest_url}?limit={limit}"
        headers = {"X-API-Key": self.api_key}
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("payments", [])
                else:
                    self.logger.error(f"Tarixni olishda xatolik: HTTP {resp.status}")
                    return []

    async def _listen_loop(self):
        """Websocket orqali serverga ulanish va kutish logikasi."""
        
        while self._running:
            url_with_auth = f"{self.wss_url}?api_key={self.api_key}"
            if self.last_payment_id:
                url_with_auth += f"&last_payment_id={self.last_payment_id}"
                
            try:
                self.logger.info("StarKerak serveriga ulanilmoqda...")
                async with aiohttp.ClientSession() as session:
                    async with session.ws_connect(url_with_auth, heartbeat=30.0) as ws:
                        self.logger.info("✅ Muvaffaqiyatli ulandi! To'lovlarni kutmoqda...")
                        
                        async for msg in ws:
                            if msg.type == aiohttp.WSMsgType.TEXT:
                                data = json.loads(msg.data)
                                
                                # Track the highest ID seen
                                payment_id = data.get("id")
                                if payment_id:
                                    if not self.last_payment_id or payment_id > self.last_payment_id:
                                        self.last_payment_id = payment_id
                                        
                                if self._on_payment_handler:
                                    # Handler asinxron bo'lsa kutamiz, sinxron bo'lsa to'g'ridan to'g'ri chaqiramiz
                                    if asyncio.iscoroutinefunction(self._on_payment_handler):
                                        await self._on_payment_handler(data)
                                    else:
                                        self._on_payment_handler(data)
                            elif msg.type == aiohttp.WSMsgType.ERROR:
                                self.logger.error(f"WebSocket xatosi: {ws.exception()}")
                                break
            except aiohttp.ClientResponseError as e:
                if e.status in (401, 403):
                    self.logger.error(f"⛔️ FATAL XATOLIK: API Kalit xato, yaroqsiz yoki o'zgartirilgan! (Status: {e.status})")
                    self.logger.error("Iltimos, Boshqaruv Panelidan yangi API Kalit oling va kodingizni yangilang.")
                    self._running = False
                    break
                else:
                    self.logger.warning(f"Aloqa uzildi (Status {e.status}). 3 soniyadan so'ng qayta urinish...")
                    await asyncio.sleep(3)
            except Exception as e:
                # To handle aiohttp.WSServerHandshakeError which has status attribute
                status = getattr(e, 'status', None)
                if status in (401, 403):
                    self.logger.error(f"⛔️ FATAL XATOLIK: API Kalit xato, yaroqsiz yoki o'zgartirilgan! (Status: {status})")
                    self.logger.error("Iltimos, Boshqaruv Panelidan yangi API Kalit oling va kodingizni yangilang.")
                    self._running = False
                    break
                self.logger.warning(f"Aloqa uzildi yoki ulanib bo'lmadi: {e}. 3 soniyadan so'ng qayta urinish...")
                await asyncio.sleep(3)

    def start_listening(self):
        """
        Dasturni ishga tushirish (Sinxron kodlar uchun, asosan oddiy scriptlar uchun).
        """
        self._running = True
        try:
            asyncio.run(self._listen_loop())
        except KeyboardInterrupt:
            self.logger.info("Dastur to'xtatildi.")
            self._running = False

    async def start_listening_async(self):
        """
        Dasturni ishga tushirish (Asinxron kodlar / Aiogram botlar bilan birga ishlatish uchun).
        """
        self._running = True
        await self._listen_loop()
