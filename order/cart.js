const $ = id => document.getElementById(id);
const cartStorageKey = 'havens-online-cart';
const money = value => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let supabase;
let products = [];
let cart = [];

function available(product) { return product?.is_available !== false && product?.available !== false && product?.active !== false; }
function customerProductName(name) { const match = String(name || '').match(/^B\d\s*-\s*(.+?)\s*-\s*(Single|B1T1)$/i); return match ? `${match[1]} · ${match[2].toUpperCase() === 'B1T1' ? 'B1T1 · 2 burgers' : 'Single'}` : String(name || 'Menu item'); }
function readCart() { try { const value = JSON.parse(localStorage.getItem(cartStorageKey) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
function saveCart() { localStorage.setItem(cartStorageKey, JSON.stringify(cart)); }
function normalizeCart() {
  const merged = new Map();
  cart.forEach(item => {
    if (!item?.productId || !Number(item.quantity) || Number(item.quantity) <= 0) return;
    const quantity = Math.min(20, Number(item.quantity));
    merged.set(item.productId, Math.min(20, (merged.get(item.productId) || 0) + quantity));
  });
  cart = [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}
function showMessage(message) { $('cartMessage').textContent = message; $('cartMessage').classList.remove('hidden'); }
function render() {
  const items = cart.map(item => ({ ...item, product: products.find(product => product.id === item.productId) })).filter(item => item.product && available(item.product) && item.quantity > 0);
  cart = items.map(({ product, productId, quantity }) => ({ productId, quantity: Math.min(20, quantity) }));
  saveCart();
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = items.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0);
  $('cartSubtotal').textContent = money(subtotal); $('cartTotal').textContent = money(subtotal); $('checkoutButton').classList.toggle('disabled', !count); $('checkoutButton').setAttribute('aria-disabled', String(!count));
  if (!items.length) { $('cartItems').innerHTML = '<div class="flow-empty"><span>＋</span><b>Your basket is empty.</b><small>Add something delicious from the menu first.</small></div>'; return; }
  $('cartItems').innerHTML = items.map(item => `<article class="flow-cart-line"><div><b>${escapeHtml(customerProductName(item.product.name))}</b><small>${money(item.product.price)} each</small></div><div class="quantity-control"><button type="button" data-id="${escapeHtml(item.productId)}" data-change="-1" aria-label="Remove one ${escapeHtml(item.product.name)}">−</button><span>${item.quantity}</span><button type="button" data-id="${escapeHtml(item.productId)}" data-change="1" aria-label="Add one ${escapeHtml(item.product.name)}" ${item.quantity >= 20 ? 'disabled' : ''}>+</button></div><strong>${money(Number(item.product.price) * item.quantity)}</strong><button type="button" class="flow-cart-remove" data-remove="${escapeHtml(item.productId)}">Remove</button></article>`).join('');
  $('cartItems').querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => { const item = cart.find(entry => entry.productId === button.dataset.id); if (!item) return; item.quantity += Number(button.dataset.change); if (item.quantity <= 0) cart = cart.filter(entry => entry !== item); saveCart(); render(); }));
  $('cartItems').querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { cart = cart.filter(item => item.productId !== button.dataset.remove); saveCart(); render(); }));
}
async function init() {
  try {
    const config = window.HAVENS_SUPABASE_CONFIG; if (!window.supabase?.createClient || !config?.url || !config?.publishableKey) throw new Error('Online ordering is temporarily unavailable.');
    supabase = window.supabase.createClient(config.url, config.publishableKey); cart = readCart();
    normalizeCart();
    const { data, error } = await supabase.rpc('get_public_order_menu'); if (error) throw new Error(error.message); products = Array.isArray(data?.products) ? data.products : []; render();
  } catch (error) { showMessage(error.message || 'Your basket could not be loaded.'); }
}
$('checkoutButton').addEventListener('click', event => { if (!cart.length) { event.preventDefault(); showMessage('Add at least one item before checking out.'); } });
init();
