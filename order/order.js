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
const cartStorageKey = 'havens-online-cart';
const cart = new Map();
let supabase = null;
let menuProducts = [];
let currentAttempt = null;
let trackingToken = '';
let trackingTimer = 0;
let trackingBusy = false;
  let menuFilter = 'all';
  let menuSearchTerm = '';
let submittingOrder = false;
let toastTimer = 0;

function showToast(message) {
  const toast = $('orderToast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

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

function saveCart() {
  try {
    localStorage.setItem(cartStorageKey, JSON.stringify([...cart.values()].map(({ product, quantity }) => ({
      productId: product.id,
      quantity
    }))));
  } catch {
    // Private browsing or blocked storage should not prevent ordering.
  }
}

function restoreCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(cartStorageKey) || '[]');
    if (!Array.isArray(saved)) return;
    saved.forEach(item => {
      const product = menuProducts.find(candidate => candidate.id === item.productId);
      const quantity = Math.min(20, Math.max(0, Number(item.quantity) || 0));
      if (product && isProductAvailable(product) && quantity) {
        const existing = cart.get(product.id);
        cart.set(product.id, { product, quantity: Math.min(20, (existing?.quantity || 0) + quantity) });
      }
    });
    saveCart();
  } catch {
    try { localStorage.removeItem(cartStorageKey); } catch { /* Storage is unavailable. */ }
  }
}

function isProductAvailable(product) {
  return product?.is_available !== false && product?.available !== false && product?.active !== false;
}

function customerProductName(name) {
  const match = String(name || '').match(/^B\d\s*-\s*(.+?)\s*-\s*(Single|B1T1)$/i);
  if (!match) return String(name || 'Menu item');
  return `${match[1]} · ${match[2].toUpperCase() === 'B1T1' ? 'B1T1 · 2 burgers' : 'Single'}`;
}

function fulfillmentType() {
  return $('orderForm').elements.fulfillment_type.value;
}

function updateTotals() {
  const subtotal = cartSubtotal();
  const count = [...cart.values()].reduce((total, item) => total + item.quantity, 0);
  const fee = fulfillmentType() === 'delivery' && cart.size ? deliveryFee : 0;
  $('subtotal').textContent = money(subtotal);
  $('deliveryTotalRow').classList.toggle('hidden', fee === 0);
  $('orderTotal').textContent = money(subtotal + fee);
  $('submitOrder').disabled = cart.size === 0 || submittingOrder;
  if (!$('submitOrder').classList.contains('is-loading')) {
    $('submitOrder').querySelector('span:first-child').textContent = 'Send order request';
  }
  $('mobileCartTotal').textContent = money(subtotal + fee);
  $('menuCartTotal').textContent = money(subtotal);
  $('menuCartLabel').textContent = `Your order · ${count}`;
}

function renderCart() {
  const items = [...cart.values()];
  const count = items.reduce((total, item) => total + item.quantity, 0);
  $('cartCount').textContent = String(count);
  $('mobileCartCount').textContent = String(count);
  $('mobileCartLabel').textContent = count ? `${count} ${count === 1 ? 'item' : 'items'} in your basket` : 'Your basket is empty';
  $('mobileCartBar').classList.toggle('hidden', count === 0);
  if (!items.length) {
    $('cartItems').innerHTML = '<div class="cart-empty"><span aria-hidden="true">＋</span><b>Your basket is waiting.</b><small>Add a burger or an extra from the menu.</small></div>';
  } else {
    $('cartItems').innerHTML = items.map(({ product, quantity }) => `
      <article class="cart-line">
        <div class="cart-line-copy"><b>${escapeHtml(customerProductName(product.name))}</b><small>${money(product.price)} each</small></div>
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
      saveCart();
      renderCart();
    }));
  }
  $('clearCart').classList.toggle('hidden', !items.length);
  updateTotals();
}

function addToCart(productId) {
  const product = menuProducts.find(item => item.id === productId);
  if (!product) {
    showMessage('That menu item is no longer available. Refresh the menu and try again.');
    return;
  }
  if (!isProductAvailable(product)) {
    showMessage(`${product.name} is currently unavailable. Please choose another item.`);
    return;
  }
  const existing = cart.get(product.id);
  if (existing && existing.quantity >= 20) {
    showMessage('You can order up to 20 of each menu item.');
    return;
  }
  if (existing) existing.quantity += 1;
  else cart.set(product.id, { product, quantity: 1 });
  saveCart();
  clearMessage();
  renderCart();
  showToast(`${product.name} added to your basket.`);
  document.querySelectorAll('[data-add]').forEach(addButton => {
    if (addButton.dataset.add !== product.id) return;
    const original = addButton.innerHTML;
    addButton.innerHTML = 'Added <span aria-hidden="true">✓</span>';
    addButton.classList.add('just-added');
    window.setTimeout(() => {
      if (!addButton.isConnected) return;
      addButton.innerHTML = original;
      addButton.classList.remove('just-added');
    }, 1000);
  });
}

function burgerVariant(product) {
  const labeled = product.name.match(/^B([1-4])\s*-\s*(.+?)\s*-\s*(Single|B1T1)$/i);
  if (labeled) return { number: labeled[1], variant: labeled[3].toUpperCase() === 'B1T1' ? 'B1T1' : 'Single' };
  const standard = product.name.match(/^(Classic|Cheese|Deluxe|Double Cheese) Burger\s*-\s*(Single|B1T1)$/i);
  if (!standard) return null;
  return {
    number: { classic: '1', cheese: '2', deluxe: '3', 'double cheese': '4' }[standard[1].toLowerCase()],
    variant: standard[2].toUpperCase() === 'B1T1' ? 'B1T1' : 'Single'
  };
}

function burgerName(number) {
  return { 1: 'Classic Burger', 2: 'Cheese Burger', 3: 'Deluxe Burger', 4: 'Double Cheese Burger' }[number];
}

function burgerDescription(number) {
  return {
    1: 'Grilled beef patty, fresh onion, and Havens sauce.',
    2: 'Grilled beef patty, melted cheese, onion, and Havens sauce.',
    3: 'Loaded with cheese, onion, tomato, lettuce, and Havens sauce.',
    4: 'Two beef patties, double cheese, onion, and Havens sauce.'
  }[number];
}

function renderBurgerCard(number, variants) {
  const productName = burgerName(number);
  const sizeButtons = variants.map(product => {
    const variant = burgerVariant(product).variant;
    return `<button type="button" class="burger-size-button" data-add="${escapeHtml(product.id)}">
      <span>${variant === 'B1T1' ? 'B1T1 · 2 burgers' : 'Single'}</span><b>${money(product.price)}</b><i aria-hidden="true">＋</i>
    </button>`;
  }).join('');
  return `<article class="burger-card">
    <div class="burger-photo-wrap">
      <img class="burger-photo" src="../restaurant-system/images/B${number}.jpg" alt="${escapeHtml(`B${number} ${productName}`)}" loading="lazy">
    </div>
    <div class="burger-card-copy">
      <span class="menu-card-kicker">HAVENS SIGNATURE</span>
      <h3>${escapeHtml(productName)}</h3>
      <p>Choose your size</p>
      <details class="burger-details"><summary>What’s inside?</summary><span>${escapeHtml(burgerDescription(number))}</span></details>
      <div class="burger-sizes">${sizeButtons}</div>
    </div>
  </article>`;
}

function renderAddonCard(product, index) {
  const name = escapeHtml(product.name);
  const icon = { bacon: '🥓', 'beef patty': '🍔', lettuce: '🥬', onion: '🧅', sauce: '🥫', 'slice cheese': '🧀', tomato: '🍅' }[product.name.toLowerCase()] || '＋';
  return `<article class="addon-card">
    <div class="addon-art addon-art-${index % 4}" aria-hidden="true"><span>${icon}</span></div>
    <div class="addon-card-copy"><span class="menu-card-kicker">MAKE IT EXTRA</span><h3>${name}</h3><b>${money(product.price)}</b></div>
    <button class="addon-add-button" type="button" data-add="${escapeHtml(product.id)}" aria-label="Add ${name} to your order">＋</button>
  </article>`;
}

function wireAddButtons(container) {
  container.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => addToCart(button.dataset.add)));
}

function renderFeatured() {
  const burgers = new Map();
  menuProducts.filter(isProductAvailable).forEach(product => {
    const variant = burgerVariant(product);
    if (!variant) return;
    if (!burgers.has(variant.number)) burgers.set(variant.number, []);
    burgers.get(variant.number).push(product);
  });
  const cards = [...burgers.entries()]
    .sort(([first], [second]) => Number(first) - Number(second))
    .map(([number, variants]) => {
      const product = variants.find(item => burgerVariant(item).variant === 'Single') || variants[0];
      const variantName = burgerVariant(product).variant;
      return `<article class="featured-card">
        <img src="../restaurant-system/images/B${number}.jpg" alt="${escapeHtml(`B${number} ${burgerName(number)}`)}" loading="lazy">
        <div class="featured-card-copy">
          <span class="menu-card-kicker">B${number} · HAVENS SIGNATURE</span>
          <h3>${escapeHtml(burgerName(number))}</h3>
          <span>${variantName} · ${money(product.price)}</span>
          <button type="button" data-add="${escapeHtml(product.id)}">Add to order <span aria-hidden="true">＋</span></button>
        </div>
      </article>`;
    }).join('');
  $('featuredGrid').innerHTML = cards || '<div class="featured-loading">Signature burgers are not available right now.</div>';
  wireAddButtons($('featuredGrid'));
  $('featuredGrid').querySelectorAll('img').forEach(image => image.addEventListener('error', () => {
    image.classList.add('photo-unavailable');
  }, { once: true }));
}

function renderMenu() {
  const burgers = new Map();
  const addons = [];
  const visibleProducts = menuProducts.filter(product => isProductAvailable(product)
    && (!menuSearchTerm || product.name.toLowerCase().includes(menuSearchTerm)));
  visibleProducts.forEach(product => {
    const variant = burgerVariant(product);
    if (!variant) {
      addons.push(product);
      return;
    }
    if (!burgers.has(variant.number)) burgers.set(variant.number, []);
    burgers.get(variant.number).push(product);
  });
  const burgerMarkup = [...burgers.entries()]
    .sort(([first], [second]) => Number(first) - Number(second))
    .map(([number, variants]) => renderBurgerCard(number, variants.sort((a, b) => {
      const aRank = burgerVariant(a).variant === 'Single' ? 0 : 1;
      const bRank = burgerVariant(b).variant === 'Single' ? 0 : 1;
      return aRank - bRank;
    })))
    .join('');
  const addonMarkup = addons.map(renderAddonCard).join('');
  const visibleCount = menuFilter === 'burgers' ? burgers.size : menuFilter === 'addons' ? addons.length : burgers.size + addons.length;
  $('menuCount').textContent = `${visibleCount} ${visibleCount === 1 ? 'choice' : 'choices'}`;
  $('menuGrid').classList.toggle('addons-only', menuFilter === 'addons');
  if (!visibleCount) {
    $('menuGrid').innerHTML = '<div class="menu-empty"><b>The menu is taking a quick break.</b><span>Please check back in a moment.</span></div>';
    return;
  }
  $('menuGrid').innerHTML = `${menuFilter !== 'addons' && burgerMarkup ? `<div class="menu-group-heading"><div><b>Signature burgers</b><span>Find your favorite, fresh off the grill.</span></div></div>${burgerMarkup}` : ''}
    ${menuFilter !== 'burgers' && addonMarkup ? `<div class="menu-group-heading addon-group-heading"><div><b>Make it extra</b><span>Add-ons for your burger.</span></div></div>${addonMarkup}` : ''}
    ${!burgerMarkup && !addonMarkup ? '<div class="menu-empty"><b>No menu items are available right now.</b></div>' : ''}`;
  wireAddButtons($('menuGrid'));
  $('menuGrid').querySelectorAll('.burger-photo').forEach(image => image.addEventListener('error', () => {
    image.closest('.burger-photo-wrap').classList.add('photo-unavailable');
  }, { once: true }));
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
  restoreCart();
  renderFeatured();
  renderMenu();
  renderCart();
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
  if (submittingOrder) return;
  clearMessage();
  if (!cart.size) {
    showMessage('Add at least one menu item before sending your order.');
    return;
  }
  const form = $('orderForm');
  if (!form.reportValidity()) return;
  const fields = new FormData(form);
  const fulfillment = String(fields.get('fulfillment_type'));
  const phone = String(fields.get('customer_phone') || '').trim().replace(/[\s()-]/g, '');
  if (!/^(09\d{9}|\+639\d{9})$/.test(phone)) {
    showMessage('Enter a valid Philippine mobile number, e.g. 09171234567.');
    $('customerPhone').focus();
    return;
  }
  const address = String(fields.get('delivery_address') || '').trim();
  if (fulfillment === 'delivery' && address.length < 10) {
    showMessage('Please enter a complete delivery address with at least 10 characters.');
    $('deliveryAddress').focus();
    return;
  }
  const payload = {
    items: [...cart.values()].map(({ product, quantity }) => ({ product_id: product.id, quantity })),
    customer_name: String(fields.get('customer_name')).trim(),
    customer_phone: phone,
    fulfillment_type: fulfillment,
    delivery_address: fulfillment === 'delivery' ? address : '',
    delivery_landmark: fulfillment === 'delivery' ? String(fields.get('delivery_landmark')).trim() : '',
    payment_method: String(fields.get('payment_method')),
    notes: String(fields.get('notes')).trim()
  };
  const button = $('submitOrder');
  submittingOrder = true;
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
    saveCart();
    const nextUrl = new URL(window.location.href);
    nextUrl.hash = `track=${attempt.token}`;
    window.history.replaceState(null, '', nextUrl);
    await loadTracking(attempt.token, data.reference);
  } catch (error) {
    showMessage(error.message || 'The order request could not be sent. Please try again.');
  } finally {
    submittingOrder = false;
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
  document.body.classList.add('tracking-mode');
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = `track=${token}`;
  window.history.replaceState(null, '', nextUrl);
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

function trackingTokenFromInput(value) {
  const input = value.trim();
  if (/^[0-9a-f]{64}$/i.test(input)) return input.toLowerCase();
  try {
    const url = new URL(input, window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const token = new URLSearchParams(url.hash.slice(1)).get('track') || '';
    return /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : '';
  } catch {
    return '';
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
    const updateStoreNav = () => {
      const currentHash = window.location.hash === '#track-order' ? '#track-order'
        : window.location.hash.startsWith('#track=') ? '#track-order'
          : window.location.hash || '#home';
      document.querySelectorAll('.store-nav a').forEach(link => {
        if (link.hash === currentHash) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    };
    window.addEventListener('hashchange', updateStoreNav);
    updateStoreNav();
    $('trackingForm').addEventListener('submit', async event => {
      event.preventDefault();
      const token = trackingTokenFromInput($('trackingLink').value);
      if (!token) {
        $('trackingLookupMessage').textContent = 'Enter a valid private tracking link or 64-character code.';
        $('trackingLookupMessage').classList.add('error');
        return;
      }
      $('trackingLookupMessage').textContent = '';
      $('trackingLookupMessage').classList.remove('error');
      await loadTracking(token);
    });
    $('orderForm').querySelectorAll('[name="fulfillment_type"],[name="payment_method"]').forEach(input => {
      input.addEventListener('change', updateFulfillmentFields);
    });
    $('menuFilters').querySelectorAll('[data-menu-filter]').forEach(button => button.addEventListener('click', () => {
      menuFilter = button.dataset.menuFilter;
      $('menuFilters').querySelectorAll('[data-menu-filter]').forEach(filter => {
        const active = filter === button;
        filter.classList.toggle('active', active);
        filter.setAttribute('aria-pressed', String(active));
      });
      renderMenu();
    }));
    $('menuSearch').addEventListener('input', event => {
      menuSearchTerm = event.currentTarget.value.trim().toLowerCase();
      renderMenu();
    });
    $('clearCart').addEventListener('click', () => {
      if (!cart.size || !window.confirm('Clear all items from your basket?')) return;
      cart.clear();
      saveCart();
      renderCart();
    });
    $('refreshTracking').addEventListener('click', refreshTracking);
    $('copyTrackingLink').addEventListener('click', copyTrackingLink);
    renderCart();
    updateFulfillmentFields();
    document.querySelectorAll('.store-nav a').forEach(link => link.addEventListener('click', () => {
      document.querySelectorAll('.store-nav a').forEach(item => item.removeAttribute('aria-current'));
      link.setAttribute('aria-current', 'page');
    }));
    const token = new URLSearchParams(window.location.hash.slice(1)).get('track');
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      await loadTracking(token);
      return;
    }
    await loadMenu();
  } catch (error) {
    showMessage(error.message || 'Online ordering is temporarily unavailable.');
    $('menuCount').textContent = 'Menu unavailable';
    $('featuredGrid').innerHTML = '<div class="featured-loading">The burger lineup could not be loaded.</div>';
    $('menuGrid').innerHTML = '<button class="secondary menu-retry" type="button">Try loading the menu again</button>';
    $('menuGrid').querySelector('button').addEventListener('click', async () => {
      try { await loadMenu(); } catch (retryError) { showMessage(retryError.message || 'The menu could not be loaded.'); }
    });
  }
}

initialize();
