export const PAYSTARS_API_KEY = process.env.PAYSTARS_API_KEY;
export const PAYSTARS_BASE_URL = process.env.PAYSTARS_BASE_URL || 'https://paystars.uz/api/v1';

const HEADERS = {
    "X-API-Key": PAYSTARS_API_KEY || '',
    "Content-Type": "application/json"
};

// Hisobdagi balansni tekshirish
export async function getBalance() {
    if (!PAYSTARS_API_KEY) return { error: "API key is missing" };
    try {
        const res = await fetch(`${PAYSTARS_BASE_URL}/balance`, { headers: HEADERS });
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}

// Barcha narxlar katalogi
export async function getPrices() {
    if (!PAYSTARS_API_KEY) return { error: "API key is missing" };
    try {
        const res = await fetch(`${PAYSTARS_BASE_URL}/prices`, { headers: HEADERS });
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}

// Stars sotib olish
export async function buyStars(username, quantity) {
    if (!PAYSTARS_API_KEY) return { error: "API key is missing" };
    try {
        const res = await fetch(`${PAYSTARS_BASE_URL}/stars/buy`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ username, quantity })
        });
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}

// Premium sotib olish
export async function buyPremium(username, months) {
    if (!PAYSTARS_API_KEY) return { error: "API key is missing" };
    try {
        const res = await fetch(`${PAYSTARS_BASE_URL}/premium/buy`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ username, months })
        });
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}

// Buyurtma holatini tekshirish
export async function getOrderStatus(orderId) {
    if (!PAYSTARS_API_KEY) return { error: "API key is missing" };
    try {
        const res = await fetch(`${PAYSTARS_BASE_URL}/order/${orderId}`, { headers: HEADERS });
        return await res.json();
    } catch (e) {
        return { error: e.message };
    }
}
