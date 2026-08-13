import fetch from 'node-fetch';

const BASE_URL = 'https://api.geminipro7.store';

async function requestAPI(endpoint, method = 'GET', apiKey, body = null) {
  const options = {
    method,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json'
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, options);
  if (!res.ok) {
    throw new Error(`API Error: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

export async function getBalance(apiKey) {
  // Wait, let me check the /me endpoint or just use /balance if exist. Based on user: /me -> Get balance
  return requestAPI('/me', 'GET', apiKey);
}

export async function getProducts(apiKey) {
  return requestAPI('/products', 'GET', apiKey);
}

export async function placeOrder(apiKey, serviceId, quantity = 1) {
  return requestAPI('/order', 'POST', apiKey, { service_id: serviceId, quantity });
}

export async function getOrderStatus(apiKey, orderId) {
  return requestAPI(`/order/${orderId}`, 'GET', apiKey);
}
