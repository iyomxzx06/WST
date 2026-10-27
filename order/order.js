const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const money = value => `₱${Number(value || 0).toLocaleString('en-PH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})}`;
const deliveryFee = 30;
const attemptStorageKey = 'havens-online-checkout';
const cart = new Map();
let supabase = null;
let menuProducts = [];
let currentAttempt = null;
let trackingToken = '';
let trackingTimer = 0;
let trackingBusy = false;

function showMessage(message, isError = true) {
  const target = $('storeMessage');
  target.textContent = message;
  target.classList.remove('hidden', 'error', 'success');
  target.classList.add(isError ? 'error' : 'success');
}

function clearMessage() {
  $('storeMessage').textContent = '';
  $('storeMessage').classList.add('hidden');
}

function cartSubtotal() {
  return [...cart.values()].reduce((total, item) => total + Number(item.product.price) * item.quantity, 0);
}

function fulfillmentType() {
  return $('orderForm').elements.fulfillment_type.value;
}

function updateTotals() {
  const subtotal = cartSubtotal();
  const fee = fulfillmentType() === 'delivery' && cart.size ? deliveryFee : 0;
  $('subtotal').textContent = money(subtotal);
  $('deliveryTotalRow').classList.toggle('hidden', fee === 0);
  $('orderTotal').textContent = money(subtotal + fee);
  $('submitOrder').disabled = cart.size === 0;
}

function renderCart() {
  const items = [...cart.values()];
  const count = items.reduce((total, item) => total + item.quantity, 0);
  $('cartCount').textContent = String(count);
  if (!items.length) {
    $('cartItems').innerHTML = '<div class="cart-empty"><span aria-hidden="true">＋</span><b>Your basket is waiting.</b><small>Add a burger or an extra from the menu.</small></div>';
  } else {
    $('cartItems').innerHTML = items.map(({ product, quantity }) => `
      <article class="cart-line">
        <div class="cart-line-copy"><b>${escapeHtml(product.name)}</b><small>${money(product.price)} each</small></div>
        <div class="quantity-control">
          <button type="button" data-quantity="${escapeHtml(product.id)}" data-change="-1" aria-label="Remove one ${escapeHtml(product.name)}">−</button>
          <span aria-label="Quantity">${quantity}</span>
          <button type="button" data-quantity="${escapeHtml(product.id)}" data-change="1" aria-label="Add one ${escapeHtml(product.name)}" ${quantity >= 20 ? 'disabled' : ''}>+</button>
        </div>
        <b class="cart-line-total">${money(Number(product.price) * quantity)}</b>
      </article>`).join('');
    $('cartItems').querySelectorAll('[data-quantity]').forEach(button => button.addEventListener('click', () => {
      const item = cart.get(button.dataset.quantity);
      if (!item) return;
      item.quantity += Number(button.dataset.change);
      if (item.quantity <= 0) cart.delete(button.dataset.quantity);
      renderCart();
    }));
  }
  updateTotals();
}

function addToCart(productId) {
  const product = menuProducts.find(item => item.id === productId);
  if (!product) {
    showMessage('That menu item is no longer available. Refresh the menu and try again.');
    return;
  }
  const existing = cart.get(product.id);
  if (existing && existing.quantity >= 20) {
    showMessage('You can order up to 20 of each menu item.');
    return;
  }
  if (existing) existing.quantity += 1;
  else cart.set(product.id, { product, quantity: 1 });
  clearMessage();
  renderCart();
}

function renderMenu() {
  $('menuCount').textContent = `${menuProducts.length} ${menuProducts.length === 1 ? 'item' : 'items'}`;
  if (!menuProducts.length) {
    $('menuGrid').innerHTML = '<div class="menu-empty"><b>The menu is taking a quick break.</b><span>Please check back in a moment.</span></div>';
    return;
  }
  $('menuGrid').innerHTML = menuProducts.map((product, index) => {
    const name = escapeHtml(product.name);
    const accent = index % 4;
    return `<article class="menu-card menu-accent-${accent}">
      <div class="menu-card-art" aria-hidden="true"><span>${escapeHtml(product.name.slice(0, 1).toUpperCase())}</span><i></i><b>HB</b></div>
      <div class="menu-card-copy"><span class="menu-card-kicker">${product.name.toLowerCase().includes('burger') ? 'GRILL FAVORITE' : 'A LITTLE EXTRA'}</span><h3>${name}</h3>
        <div class="menu-card-footer"><b>${money(product.price)}</b><button type="button" data-add="${escapeHtml(product.id)}" aria-label="Add ${name} to your order">Add <span aria-hidden="true">＋</span></button></div>
      </div>
    </article>`;
  }).join('');
  $('menuGrid').querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => addToCart(button.dataset.add)));
}

async function loadMenu() {
  clearMessage();
  $('menuCount').textContent = 'Loading menu…';
  $('menuGrid').innerHTML = '<div class="menu-loading"><span class="loading-spinner" aria-hidden="true"></span><span>Getting the grill ready…</span></div>';
  const { data, error } = await supabase.rpc('get_public_order_menu');
  if (error) throw new Error(error.message || 'The menu could not be loaded.');
  if (!data || !Array.isArray(data.products)) throw new Error('The online menu is not configured correctly.');
  menuProducts = data.products.filter(product => product && typeof product.id === 'string'
    && typeof product.name === 'string' && Number.isFinite(Number(product.price)) && Number(product.price) >= 0);
  $('branchName').textContent = data.branch_name || data.business_name || 'Freshly made, just for you';
  renderMenu();
}

function updateFulfillmentFields() {
  const isDelivery = fulfillmentType() === 'delivery';
  $('deliveryFields').classList.toggle('hidden', !isDelivery);
  $('deliveryAddress').required = isDelivery;
  updateTotals();
  $('paymentHelp').textContent = $('orderForm').elements.payment_method.value === 'gcash'
    ? 'No GCash payment is taken here. Staff will contact you with payment instructions after confirming your order.'
    : isDelivery ? 'Pay cash when your order is delivered.' : 'Pay cash when you pick up your order.';
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function getCheckoutAttempt(payload) {
  const signature = JSON.stringify(payload);
  if (currentAttempt?.signature === signature) return currentAttempt;
  const stored = sessionStorage.getItem(attemptStorageKey);
  if (stored) {
    let parsed;
    try { parsed = JSON.parse(stored); } catch { sessionStorage.removeItem(attemptStorageKey); }
    if (parsed && typeof parsed === 'object' && parsed.signature === signature
      && /^[0-9a-f]{64}$/.test(parsed.token) && typeof parsed.key === 'string') {
      currentAttempt = parsed;
      return currentAttempt;
    }
  }
  currentAttempt = { signature, key: crypto.randomUUID(), token: randomToken() };
  sessionStorage.setItem(attemptStorageKey, JSON.stringify(currentAttempt));
  return currentAttempt;
}

function clearCheckoutAttempt() {
  currentAttempt = null;
  sessionStorage.removeItem(attemptStorageKey);
}

async function submitOrder(event) {
  event.preventDefault();
  clearMessage();
  if (!cart.size) {
    showMessage('Add at least one menu item before sending your order.');
    return;
  }
  const form = $('orderForm');
  if (!form.reportValidity()) return;
  const fields = new FormData(form);
  const fulfillment = String(fields.get('fulfillment_type'));
  const payload = {
    items: [...cart.values()].map(({ product, quantity }) => ({ product_id: product.id, quantity })),
    customer_name: String(fields.get('customer_name')).trim(),
    customer_phone: String(fields.get('customer_phone')).trim(),
    fulfillment_type: fulfillment,
    delivery_address: fulfillment === 'delivery' ? String(fields.get('delivery_address')).trim() : '',
    delivery_landmark: fulfillment === 'delivery' ? String(fields.get('delivery_landmark')).trim() : '',
    payment_method: String(fields.get('payment_method')),
    notes: String(fields.get('notes')).trim()
  };
  const button = $('submitOrder');
  button.disabled = true;
  button.classList.add('is-loading');
  button.querySelector('span:first-child').textContent = 'Sending your request…';
  try {
    const attempt = getCheckoutAttempt(payload);
    const { data, error } = await supabase.rpc('submit_online_order', {
      p_items: payload.items,
      p_customer_name: payload.customer_name,
      p_customer_phone: payload.customer_phone,
      p_fulfillment_type: payload.fulfillment_type,
      p_delivery_address: payload.delivery_address,
      p_delivery_landmark: payload.delivery_landmark,
      p_payment_method: payload.payment_method,
      p_notes: payload.notes,
      p_idempotency_key: attempt.key,
      p_tracking_token: attempt.token
    });
    if (error) throw new Error(error.message || 'The order request could not be sent.');
    if (!data?.reference || data.tracking_token !== attempt.token) throw new Error('The order was received, but its tracking link could not be verified. Please contact the restaurant before submitting again.');
    clearCheckoutAttempt();
    cart.clear();
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = `track=${attempt.token}`;
    window.history.replaceState(null, '', nextUrl);
    await loadTracking(attempt.token, data.reference);
  } catch (error) {
    showMessage(error.message || 'The order request could not be sent. Please try again.');
  } finally {
    button.classList.remove('is-loading');
    button.querySelector('span:first-child').textContent = 'Send order request';
    updateTotals();
  }
}

const trackingLabels = {
  pending: ['Waiting for confirmation', 'Our team will call or text to confirm the order details.'],
  accepted: ['Order confirmed', 'Our team has confirmed your order and will prepare it shortly.'],
  rejected: ['Order not confirmed', 'Our team could not accept this request. Please contact the restaurant if you need help.'],
  new: ['Order confirmed', 'Your order is confirmed and has been sent to the kitchen.'],
  preparing: ['Fresh off the grill', 'The kitchen is preparing your order now.'],
  ready: ['Ready', 'Your order is ready. Please follow the pickup or delivery details confirmed by staff.'],
  served: ['Completed', 'This order has been marked complete. Thank you for choosing Havens Burger!'],
  void: ['Order cancelled', 'This order has been cancelled. Please contact the restaurant if you have questions.']
};

async function loadTracking(token, knownReference = '') {
  trackingToken = token;
  window.clearInterval(trackingTimer);
  $('storefront').classList.add('hidden');
  $('confirmationScreen').classList.remove('hidden');
  $('confirmationScreen').focus();
  if (knownReference) $('confirmationReference').textContent = knownReference;
  $('trackingDetails').innerHTML = '<span class="loading-spinner" aria-label="Loading order status"></span>';
  await refreshTracking();
  trackingTimer = window.setInterval(() => {
    if (!document.hidden) refreshTracking();
  }, 30000);
}

async function refreshTracking() {
  if (!trackingToken || trackingBusy) return;
  trackingBusy = true;
  $('refreshTracking').disabled = true;
  try {
    const { data, error } = await supabase.rpc('get_online_order_status', { p_tracking_token: trackingToken });
    if (error) throw new Error(error.message || 'Order status could not be checked.');
    if (!data?.reference) throw new Error('The tracking link did not return an order reference.');
    const [title, description] = trackingLabels[data.status] || ['Order status', 'Please contact the restaurant for an update.'];
    $('confirmationTitle').textContent = title;
    $('confirmationMessage').textContent = description;
    $('confirmationReference').textContent = data.reference;
    $('trackingDetails').innerHTML = `
      <div><span>Status</span><b>${escapeHtml(title)}</b></div>
      <div><span>Order type</span><b>${data.fulfillment_type === 'delivery' ? 'Delivery' : 'Pickup'}</b></div>
      <div><span>Payment preference</span><b>${data.payment_method === 'gcash' ? 'GCash · instructions by staff' : 'Cash'}</b></div>
      <div><span>Order total</span><b>${money(data.total)}</b></div>`;
    $('trackingNotice').textContent = data.status === 'rejected'
      ? 'This private link shows only the order status and total. Contact Havens Burger if you would like to discuss this request.'
      : 'Keep this private tracking link to check your order status. GCash instructions, if selected, will be provided by staff after confirmation.';
    $('confirmationIcon').textContent = data.status === 'rejected' || data.status === 'void' ? '!' : '✓';
    $('confirmationIcon').classList.toggle('confirmation-icon-alert', data.status === 'rejected' || data.status === 'void');
  } catch (error) {
    $('trackingDetails').innerHTML = `<p class="tracking-error">${escapeHtml(error.message || 'Order status could not be checked.')}</p>`;
  } finally {
    $('refreshTracking').disabled = false;
    trackingBusy = false;
  }
}

async function copyTrackingLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    $('copyTrackingLink').textContent = 'Tracking link copied';
    window.setTimeout(() => { $('copyTrackingLink').textContent = 'Copy tracking link'; }, 2200);
  } catch {
    showMessage('Could not copy automatically. Copy the address from your browser to save your tracking link.');
  }
}

function initializeSupabase() {
  const config = window.HAVENS_SUPABASE_CONFIG;
  if (!window.supabase?.createClient || !config?.url || !config?.publishableKey) {
    throw new Error('Online ordering is temporarily unavailable. Please try again later.');
  }
  supabase = window.supabase.createClient(config.url, config.publishableKey);
}

async function initialize() {
  try {
    initializeSupabase();
    $('orderForm').addEventListener('submit', submitOrder);
    $('orderForm').querySelectorAll('[name="fulfillment_type"],[name="payment_method"]').forEach(input => {
      input.addEventListener('change', updateFulfillmentFields);
    });
    $('refreshTracking').addEventListener('click', refreshTracking);
    $('copyTrackingLink').addEventListener('click', copyTrackingLink);
    renderCart();
    updateFulfillmentFields();
    const token = new URLSearchParams(window.location.hash.slice(1)).get('track');
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      await loadTracking(token);
      return;
    }
    if (window.location.hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    await loadMenu();
  } catch (error) {
    showMessage(error.message || 'Online ordering is temporarily unavailable.');
    $('menuCount').textContent = 'Menu unavailable';
    $('menuGrid').innerHTML = '<button class="secondary menu-retry" type="button">Try loading the menu again</button>';
    $('menuGrid').querySelector('button').addEventListener('click', async () => {
      try { await loadMenu(); } catch (retryError) { showMessage(retryError.message || 'The menu could not be loaded.'); }
    });
  }
}

initialize();
