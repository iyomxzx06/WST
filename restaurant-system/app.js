const CONFIG_KEY='havens_system_supabase';
const ROLE_LABELS={owner_admin:'Owner / Admin',manager:'Manager',cashier:'Cashier',kitchen:'Kitchen'};
const NAV_ITEMS=[
 {id:'overview',label:'Overview',icon:'⌂',roles:['owner_admin','manager']},
 {id:'pos',label:'POS',icon:'▣',roles:['owner_admin','manager','cashier']},
 {id:'online-orders',label:'Online orders',icon:'↗',roles:['owner_admin','manager','cashier']},
 {id:'inventory',label:'Inventory',icon:'▤',roles:['owner_admin','manager','cashier','kitchen']},
 {id:'purchasing',label:'Suppliers & purchasing',icon:'⇧',roles:['owner_admin','manager']},
 {id:'kitchen',label:'Kitchen display',icon:'◷',roles:['owner_admin','manager','kitchen','cashier']},
 {id:'staff',label:'Staff & access',icon:'♙',roles:['owner_admin']},
 {id:'expenses',label:'Expenses',icon:'₱',roles:['owner_admin','manager']},
 {id:'reports',label:'Reports',icon:'▥',roles:['owner_admin','manager']},
 {id:'cash-closing',label:'Cash closing',icon:'▣',roles:['owner_admin','manager','cashier']},
 {id:'audit',label:'Audit log',icon:'≡',roles:['owner_admin','manager']}
];
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const peso=value=>'₱'+Number(value||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
function manilaDateParts(date=new Date()){
 const parts=new Intl.DateTimeFormat('en-CA',{
  timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
 }).formatToParts(date);
 return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}
function manilaDateString(date=new Date()){
 const parts=manilaDateParts(date);
 return `${parts.year}-${parts.month}-${parts.day}`;
}
function manilaMidnightUtc(dateString){
 return new Date(`${dateString}T00:00:00+08:00`).toISOString();
}
function shiftDateString(dateString,days){
 const [year,month,day]=dateString.split('-').map(Number);
 const date=new Date(Date.UTC(year,month-1,day+days));
 return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}
let client=null,clientConfig=null,profile=null,activePage='overview',cart=new Map(),products=[],ingredients=[],suppliers=[],realtimeChannel=null,realtimeTimer=0,pageLoadToken=0,queuedPage='';
let checkoutAttempt={signature:'',key:''},lastReportData=null;
let catalogAutoImportInProgress=false;
const authCallbackParams=new URLSearchParams(window.location.hash.slice(1));
const authQueryParams=new URLSearchParams(window.location.search);
const authCallbackType=authCallbackParams.get('type')||authQueryParams.get('type');
const authCallbackError=authCallbackParams.get('error_description')||authQueryParams.get('error_description');
const authCallbackErrorCode=authCallbackParams.get('error_code')||authQueryParams.get('error_code');
const needsPasswordSetup=['invite','signup','recovery'].includes(authCallbackType);

function showMessage(id,message,isError=true){
 const node=$(id);if(!node)return;
 node.textContent=message;node.classList.toggle('error',isError);node.classList.toggle('ok',!isError);
}
function appMessage(message,isError=true){
 const node=$('appMessage');
 node.textContent=message;node.classList.remove('hidden','error','ok');
 node.classList.add(isError?'error':'ok');
 window.clearTimeout(appMessage.timer);
 appMessage.timer=window.setTimeout(()=>node.classList.add('hidden'),6500);
}
function loadConfig(){
 const configured=window.HAVENS_SUPABASE_CONFIG||{};
 if(configured.url&&configured.publishableKey)return {url:configured.url,key:configured.publishableKey};
 try{return JSON.parse(localStorage.getItem(CONFIG_KEY)||'{}');}
 catch{return {};}
}
function dbError(error){
 const message=error?.message||'The database request failed.';
 if(error?.code==='PGRST202'&&message.includes('list_readonly_inventory'))
  throw new Error('Inventory access is not configured yet. Run migrations/014_restore_readonly_inventory.sql in Supabase, then refresh.');
 throw new Error(message);
}
function clearAuthCallback(){
 const url=new URL(window.location.href);
 ['code','type','error','error_code','error_description'].forEach(key=>url.searchParams.delete(key));
 url.hash='';
 window.history.replaceState(null,'',url.pathname+url.search);
}
function showPasswordSetup(message=''){
 $('loginScreen').classList.add('hidden');
 $('bootstrapScreen').classList.add('hidden');
 $('appScreen').classList.add('hidden');
 $('passwordSetupScreen').classList.remove('hidden');
 showMessage('passwordSetupMessage',message,false);
}
async function getProfile(userId){
 const {data,error}=await client.from('staff_profiles')
  .select('user_id,business_id,branch_id,display_name,role,active')
  .eq('user_id',userId).maybeSingle();
 if(error)dbError(error);
 return data;
}
function signedIn(){
 $('loginScreen').classList.add('hidden');
 $('bootstrapScreen').classList.add('hidden');
 $('appScreen').classList.remove('hidden');
 $('staffLabel').textContent=profile.display_name;
 $('roleBadge').textContent=ROLE_LABELS[profile.role]||profile.role;
 $('branchLabel').textContent='Single branch · '+profile.branch_id.slice(0,8);
 buildNavigation();
 closeMobileNavigation();
 subscribeToBranchChanges();
 openPage(activePage);
}
function buildNavigation(){
 $('mainNav').innerHTML=NAV_ITEMS.filter(item=>item.roles.includes(profile.role)).map(item=>
  `<button class="nav-button ${item.id===activePage?'active':''}" data-page="${item.id}" type="button" aria-current="${item.id===activePage?'page':'false'}"><span class="nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span></button>`
 ).join('');
 $('mainNav').querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{
  closeMobileNavigation();openPage(button.dataset.page);
 }));
}
function closeMobileNavigation(){
 const restoreFocus=window.matchMedia('(max-width: 980px)').matches&&$('sidebar').contains(document.activeElement);
 $('sidebar').classList.remove('open');
 $('sidebarBackdrop').classList.remove('visible');
 syncMobileNavigation();
 if(restoreFocus)$('menuToggle').focus();
}
function syncMobileNavigation(){
 const isMobile=window.matchMedia('(max-width: 980px)').matches;
 const isOpen=isMobile&&$('sidebar').classList.contains('open');
 if(!isMobile){
  $('sidebar').classList.remove('open');
  $('sidebarBackdrop').classList.remove('visible');
 }
 $('sidebar').inert=isMobile&&!isOpen;
 $('sidebar').setAttribute('aria-hidden',String(isMobile&&!isOpen));
 $('menuToggle').setAttribute('aria-expanded',String(isOpen));
 $('menuToggle').setAttribute('aria-label',isOpen?'Close menu':'Open menu');
}
function toggleMobileNavigation(){
 const isOpen=$('sidebar').classList.toggle('open');
 $('sidebarBackdrop').classList.toggle('visible',isOpen);
 syncMobileNavigation();
 if(isOpen)$('mainNav').querySelector('.nav-button')?.focus();
}
async function resolveSignedInUser(user){
 const staff=await getProfile(user.id);
 if(!staff){
  $('loginScreen').classList.add('hidden');
  $('bootstrapScreen').classList.remove('hidden');
  return;
 }
 if(!staff.active){
  await client.auth.signOut();
  throw new Error('This staff account is inactive. Ask the Owner/Admin for help.');
 }
 profile=staff;
 signedIn();
}
async function onLogin(event){
 event.preventDefault();
 showMessage('loginMessage','');
 const {url,key}=loadConfig();
 const email=$('email').value.trim(),password=$('password').value;
 if(!window.supabase?.createClient){showMessage('loginMessage','Supabase client could not load. Check your connection and refresh.');return;}
 if(!url||!key){showMessage('loginMessage','Set the Supabase URL and publishable key in WST/supabase-config.js first.');return;}
 localStorage.setItem(CONFIG_KEY,JSON.stringify({url,key}));
 const button=$('loginForm').querySelector('button[type="submit"]');
 button.disabled=true;
 try{
  if(!client||clientConfig?.url!==url||clientConfig?.key!==key){
   if(client){
    const {error:signOutError}=await client.auth.signOut();
    if(signOutError)dbError(signOutError);
   }
   client=window.supabase.createClient(url,key);clientConfig={url,key};
  }
  const {data,error}=await client.auth.signInWithPassword({email,password});
  if(error)dbError(error);
  $('password').value='';
  await resolveSignedInUser(data.user);
 }catch(error){showMessage('loginMessage',error.message||'Sign-in failed.');}
 finally{button.disabled=false;}
}
async function onPasswordSetup(event){
 event.preventDefault();
 showMessage('passwordSetupMessage','');
 const password=$('newPassword').value;
 if(password.length<8){showMessage('passwordSetupMessage','Use a password with at least 8 characters.');return;}
 if(password!==$('confirmPassword').value){showMessage('passwordSetupMessage','The passwords do not match.');return;}
 const button=$('passwordSetupForm').querySelector('button[type="submit"]');
 button.disabled=true;
 try{
  const {data,error}=await client.auth.updateUser({password});
  if(error)dbError(error);
  if(!data.user)throw new Error('Password was saved, but the account could not be loaded. Sign in with your new password.');
  clearAuthCallback();
  $('newPassword').value='';$('confirmPassword').value='';
  await resolveSignedInUser(data.user);
 }catch(error){showMessage('passwordSetupMessage',error.message||'Could not save your password.');}
 finally{button.disabled=false;}
}
async function onForgotPassword(){
 showMessage('loginMessage','');
 if(!client){showMessage('loginMessage','Supabase is not configured. Refresh the page and check the app setup.');return;}
 const email=$('email').value.trim();
 if(!email){showMessage('loginMessage','Enter your staff email first.');$('email').focus();return;}
 const button=$('forgotPasswordButton');
 button.disabled=true;
 try{
  const redirectTo=new URL('./',window.location.href).toString();
  const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo});
  if(error)dbError(error);
  showMessage('loginMessage','If an account exists for that email, a password reset link will be sent.',false);
 }catch(error){showMessage('loginMessage',error.message||'Could not send a password reset link.');}
 finally{button.disabled=false;}
}
async function onBootstrap(event){
 event.preventDefault();showMessage('bootstrapMessage','');
 const button=$('bootstrapForm').querySelector('button[type="submit"]');
 button.disabled=true;
 try{
  const {data:{user},error:authError}=await client.auth.getUser();
  if(authError||!user)throw new Error('Your sign-in expired. Please sign in again.');
  const {error}=await client.rpc('bootstrap_business',{
   p_business_name:$('businessName').value.trim(),
   p_branch_name:$('branchName').value.trim(),
   p_display_name:$('ownerName').value.trim()
  });
  if(error)dbError(error);
  profile=await getProfile(user.id);
  if(!profile)throw new Error('Business setup succeeded, but your staff profile could not be loaded. Sign out and sign in again.');
  signedIn();
 }catch(error){showMessage('bootstrapMessage',error.message||'Setup failed.');}
 finally{button.disabled=false;}
}
async function signOut(){
 if(client){
  const {error}=await client.auth.signOut();
  if(error){appMessage('Sign-out failed: '+error.message);return;}
 }
 if(realtimeChannel){await client.removeChannel(realtimeChannel);realtimeChannel=null;}
 window.clearTimeout(realtimeTimer);
 profile=null;cart.clear();checkoutAttempt={signature:'',key:''};
 window.location.assign(new URL('../order/',window.location.href).toString());
}
function subscribeToBranchChanges(){
 if(realtimeChannel)client.removeChannel(realtimeChannel);
 realtimeChannel=client.channel('branch-updates-'+profile.branch_id)
  .on('postgres_changes',{event:'*',schema:'public',table:'sales_orders',filter:'branch_id=eq.'+profile.branch_id},refreshActiveModule)
  .on('postgres_changes',{event:'*',schema:'public',table:'online_orders',filter:'branch_id=eq.'+profile.branch_id},refreshActiveModule)
  .on('postgres_changes',{event:'*',schema:'public',table:'ingredients',filter:'branch_id=eq.'+profile.branch_id},refreshActiveModule)
  .on('postgres_changes',{event:'*',schema:'public',table:'inventory_movements',filter:'branch_id=eq.'+profile.branch_id},refreshActiveModule)
  .subscribe(status=>{
   if(status==='CHANNEL_ERROR'||status==='TIMED_OUT')appMessage('Live updates are temporarily unavailable. Refresh the page to sync changes.');
  });
}
function refreshActiveModule(){
 window.clearTimeout(realtimeTimer);
 realtimeTimer=window.setTimeout(()=>{
  if(profile&&['overview','pos','online-orders','inventory','kitchen','reports'].includes(activePage))openPage(activePage);
 },250);
}
function openQueuedPage(currentPage){
 const nextPage=queuedPage;queuedPage='';
 if(nextPage&&nextPage!==currentPage)openPage(nextPage);
}
function openPage(page){
 if($('pageContent')?.getAttribute('aria-busy')==='true'){
  queuedPage=page;
  return;
 }
 const item=NAV_ITEMS.find(candidate=>candidate.id===page&&candidate.roles.includes(profile?.role));
 if(!item){
  const firstAllowedPage=NAV_ITEMS.find(candidate=>candidate.roles.includes(profile?.role));
  if(!firstAllowedPage){appMessage('No modules are available for this staff role. Ask the Owner/Admin for help.');return;}
  page=firstAllowedPage.id;
 }
 activePage=page;buildNavigation();
 $('pageTitle').textContent=NAV_ITEMS.find(x=>x.id===page)?.label||'Overview';
  const renderers={overview:renderOverview,pos:renderPos,'online-orders':renderOnlineOrders,inventory:renderInventory,purchasing:renderPurchasing,kitchen:renderKitchen,staff:renderStaff,expenses:renderExpenses,reports:renderReports,'cash-closing':renderCashClosing,audit:renderAudit};
 const content=$('pageContent'),loadToken=++pageLoadToken;
 content.setAttribute('aria-busy','true');
 content.innerHTML='<div class="loading-state" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>Loading your workspace…</span></div>';
 Promise.resolve().then(()=>renderers[page]()).then(()=>{
  if(loadToken===pageLoadToken)content.setAttribute('aria-busy','false');
  if(loadToken===pageLoadToken)openQueuedPage(page);
 }).catch(error=>{
  if(loadToken!==pageLoadToken)return;
  content.setAttribute('aria-busy','false');
  content.innerHTML=`<div class="load-error" role="alert"><b>This section could not be loaded.</b><span>${esc(error.message||'Please try again.')}</span><button class="secondary" id="retryModule" type="button">Try again</button></div>`;
  $('retryModule').addEventListener('click',()=>openPage(page));
  appMessage(error.message||'Could not load this module.');
  openQueuedPage(page);
 });
}
async function fetchRows(table,columns='*',order='created_at'){
 const {data,error}=await client.from(table).select(columns).order(order,{ascending:false});
 if(error)dbError(error);
 return data||[];
}
async function getOperationalReport(startDate,endDate){
 const {data,error}=await client.rpc('get_operational_report',{
  p_start:manilaMidnightUtc(startDate),p_end:manilaMidnightUtc(endDate),
  p_start_date:startDate,p_end_date:endDate
 });
 if(error)dbError(error);
 return data;
}
async function renderOverview(){
 const today=manilaDateString();
 const tomorrow=shiftDateString(today,1);
 const [report,stock]=await Promise.all([
  getOperationalReport(today,tomorrow),
  client.from('ingredients').select('id,name,unit,stock_quantity,reorder_level').eq('active',true)
 ]);
 if(stock.error)dbError(stock.error);
 const low=(stock.data||[]).filter(x=>Number(x.stock_quantity)<=Number(x.reorder_level));
 const orders=report.orders,payments=report.payments,outstanding=report.outstanding;
 const quickActions=[
  {page:'pos',icon:'＋',title:'Start a sale',description:'Open the point of sale'},
  {page:'online-orders',icon:'↗',title:'Online orders',description:'Review and update incoming orders'},
  {page:'inventory',icon:'▤',title:'Check inventory',description:'Review stock and reorder alerts'},
  {page:'expenses',icon:'₱',title:'Record expense',description:'Add an operating expense'},
  {page:'reports',icon:'▥',title:'View reports',description:'Explore sales and payment totals'}
 ].filter(action=>NAV_ITEMS.some(item=>item.id===action.page&&item.roles.includes(profile.role)));
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">MANILA · ${today}</span><h2>Today's overview</h2><p>Quick view of sales, stock, kitchen activity, and spending.</p></div><button id="refreshOverview" class="secondary refresh-button" type="button"><span aria-hidden="true">↻</span> Refresh</button></div>
  <section class="panel dashboard-quick-panel" aria-labelledby="quickActionsTitle"><div class="section-heading"><div><h2 id="quickActionsTitle">Quick actions</h2><p>Jump straight to a common task.</p></div></div><div class="dashboard-quick-actions">${quickActions.map(action=>`<button class="dashboard-quick-action" type="button" data-dashboard-page="${action.page}"><span class="dashboard-quick-icon" aria-hidden="true">${action.icon}</span><span><b>${action.title}</b><small>${action.description}</small></span><span class="dashboard-quick-arrow" aria-hidden="true">›</span></button>`).join('')}</div></section>
  <div class="grid stats">
   <div class="stat stat-sales"><div class="stat-top"><div class="stat-label">Sales recorded today</div><span class="stat-icon">₱</span></div><div class="stat-value">${peso(orders.recorded_order_value)}</div><p class="stat-caption">${Number(orders.order_count)} non-void orders</p></div>
   <div class="stat stat-payment"><div class="stat-top"><div class="stat-label">Payments collected</div><span class="stat-icon">✓</span></div><div class="stat-value">${peso(payments.net_collected)}</div><p class="stat-caption">Net receipts after refunds</p></div>
   <div class="stat stat-orders"><div class="stat-top"><div class="stat-label">Unpaid online · current</div><span class="stat-icon">…</span></div><div class="stat-value">${peso(outstanding.amount)}</div><p class="stat-caption">${Number(outstanding.unpaid_order_count)} open orders · all dates</p></div>
   <div class="stat stat-orders"><div class="stat-top"><div class="stat-label">Orders today</div><span class="stat-icon">#</span></div><div class="stat-value">${Number(orders.order_count)}</div><p class="stat-caption">Non-void orders</p></div>
   <div class="stat ${low.length?'stat-alert':'stat-stock'}"><div class="stat-top"><div class="stat-label">Low-stock items</div><span class="stat-icon">!</span></div><div class="stat-value">${low.length}</div><p class="stat-caption">${low.length?'Needs restocking':'Stock levels look good'}</p></div>
   <div class="stat stat-expenses"><div class="stat-top"><div class="stat-label">Expenses today</div><span class="stat-icon">−</span></div><div class="stat-value">${peso(report.expenses.total)}</div><p class="stat-caption">Recorded operating expenses</p></div>
  </div>
  <section class="panel module-panel"><div class="section-heading"><div><h2>Stock alerts</h2><p>Ingredients at or below their reorder level.</p></div><span class="pill ${low.length?'orange':'green'}">${low.length} ${low.length===1?'item':'items'}</span></div>${low.length?`<div class="table-wrap"><table class="dashboard-stock-table"><thead><tr><th>Ingredient</th><th>On hand</th><th>Reorder at</th></tr></thead><tbody>${low.map(row=>`<tr><td><b>${esc(ingredientLabel(row.name))}</b></td><td><span class="stock-quantity-low">${Number(row.stock_quantity)} ${esc(row.unit)}</span></td><td>${Number(row.reorder_level)} ${esc(row.unit)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty empty-success"><span class="empty-success-mark">✓</span><b>All stocked up</b><span>No ingredients are below their reorder level.</span></div>'}<button class="secondary dashboard-inventory-link" type="button" data-dashboard-page="inventory">Open inventory</button></section>`;
 $('refreshOverview').addEventListener('click',()=>openPage('overview'));
 $('pageContent').querySelectorAll('[data-dashboard-page]').forEach(button=>button.addEventListener('click',()=>openPage(button.dataset.dashboardPage)));
}
async function loadPosCatalog(){
 const {data,error}=await client.from('products').select('id,name,price').eq('active',true).order('name');
 if(error)dbError(error);products=data||[];
}
function burgerOption(product){
 const labeled=product.name.match(/^B([1-4])\s*-\s*.+?\s*-\s*(Single|B1T1)$/i);
 if(labeled)return {number:labeled[1],variant:labeled[2].toUpperCase()==='B1T1'?'B1T1':'Single'};
 const defaultName=product.name.match(/^(Classic|Cheese|Deluxe|Double Cheese) Burger\s*-\s*(Single|B1T1)$/i);
 if(!defaultName)return null;
 return {
  number:{classic:'1',cheese:'2',deluxe:'3','double cheese':'4'}[defaultName[1].toLowerCase()],
  variant:defaultName[2].toUpperCase()==='B1T1'?'B1T1':'Single'
 };
}
function addProductToCart(product){
 cart.set(product.id,{product,quantity:(cart.get(product.id)?.quantity||0)+1});
 drawCart();
}
function chooseBurgerVariant(number,options,addOns){
 $('dialogTitle').textContent=`B${number} · Choose size`;
 $('dialogContent').innerHTML=`<form id="burgerPickerForm"><div class="variant-options">${options.map((product,index)=>`<label class="variant-option"><span class="variant-choice"><input class="variant-radio" type="radio" name="burgerVariant" value="${product.id}" ${index===0?'checked':''}><span>${esc(burgerOption(product).variant)}</span></span><b>${peso(product.price)}</b></label>`).join('')}</div>${addOns.length?`<h3 class="addon-heading">Add-ons <span>(optional · 1 stock unit each)</span></h3><div class="addon-options">${addOns.map(product=>`<label class="addon-option"><span><input type="checkbox" name="burgerAddOn" value="${product.id}">${esc(product.name)}</span><b>${peso(product.price)}</b></label>`).join('')}</div>`:''}<button class="primary wide" type="submit">Add to order</button></form>`;
 const dialog=$('dialog');
 $('burgerPickerForm').addEventListener('submit',event=>{
  event.preventDefault();
  const selectedId=$('burgerPickerForm').querySelector('[name="burgerVariant"]:checked')?.value;
  const selected=options.find(item=>item.id===selectedId);
  if(selected)addProductToCart(selected);
  $('burgerPickerForm').querySelectorAll('[name="burgerAddOn"]:checked').forEach(input=>{
   const addOn=addOns.find(item=>item.id===input.value);
   if(addOn)addProductToCart(addOn);
  });
  dialog.close();
 });
 dialog.showModal();
}
function burgerLabel(number){
 return {1:'Classic Burger',2:'Cheese Burger',3:'Deluxe Burger',4:'Double Cheese Burger'}[number];
}
async function renderOnlineOrders(){
 const columns='id,public_reference,customer_name,customer_phone,fulfillment_type,delivery_address,delivery_landmark,delivery_fee,payment_method,subtotal,total,notes,status,sales_order_id,created_at,online_order_items(id,product_name,quantity,unit_price)';
 const [pendingResult,recentResult]=await Promise.all([
  client.from('online_orders').select(columns).eq('status','pending').order('created_at',{ascending:true}),
  client.from('online_orders').select(columns).neq('status','pending').order('created_at',{ascending:false}).limit(20)
 ]);
 if(pendingResult.error)dbError(pendingResult.error);
 if(recentResult.error)dbError(recentResult.error);
 const pending=pendingResult.data||[],recent=recentResult.data||[];
 const saleIds=[...new Set(recent.map(order=>order.sales_order_id).filter(Boolean))];
 let paymentsByOrder=new Map(),refundsByPayment=new Map();
 if(saleIds.length){
  const {data,error}=await client.from('payments').select('id,order_id,payment_method,amount').in('order_id',saleIds);
  if(error)dbError(error);
  paymentsByOrder=new Map((data||[]).map(payment=>[payment.order_id,payment]));
  if(['owner_admin','manager'].includes(profile.role)&&data?.length){
   const {data:refunds,error:refundError}=await client.from('payment_refunds')
    .select('payment_id,amount').in('payment_id',data.map(payment=>payment.id));
   if(refundError)dbError(refundError);
   for(const refund of refunds||[]){
    refundsByPayment.set(refund.payment_id,(refundsByPayment.get(refund.payment_id)||0)+Number(refund.amount));
   }
  }
 }
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">CUSTOMER ORDERS</span><h2>Online orders</h2><p>Review incoming orders, confirm with the customer, then send accepted orders to the kitchen.</p></div><button id="refreshOnlineOrders" class="secondary refresh-button" type="button">↻ Refresh</button></div>
  <div class="online-orders-note"><span class="online-orders-note-icon">i</span><span>Delivery has a flat <b>₱30 fee</b> and is subject to staff confirming the service area. A preferred method is not payment confirmation. Record payment only after cash is received or a GCash/card transaction is verified.</span></div>
  <section class="panel module-panel"><div class="section-heading"><div><h2>Needs your confirmation</h2><p>Accepting an order checks stock, records the sale, and sends it to Kitchen display. Payment remains outstanding until recorded.</p></div><span class="pill ${pending.length?'orange':'green'}">${pending.length} waiting</span></div>${pending.length?`<div class="online-order-list">${pending.map(order=>{const payment=paymentsByOrder.get(order.sales_order_id);return onlineOrderCard(order,payment,payment?refundsByPayment.get(payment.id)||0:0);}).join('')}</div>`:'<div class="empty empty-success"><span class="empty-success-mark">✓</span><b>All caught up</b><span>New customer orders will appear here.</span></div>'}</section>
  ${recent.length?`<section class="panel module-panel"><div class="section-heading"><div><h2>Recent online orders</h2><p>Latest 20 processed requests.</p></div></div><div class="online-order-list">${recent.map(order=>{const payment=paymentsByOrder.get(order.sales_order_id);return onlineOrderCard(order,payment,payment?refundsByPayment.get(payment.id)||0:0);}).join('')}</div></section>`:''}`;
 $('refreshOnlineOrders').addEventListener('click',()=>openPage('online-orders'));
 $('pageContent').querySelectorAll('[data-accept-online]').forEach(button=>button.addEventListener('click',()=>acceptOnlineOrder(button)));
 $('pageContent').querySelectorAll('[data-reject-online]').forEach(button=>button.addEventListener('click',()=>rejectOnlineOrder(button)));
 $('pageContent').querySelectorAll('[data-record-online-payment]').forEach(form=>{
  form.addEventListener('submit',recordOnlineOrderPayment);
  const method=form.querySelector('[name="payment_method"]');
  method.addEventListener('change',()=>{
   const cashFields=form.querySelector('[data-cash-fields]');
   cashFields.hidden=method.value!=='cash';
   cashFields.querySelector('[name="amount_tendered"]').required=method.value==='cash';
   form.querySelector('[data-reference-fields]').hidden=method.value==='cash';
  });
  method.dispatchEvent(new Event('change'));
 });
}
function onlineOrderCard(order,payment,refunded=0){
 const date=new Date(order.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'});
 const statusLabel={pending:'Needs confirmation',accepted:'Accepted',rejected:'Declined',new:'In kitchen',preparing:'Preparing',ready:'Ready',served:'Completed',void:'Voided'}[order.status]||order.status;
 const isPending=order.status==='pending';
 const paid=Boolean(payment);
 const fullyRefunded=paid&&Number(payment.amount)>0&&refunded>=Number(payment.amount);
 const partiallyRefunded=paid&&refunded>0&&!fullyRefunded;
 const paymentLabel=paid
  ?fullyRefunded?`Fully refunded · ${esc(payment.payment_method)}`:partiallyRefunded?`Partially refunded · ${esc(payment.payment_method)}`:`Payment received · ${esc(payment.payment_method)}`
  :`Preferred · ${esc(order.payment_method)}${order.status==='accepted'?' · unpaid':' · not collected'}`;
 return `<article class="online-order-card ${isPending?'online-order-pending':''}">
  <div class="online-order-top"><div><span class="online-order-reference">${esc(order.public_reference)}</span><span class="pill ${isPending?'orange':order.status==='rejected'?'red':'green'}">${esc(statusLabel)}</span></div><time>${esc(date)}</time></div>
  <div class="online-order-customer"><b>${esc(order.customer_name)}</b><a href="tel:${esc(order.customer_phone)}">${esc(order.customer_phone)}</a></div>
  <div class="online-order-tags"><span class="pill blue">${order.fulfillment_type==='delivery'?'Delivery':'Pickup'}</span><span class="pill">${paymentLabel}</span></div>
  <ul class="online-order-items">${(order.online_order_items||[]).map(item=>`<li><span><b>${Number(item.quantity)}×</b> ${esc(item.product_name)}</span><b>${peso(Number(item.quantity)*Number(item.unit_price))}</b></li>`).join('')}</ul>
  ${order.fulfillment_type==='delivery'?`<div class="online-order-address"><b>Delivery address</b><span>${esc(order.delivery_address)}</span>${order.delivery_landmark?`<small>Landmark: ${esc(order.delivery_landmark)}</small>`:''}</div>`:''}
  ${order.notes?`<div class="ticket-note"><b>Customer note:</b> ${esc(order.notes)}</div>`:''}
  <div class="online-order-total"><span>${order.delivery_fee?`Subtotal ${peso(order.subtotal)} + delivery ${peso(order.delivery_fee)}`:'Order total'}</span><b>${peso(order.total)}</b></div>
  ${isPending?`<div class="online-order-actions"><button class="primary" type="button" data-accept-online="${esc(order.id)}">Accept & send to kitchen</button><button class="secondary" type="button" data-reject-online="${esc(order.id)}">Decline</button></div>`:''}
  ${order.status==='accepted'&&!paid&&order.sales_order_id?`<details class="online-payment-record"><summary>Record payment received</summary><form class="form-grid" data-record-online-payment="${esc(order.sales_order_id)}" data-order-total="${Number(order.total)}"><div><label>Actual method received</label><select name="payment_method"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="card">Card</option></select></div><div data-reference-fields hidden><label>Reference (optional)</label><input name="external_reference" maxlength="120"></div><div class="full" data-cash-fields><label>Cash received (₱)</label><input name="amount_tendered" type="number" min="${Number(order.total).toFixed(2)}" step="0.01" value="${Number(order.total).toFixed(2)}" required></div><div class="full"><button class="primary wide" type="submit">Confirm payment received</button></div></form></details>`:''}
 </article>`;
}
async function recordOnlineOrderPayment(event){
 event.preventDefault();
 const form=event.currentTarget,values=Object.fromEntries(new FormData(form));
 const paymentMethod=values.payment_method;
 const amountTendered=paymentMethod==='cash'?Number(values.amount_tendered):null;
 if(paymentMethod==='cash'&&(!Number.isFinite(amountTendered)||amountTendered<Number(form.dataset.orderTotal))){
  appMessage('Cash received must be at least the order total.');return;
 }
 const button=form.querySelector('button[type="submit"]');button.disabled=true;
 try{
  const {error}=await client.rpc('record_online_order_payment',{
   p_order_id:form.dataset.recordOnlinePayment,p_payment_method:paymentMethod,
   p_amount_tendered:amountTendered,
   p_external_reference:paymentMethod==='cash'?null:values.external_reference.trim()||null
  });
  if(error)dbError(error);
  appMessage('Payment recorded as received.',false);openPage('online-orders');
 }catch(error){appMessage('Could not record payment: '+error.message);button.disabled=false;}
}
async function acceptOnlineOrder(button){
 const orderId=button.dataset.acceptOnline;
 if(!window.confirm('Accept this customer order? This checks and deducts stock, records the sale, and sends it to Kitchen display.'))return;
 button.disabled=true;
 try{
  const {error}=await client.rpc('accept_online_order',{p_order_id:orderId});
  if(error)dbError(error);
 }catch(error){appMessage('Could not accept this online order: '+error.message);button.disabled=false;return;}
 appMessage('Online order accepted and sent to Kitchen display.',false);
 openPage('online-orders');
}
async function rejectOnlineOrder(button){
 if(!window.confirm('Decline this online order? No stock will be deducted.'))return;
 button.disabled=true;
 try{
  const {error}=await client.rpc('reject_online_order',{p_order_id:button.dataset.rejectOnline});
  if(error)dbError(error);
 }catch(error){appMessage('Could not decline this online order: '+error.message);button.disabled=false;return;}
 appMessage('Online order declined.',false);
 openPage('online-orders');
}
async function renderPos(){
 await loadPosCatalog();
 const burgerGroups=new Map();
 const addOnNames=new Set(['onion','lettuce','tomato','sauce','slice cheese','bacon','beef patty']);
 const addOnProducts=products.filter(product=>addOnNames.has(product.name.trim().toLowerCase()));
 products.forEach(product=>{
  const option=burgerOption(product);
  if(!option)return;
  if(!burgerGroups.has(option.number))burgerGroups.set(option.number,[]);
  burgerGroups.get(option.number).push(product);
 });
 $('pageContent').innerHTML=`<div class="page-heading"><div><span class="inventory-item-label">FRESH OFF THE GRILL</span><h2>Make it a good one.</h2><p>Choose a burger, customize it, and send it straight to the kitchen.</p></div></div>
  <button id="menuPosterOpen" class="menu-poster-preview" type="button" aria-label="View the Havens Burger singles menu poster">
   <img src="./images/havens-singles-menu.png" alt="" loading="lazy">
   <span class="menu-poster-copy"><span class="inventory-item-label">THE HAVENS BURGER STATION</span><b>Singles menu</b><small>See the full menu artwork · Live prices are shown on the burger cards.</small></span>
   <span class="menu-poster-action" aria-hidden="true">View poster <span>↗</span></span>
  </button>
  <div class="grid pos-layout"><section class="panel pos-menu-panel"><div class="section-heading"><div><h2>Pick your favorite</h2><p>Choose a burger to see sizes and add-ons.</p></div><span class="pill">4 signatures</span></div><div class="grid pos-menu-grid">${[1,2,3,4].map(number=>{const options=burgerGroups.get(String(number))||[];const image=`./images/B${number}.jpg`;const startingPrice=options.length?Math.min(...options.map(option=>Number(option.price))):null;return `<button class="card product-button" data-burger="${number}" type="button"${options.length?'':' disabled'}><span class="product-photo-wrap"><img class="product-photo" src="${image}" alt="B${number} ${burgerLabel(number)}" loading="lazy"><span class="product-code">B${number}</span></span><span class="product-name">${burgerLabel(number)}</span><span class="product-card-footer"><span class="product-prompt">${options.length?(options.length>1?'Single · B1T1':'Signature burger'):'Product not set up'}</span>${startingPrice===null?'':`<span class="product-price">from ${peso(startingPrice)}</span>`}</span></button>`;}).join('')}</div></section>
  <section class="panel pos-cart-panel"><div class="section-heading"><div><h2>Your order</h2><p>Review items before checkout.</p></div><span id="cartCount" class="pill">0 items</span></div><div id="cartLines"></div><div class="checkout-fields"><label for="paymentMethod">Payment</label><select id="paymentMethod"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="card">Card</option></select><div id="paymentDetails"></div><label for="orderType">Order type</label><select id="orderType"><option value="dine_in">Dine-in</option><option value="takeout">Takeout</option></select><label for="orderNotes">Notes</label><textarea id="orderNotes" maxlength="500" placeholder="Optional kitchen notes"></textarea><button id="placeOrder" class="primary wide" type="button">Place order</button></div></section></div>
  <section class="panel"><h2>Recent orders</h2><div id="recentOrders" class="empty">Loading orders…</div></section>`;
 $('pageContent').querySelectorAll('.product-photo').forEach(image=>image.addEventListener('error',()=>{image.hidden=true;},{once:true}));
 const posMenuPanel=$('pageContent').querySelector('.pos-menu-panel');
 const posSearch=document.createElement('input');posSearch.id='posProductSearch';posSearch.type='search';posSearch.placeholder='Search burgers and add-ons…';posSearch.autocomplete='off';posSearch.setAttribute('aria-label','Search POS products');
 const posSearchLabel=document.createElement('label');posSearchLabel.htmlFor='posProductSearch';posSearchLabel.textContent='Find a product';posSearchLabel.className='visually-hidden';
 posMenuPanel.querySelector('.section-heading').after(posSearchLabel,posSearch);
 const posCategory=document.createElement('select');posCategory.id='posCategoryFilter';posCategory.setAttribute('aria-label','Filter POS products');posCategory.innerHTML='<option value="all">All burgers</option><option value="1">B1 Classic</option><option value="2">B2 Cheese</option><option value="3">B3 Deluxe</option><option value="4">B4 Double</option>';posMenuPanel.querySelector('.section-heading').after(posCategory);
 const filterPosProducts=()=>{const query=posSearch.value.trim().toLowerCase(),category=posCategory.value;$('pageContent').querySelectorAll('[data-burger]').forEach(button=>{button.hidden=(query&&!button.textContent.toLowerCase().includes(query))||(category!=='all'&&button.dataset.burger!==category);});};
 posSearch.addEventListener('input',filterPosProducts);posCategory.addEventListener('change',filterPosProducts);
 $('menuPosterOpen').addEventListener('click',showMenuPoster);
 $('pageContent').querySelectorAll('[data-burger]').forEach(button=>button.addEventListener('click',()=>{
  const number=button.dataset.burger;
  chooseBurgerVariant(number,burgerGroups.get(number)||[],addOnProducts);
 }));
 $('placeOrder').addEventListener('click',placeOrder);
 $('paymentMethod').addEventListener('change',updatePaymentDetails);
 updatePaymentDetails();
 drawCart();await renderRecentOrders();
}
function showMenuPoster(){
 $('dialogTitle').textContent='Havens Burger Station · Singles Menu';
 $('dialogContent').innerHTML='<div class="menu-poster-dialog"><img src="./images/havens-singles-menu.png" alt="Havens Burger Station singles menu poster"><p>Poster artwork only. Current POS prices are shown on the burger cards and confirmed in the order.</p></div>';
 const dialog=$('dialog');
 dialog.showModal();
 $('dialog').querySelector('.dialog-head button').focus();
}
function drawCart(){
 const target=$('cartLines');if(!target)return;
 const lines=[...cart.values()];
 const quantity=lines.reduce((sum,line)=>sum+line.quantity,0);
 const count=$('cartCount');if(count)count.textContent=`${quantity} ${quantity===1?'item':'items'}`;
 target.innerHTML=lines.length?`<div class="cart-items">${lines.map(({product,quantity})=>`<div class="cart-item"><div class="cart-item-info"><b>${esc(product.name)}</b><small>${peso(product.price)} each · Qty ${quantity}</small></div><div class="cart-item-total"><b>${peso(Number(product.price)*quantity)}</b><button class="icon-button remove-cart" data-remove="${product.id}" aria-label="Remove one ${esc(product.name)}">−</button></div></div>`).join('')}</div>
  <div class="cart-total"><span>Order total</span><b>${peso(lines.reduce((sum,line)=>sum+Number(line.product.price)*line.quantity,0))}</b></div>`:'<div class="empty cart-empty"><span class="cart-empty-icon">＋</span><b>Your order is empty</b><span>Choose a burger to get started.</span></div>';
 target.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>{
  const item=cart.get(button.dataset.remove);
  if(item?.quantity>1)item.quantity--;else cart.delete(button.dataset.remove);
  drawCart();
 }));
 target.querySelectorAll('.cart-item-total').forEach((item,index)=>{
  const line=lines[index];if(!line)return;
  const plus=document.createElement('button');plus.className='icon-button add-cart';plus.type='button';plus.textContent='+';plus.dataset.addCart=line.product.id;plus.setAttribute('aria-label',`Add another ${line.product.name}`);item.append(plus);
  plus.addEventListener('click',()=>{addProductToCart(line.product);drawCart();});
 });
 updatePaymentDetails();
}
function cartTotal(){
 return [...cart.values()].reduce((sum,line)=>sum+Number(line.product.price)*line.quantity,0);
}
function updatePaymentDetails(){
 const target=$('paymentDetails'),method=$('paymentMethod')?.value;
 if(!target||!method)return;
 if(method==='cash'){
  target.innerHTML=`<label for="cashTendered">Cash received (₱)</label><input id="cashTendered" type="number" min="${cartTotal().toFixed(2)}" step="0.01" value="${cartTotal().toFixed(2)}" required><p id="cashChange" class="hint">Change: ${peso(0)}</p>`;
  $('cashTendered').addEventListener('input',()=>{
   const tendered=Number($('cashTendered').value);
   $('cashChange').textContent='Change: '+peso(Math.max(0,tendered-cartTotal()));
  });
 }else{
  target.innerHTML=`<label for="paymentReference">${method==='gcash'?'GCash reference (optional)':'Card reference (optional)'}</label><input id="paymentReference" maxlength="120"><p class="hint">Verify that the payment was received before completing this sale.</p>`;
 }
}
async function placeOrder(){
 const button=$('placeOrder'),items=[...cart.values()].map(({product,quantity})=>({product_id:product.id,quantity}));
 if(!items.length){appMessage('Add at least one item first.');return;}
 const paymentMethod=$('paymentMethod').value;
 if(paymentMethod!=='cash'&&!window.confirm(`Confirm that the ${paymentMethod.toUpperCase()} payment has been received and verified before recording this sale?`))return;
 const amountTendered=paymentMethod==='cash'?Number($('cashTendered').value):null;
 if(paymentMethod==='cash'&&(!Number.isFinite(amountTendered)||amountTendered<cartTotal())){
  appMessage('Cash received must be at least the order total.');return;
 }
 const request={items,paymentMethod,orderType:$('orderType').value,notes:$('orderNotes').value.trim()||null,amountTendered,reference:$('paymentReference')?.value.trim()||null};
 const signature=JSON.stringify(request);
 if(checkoutAttempt.signature!==signature)checkoutAttempt={signature,key:crypto.randomUUID()};
 button.disabled=true;
 try{
  const {data,error}=await client.rpc('create_pos_order',{
   p_items:items,p_payment_method:paymentMethod,p_order_type:request.orderType,p_notes:request.notes,
   p_idempotency_key:checkoutAttempt.key,p_amount_tendered:amountTendered,p_external_reference:request.reference
  });
  if(error)dbError(error);
  cart.clear();checkoutAttempt={signature:'',key:''};appMessage('Order placed.',false);
  try{await renderPos();}catch(refreshError){appMessage('Order placed, but the POS screen could not refresh: '+refreshError.message);}
 }catch(error){appMessage('Order was not placed: '+error.message);}
 finally{if($('placeOrder'))$('placeOrder').disabled=false;}
}
async function renderRecentOrders(){
 const {data,error}=await client.from('sales_orders').select('id,order_number,status,total,payment_method,order_type,created_at,sales_order_items(product_name,quantity,unit_price)')
  .order('created_at',{ascending:false}).limit(8);
 if(error)dbError(error);
 const orders=data||[],orderIds=orders.map(order=>order.id);
 let paymentsByOrder=new Map(),refundsByPayment=new Map();
 if(orderIds.length){
  const {data:payments,error:paymentsError}=await client.from('payments')
   .select('id,order_id,payment_method,amount').in('order_id',orderIds);
  if(paymentsError)dbError(paymentsError);
  paymentsByOrder=new Map((payments||[]).map(payment=>[payment.order_id,payment]));
  if(['owner_admin','manager'].includes(profile.role)&&payments?.length){
   const {data:refunds,error:refundsError}=await client.from('payment_refunds')
    .select('payment_id,amount').in('payment_id',payments.map(payment=>payment.id));
   if(refundsError)dbError(refundsError);
   refundsByPayment=new Map();
   for(const refund of refunds||[]){
    refundsByPayment.set(refund.payment_id,(refundsByPayment.get(refund.payment_id)||0)+Number(refund.amount));
   }
  }
 }
 const target=$('recentOrders');if(!target)return;
 const canRefund=['owner_admin','manager'].includes(profile.role);
 target.className=orders.length?'table-wrap':'empty';
 target.innerHTML=orders.length?`<table><thead><tr><th>Order</th><th>Time</th><th>Status</th><th>Payment</th><th class="right">Total</th>${canRefund?'<th>Action</th>':''}</tr></thead><tbody>${orders.map(row=>{
  const payment=paymentsByOrder.get(row.id),refunded=payment?refundsByPayment.get(payment.id)||0:0;
  const refundable=payment?Math.max(0,Number(payment.amount)-refunded):0;
  const fullyRefunded=payment&&Number(payment.amount)>0&&refundable===0;
  return `<tr><td>#${row.order_number}</td><td>${new Date(row.created_at).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila'})}</td><td><span class="pill">${esc(row.status)}</span></td><td>${payment?`<span class="pill ${fullyRefunded?'orange':'green'}">${fullyRefunded?`Fully refunded · ${esc(payment.payment_method)}`:`Received · ${esc(payment.payment_method)}`}</span>${refunded?`<small class="subtext">Refunded ${peso(refunded)}</small>`:''}`:'<span class="pill">Not recorded</span>'}</td><td class="right">${peso(row.total)}</td>${canRefund?`<td>${refundable>0?`<button class="secondary actions-button" type="button" data-refund-order="${esc(row.id)}" data-refund-remaining="${refundable.toFixed(2)}">Refund</button>`:'—'}</td>`:''}</tr>`;
 }).join('')}</tbody></table>`:'No orders yet.';
 target.querySelectorAll('[data-refund-order]').forEach(button=>button.addEventListener('click',()=>recordRecentOrderRefund(button)));
  const orderTable=target.querySelector('table');
  if(orderTable){
   if(!canRefund){const header=document.createElement('th');header.textContent='Action';orderTable.tHead.rows[0].append(header);}
   Array.from(orderTable.tBodies[0].rows).forEach((row,index)=>{
    const cell=canRefund?row.lastElementChild:row.insertCell(-1);
    const print=document.createElement('button');print.className='secondary actions-button';print.type='button';print.textContent='Print';print.dataset.printOrder=orders[index].id;cell.prepend(print);
    print.addEventListener('click',()=>printOrderReceipt(orders[index]));
    if(canRefund&&orders[index].status!=='void'){
     const voidButton=document.createElement('button');voidButton.className='secondary actions-button';voidButton.type='button';voidButton.textContent='Void';voidButton.dataset.voidOrder=orders[index].id;cell.append(' ',voidButton);
     voidButton.addEventListener('click',()=>voidSalesOrder(voidButton));
    }
   });
  }
}
function printOrderReceipt(order){
 const popup=window.open('','_blank','width=420,height=700');
 if(!popup){appMessage('Allow pop-ups to print the receipt.');return;}
 const items=(order.sales_order_items||[]).map(item=>`<tr><td>${esc(item.product_name)}</td><td>${Number(item.quantity)}</td><td class="right">${peso(Number(item.unit_price)*Number(item.quantity))}</td></tr>`).join('');
 popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Receipt #${esc(order.order_number)}</title><style>body{font:14px Arial,sans-serif;width:320px;margin:24px auto;color:#111}h1{text-align:center;font-size:20px;margin:0 0 4px}p{text-align:center;margin:4px 0 16px;color:#555}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #ddd}td:nth-child(2){text-align:center;width:42px}.right{text-align:right}.total{font-weight:bold;font-size:17px;border-top:2px solid #111;border-bottom:0}</style></head><body><h1>HAVENS BURGER</h1><p>Order #${esc(order.order_number)}<br>${new Date(order.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'})}</p><table>${items}<tr><td colspan="2" class="total">Total</td><td class="right total">${peso(order.total)}</td></tr></table><p>Thank you!</p></body></html>`);
 popup.document.close();popup.focus();popup.print();
}
async function voidSalesOrder(button){
 const reason=window.prompt('Reason for voiding this order (required):');
 if(reason===null)return;
 if(reason.trim().length<3){appMessage('A void reason is required.');return;}
 button.disabled=true;
 try{
  const {error}=await client.rpc('void_sales_order',{p_order_id:button.dataset.voidOrder,p_reason:reason.trim()});
  if(error)dbError(error);appMessage('Order voided and audit log recorded.',false);await renderRecentOrders();
 }catch(error){appMessage('Could not void order: '+error.message);button.disabled=false;}
}
async function recordRecentOrderRefund(button){
 const remaining=Number(button.dataset.refundRemaining);
 const enteredAmount=window.prompt(`Refund amount (up to ${peso(remaining)}):`,remaining.toFixed(2));
 if(enteredAmount===null)return;
 const amount=Number(enteredAmount);
 if(!Number.isFinite(amount)||amount<=0||amount>remaining){
  appMessage('Enter a positive amount no greater than the remaining refundable balance.');return;
 }
 const reason=window.prompt('Reason for this refund (required):');
 if(reason===null)return;
 if(!reason.trim()){
  appMessage('A refund reason is required.');return;
 }
 button.disabled=true;
 try{
  const {error}=await client.rpc('record_payment_refund',{
   p_order_id:button.dataset.refundOrder,p_amount:amount,p_reason:reason.trim()
  });
  if(error)dbError(error);
 }catch(error){appMessage('Could not record refund: '+error.message);button.disabled=false;return;}
 appMessage('Refund recorded.',false);
 try{await renderRecentOrders();}
 catch(error){appMessage('Refund recorded, but recent orders could not refresh: '+error.message);}
}
async function renderInventory(){
 const canManageInventory=['owner_admin','manager'].includes(profile.role);
 const inventoryRequest=canManageInventory
  ?client.from('ingredients').select('id,name,unit,stock_quantity,reorder_level,unit_cost,active')
  :client.rpc('list_readonly_inventory');
 const {data:inventoryRows,error:inventoryError}=await inventoryRequest;
 if(inventoryError)dbError(inventoryError);
 ingredients=inventoryRows||[];
 const {data:movementRows,error:movementError}=await client.from('inventory_movements')
  .select('id,ingredient_id,quantity_change,movement_type,note,created_at').order('created_at',{ascending:false}).limit(30);
 if(movementError)dbError(movementError);
 const {data:catalogImport,error:catalogImportError}=await client.from('catalog_file_imports')
  .select('products_imported,products_skipped,imported_at').eq('branch_id',profile.branch_id).maybeSingle();
 if(catalogImportError)dbError(catalogImportError);
 if(canManageInventory&&!catalogImport&&!catalogAutoImportInProgress){
  catalogAutoImportInProgress=true;
  try{
   const {data,error}=await client.rpc('import_hb_v11_catalog');
   if(error)dbError(error);
   appMessage(`Default menu checked: added ${data.products_imported} products and skipped ${data.products_skipped} existing matches. Stock remains unchanged.`,false);
  }finally{
   catalogAutoImportInProgress=false;
  }
  return renderInventory();
 }
 const ingredientOrder=['buns','bun','burger buns','burger bun','patties','patty','beef patties','beef patty','cheese','slice cheese','cheese slice','lettuce','tomato','tomatoes','onion','onions','sauce','bacon'];
 ingredients.sort((a,b)=>{
  const aIndex=ingredientOrder.indexOf(a.name.trim().toLowerCase());
  const bIndex=ingredientOrder.indexOf(b.name.trim().toLowerCase());
  return (aIndex<0?ingredientOrder.length:aIndex)-(bIndex<0?ingredientOrder.length:bIndex)||a.name.localeCompare(b.name);
 });
 $('pageContent').innerHTML=`<div class="page-heading"><div><h2>Inventory</h2><p>${canManageInventory?"Set each ingredient's actual quantity directly—no need to type its name.":'View current ingredient stock. Contact the Manager to make changes.'}</p></div>${canManageInventory?(catalogImport?'<span class="pill green">Default menu ready</span>':'<button id="importHbCatalog" class="secondary" type="button">Add missing default menu</button>'):''}</div>
  ${canManageInventory?'<section class="notice inventory-opening-note">Update any ingredient counts you need, then press “Save all counts” once. Leave other counts unchanged. New inventory items start at 0.</section>':''}
  ${canManageInventory&&missingStockLabels(ingredients).length?`<section class="notice inventory-missing-note">Some standard inventory labels are missing: ${missingStockLabels(ingredients).map(esc).join(', ')}. Run the corrected migrations/004_inventory_stock_rules.sql in Supabase first, then refresh.</section>`:''}
  ${canManageInventory&&!catalogImport?`<section class="panel"><h2>Default menu</h2><p class="muted">The default catalog adds B1 Classic, B2 Cheese, B3 Deluxe, and B4 Double Cheese, each with Single and B1T1 options, plus the seven extras from hb.html. It skips existing same-name products and never changes current stock.</p></section>`:''}
  <section class="panel"><div class="section-heading"><div><h2>${canManageInventory?'Opening / current stock':'Current stock'}</h2><p>Search by ingredient name to find a stock item quickly.</p></div></div><label for="inventorySearch">Search inventory</label><input id="inventorySearch" type="search" placeholder="Buns, patties, cheese…" autocomplete="off">${canManageInventory?`<form id="stockCountForm"><div class="table-wrap">${ingredientTable(ingredients)}</div><button id="saveAllStockCounts" class="primary wide" type="submit">Save all counts</button></form>`:`<div class="table-wrap">${ingredientTable(ingredients,true)}</div>`}</section>
  <section class="panel"><div class="section-heading"><div><h2>Recent stock movements</h2><p>The latest 30 stock changes for this branch.</p></div><span class="pill">${(movementRows||[]).length} shown</span></div>${inventoryMovementTable(movementRows||[],ingredients)}</section>
  ${canManageInventory?`<section class="panel"><h2>Record wastage</h2><p class="muted">Use this for spoiled, damaged, or discarded stock.</p><form id="wasteForm" class="form-grid"><div><label>Ingredient</label><select name="ingredient_id" required>${ingredientOptions(ingredients)}</select></div><div><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" required></div><div class="full"><label>Reason</label><input name="note" maxlength="240" placeholder="Spoiled, damaged, or discarded" required></div><div class="full"><button class="secondary wide">Record wastage</button></div></form></section><section class="panel"><h2>Add POS product</h2><form id="productForm" class="form-grid"><div><label>Product name</label><input name="name" maxlength="120" required></div><div><label>Price (₱)</label><input name="price" type="number" min="0" step="0.01" required></div><div class="full"><button class="primary wide">Add product</button></div></form></section>
  <details class="panel inventory-custom-ingredient"><summary>Add another ingredient</summary><form id="ingredientForm" class="form-grid"><div><label>Ingredient name</label><input name="name" maxlength="120" required></div><div><label>Stock unit</label><input name="unit" maxlength="24" required></div><div><label>Opening stock</label><input name="starting_stock" type="number" min="0" step="0.001" value="0" required></div><div><label>Alert me when at</label><input name="reorder_level" type="number" min="0" step="0.001" value="0" required></div><div class="full"><label>Cost per unit (₱)</label><input name="unit_cost" type="number" min="0" step="0.0001" value="0"></div><div class="full"><button class="primary wide">Add ingredient</button></div></form></details>`:''}`;
 if(canManageInventory){
  $('ingredientForm').addEventListener('submit',createIngredient);
  $('productForm').addEventListener('submit',createProduct);
   $('wasteForm').addEventListener('submit',recordWaste);
  if(!catalogImport)$('importHbCatalog').addEventListener('click',importHbCatalog);
  $('stockCountForm').addEventListener('submit',saveStockCounts);
 }
  const inventoryFilter=document.createElement('select');inventoryFilter.id='inventoryStatusFilter';inventoryFilter.setAttribute('aria-label','Filter inventory status');inventoryFilter.innerHTML='<option value="all">All stock</option><option value="low">Low stock</option><option value="in">In stock</option><option value="out">Out of stock</option>';$('inventorySearch').after(inventoryFilter);
  const filterInventory=()=>{const query=$('inventorySearch').value.trim().toLowerCase(),status=inventoryFilter.value;Array.from($('pageContent').querySelectorAll('.inventory-item')).forEach((item,index)=>{const row=ingredients[index],stock=Number(row?.stock_quantity||0),reorder=Number(row?.reorder_level||0),matchesStatus=status==='all'||(status==='low'&&stock<=reorder)||(status==='in'&&stock>reorder)||(status==='out'&&stock===0);item.hidden=(!matchesStatus)||(query&&!item.textContent.toLowerCase().includes(query));});};
  $('inventorySearch').addEventListener('input',filterInventory);inventoryFilter.addEventListener('change',filterInventory);
}
async function importHbCatalog(){
 const accepted=window.confirm('Add the default menu and inventory stock rules? Existing same-name products will be skipped. Existing opening stock will not change; new inventory items start at 0. Sales history is not imported.');
 if(!accepted)return;
 const button=$('importHbCatalog');if(button)button.disabled=true;
 try{
  const {data,error}=await client.rpc('import_hb_v11_catalog');
  if(error)dbError(error);
  appMessage(`Imported ${data.products_imported} products; skipped ${data.products_skipped} existing products. New ingredients added: ${data.ingredients_added}. Stock was not changed.`,false);
  await renderInventory();
 }catch(error){
  appMessage('Catalog import failed: '+error.message);
  if(button)button.disabled=false;
 }
}
function ingredientTable(rows,readOnly=false){
 if(!rows.length)return '<div class="empty">No ingredients yet.</div>';
 return `<div class="inventory-grid">${rows.map(row=>{const low=!readOnly&&Number(row.stock_quantity)<=Number(row.reorder_level);return `<article class="inventory-item ${low?'inventory-item-low':''}"><div class="inventory-item-heading"><div><span class="inventory-item-label">Ingredient</span><h3>${esc(ingredientLabel(row.name))}</h3></div><span class="pill ${readOnly?'blue':low?'orange':'green'}">${readOnly?'Stock':low?'Low stock':'In stock'}</span></div><div class="inventory-item-balance"><span>Current stock</span><b>${Number(row.stock_quantity)} <small>${esc(row.unit)}</small></b></div>${readOnly?'':`<div class="inventory-item-meta"><span>Reorder at <b>${Number(row.reorder_level)} ${esc(row.unit)}</b></span><span>Unit cost <b>${peso(row.unit_cost)}</b></span></div><label class="inventory-count-label" for="stock-count-${row.id}">Counted quantity</label><div class="stock-count-control"><input id="stock-count-${row.id}" name="stock_count_${row.id}" type="number" min="0" step="0.001" value="${Number(row.stock_quantity)}" required><span>${esc(row.unit)}</span></div>`}</article>`;}).join('')}</div>`;
}
function ingredientOptions(rows){
 const activeRows=rows.filter(row=>row.active);
 return activeRows.map(row=>`<option value="${row.id}">${esc(ingredientLabel(row.name))} · ${Number(row.stock_quantity)} ${esc(row.unit)} available</option>`).join('')||
  '<option value="">Add an ingredient first</option>';
}
function ingredientLabel(name){
 const normalized=name.trim().toLowerCase();
 const labels={
  buns:'Buns',bun:'Buns','burger buns':'Buns','burger bun':'Buns',
  patties:'Patties',patty:'Patties','beef patties':'Patties','beef patty':'Patties',
  cheese:'Cheese','slice cheese':'Cheese','cheese slice':'Cheese',
  lettuce:'Lettuce',tomato:'Tomato',tomatoes:'Tomato',
  onion:'Onion',onions:'Onion',sauce:'Sauce',bacon:'Bacon'
 };
 return labels[normalized]||name;
}
function inventoryMovementTable(rows,ingredientRows){
 const names=new Map(ingredientRows.map(row=>[row.id,ingredientLabel(row.name)]));
 return rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Ingredient</th><th>Type</th><th class="right">Change</th><th>Note</th></tr></thead><tbody>${rows.map(row=>`<tr><td class="nowrap">${new Date(row.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'short',timeStyle:'short'})}</td><td>${esc(names.get(row.ingredient_id)||'Unknown ingredient')}</td><td><span class="pill">${esc(row.movement_type)}</span></td><td class="right ${Number(row.quantity_change)<0?'stock-quantity-low':''}>${Number(row.quantity_change)>0?'+':''}${Number(row.quantity_change)}</td><td>${esc(row.note||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No stock movements recorded yet.</div>';
}
function missingStockLabels(rows){
 const known=new Set(rows.map(row=>ingredientLabel(row.name)));
 return ['Buns','Patties','Cheese','Lettuce','Tomato','Onion','Sauce','Bacon'].filter(label=>!known.has(label));
}
async function saveStockCounts(event){
 event.preventDefault();
 const button=$('saveAllStockCounts');
 const counts=ingredients.map(row=>{
  const input=$(`stock-count-${row.id}`);
  return {ingredient_id:row.id,stock_count:Number(input.value)};
 });
 if(counts.some(row=>!Number.isFinite(row.stock_count)||row.stock_count<0)){
  appMessage('Enter valid stock counts of zero or more.');return;
 }
 const changed=counts.filter(row=>{
  const current=ingredients.find(item=>item.id===row.ingredient_id);
  return current&&row.stock_count!==Number(current.stock_quantity);
 });
 if(!changed.length){appMessage('No stock counts changed.',false);return;}
 button.disabled=true;
 try{
  const {error}=await client.rpc('set_ingredient_stock_counts',{p_counts:changed});
  if(error)dbError(error);
  appMessage(`Saved ${changed.length} ingredient stock ${changed.length===1?'count':'counts'}.`,false);
  await renderInventory();
 }catch(error){
  appMessage('Could not save stock counts: '+error.message);
  button.disabled=false;
 }
}
async function createIngredient(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 try{
  const {error}=await client.rpc('create_ingredient',{
   p_name:values.name.trim(),p_unit:values.unit.trim(),p_starting_stock:Number(values.starting_stock),
   p_reorder_level:Number(values.reorder_level),p_unit_cost:Number(values.unit_cost)
  });
  if(error)dbError(error);appMessage('Ingredient and opening stock added.',false);await renderInventory();
 }catch(error){appMessage(error.message);}
}
async function createProduct(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 try{
  const {error}=await client.from('products').insert({branch_id:profile.branch_id,name:values.name.trim(),price:Number(values.price)});
  if(error)dbError(error);appMessage('POS product added.',false);await renderInventory();
 }catch(error){appMessage(error.message);}
}
async function recordWaste(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 try{
  const {error}=await client.rpc('record_inventory_waste',{p_ingredient_id:values.ingredient_id,p_quantity:Number(values.quantity),p_note:values.note.trim()});
  if(error)dbError(error);appMessage('Inventory wastage recorded.',false);await renderInventory();
 }catch(error){appMessage('Could not record wastage: '+error.message);}
}
async function renderPurchasing(){
 const [supplierRows,ingredientRows,orders]=await Promise.all([
  fetchRows('suppliers','*','name'),client.from('ingredients').select('id,name,unit,stock_quantity,active').eq('active',true).order('name'),
  client.from('purchase_orders').select('id,status,notes,created_at,suppliers(name),purchase_order_items(quantity,unit_cost,ingredients(name,unit))').order('created_at',{ascending:false}).limit(30)
 ]);
 if(ingredientRows.error)dbError(ingredientRows.error);
 if(orders.error)dbError(orders.error);
 suppliers=supplierRows;ingredients=ingredientRows.data||[];
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">INVENTORY OPERATIONS</span><h2>Suppliers & purchasing</h2><p>Create purchase orders and receive deliveries into ingredient stock.</p></div><span class="pill">${suppliers.length} ${suppliers.length===1?'supplier':'suppliers'}</span></div>
  <div class="grid two-col purchasing-forms">
   <section class="panel module-panel"><div class="module-form-heading"><span class="module-form-icon">＋</span><div><h2>Add supplier</h2><p>Keep supplier contact details handy.</p></div></div><form id="supplierForm" class="form-grid"><div class="full"><label>Supplier name</label><input name="name" maxlength="120" required></div><div><label>Contact person</label><input name="contact_name" maxlength="120"></div><div><label>Phone</label><input name="phone" maxlength="40"></div><div class="full"><label>Email</label><input name="email" type="email" maxlength="200"></div><div class="full"><button class="primary wide">Save supplier</button></div></form></section>
   <section class="panel module-panel"><div class="module-form-heading"><span class="module-form-icon">↗</span><div><h2>Create purchase order</h2><p>Record an order before receiving the delivery.</p></div></div><form id="purchaseForm"><label>Supplier</label><select name="supplier_id" required>${suppliers.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')||'<option value="">Add a supplier first</option>'}</select><label>Ingredient</label><select name="ingredient_id" required>${ingredientOptions(ingredients)}</select><div class="form-grid"><div><label>Quantity</label><input name="quantity" type="number" min="0.001" step="0.001" required></div><div><label>Unit cost (₱)</label><input name="unit_cost" type="number" min="0" step="0.0001" required></div></div><label>Notes</label><input name="notes" maxlength="500"><button class="primary wide">Create order</button></form></section>
  </div>
  <section class="panel module-panel"><div class="section-heading"><div><h2>Purchase orders</h2><p>Review and receive outstanding deliveries.</p></div><span class="pill">${(orders.data||[]).length} recent</span></div><div class="table-wrap">${purchaseTable(orders.data||[])}</div></section>`;
 $('supplierForm').addEventListener('submit',createSupplier);
 $('purchaseForm').addEventListener('submit',createPurchaseOrder);
 $('pageContent').querySelectorAll('[data-receive]').forEach(button=>button.addEventListener('click',()=>receivePurchase(button.dataset.receive)));
}
function purchaseTable(rows){
 if(!rows.length)return '<div class="empty">No purchase orders yet.</div>';
 return `<table class="purchasing-table"><thead><tr><th>Created</th><th>Supplier</th><th>Items</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(row=>{
  const lines=row.purchase_order_items||[];
  return `<tr><td>${new Date(row.created_at).toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})}</td><td><b>${esc(row.suppliers?.name||'—')}</b></td><td>${lines.map(line=>`${esc(ingredientLabel(line.ingredients?.name||''))} × ${line.quantity} ${esc(line.ingredients?.unit||'')}`).join('<br>')}</td><td><span class="pill ${row.status==='received'?'green':row.status==='cancelled'?'red':'orange'}">${esc(row.status)}</span></td><td>${row.status==='ordered'?`<button class="success" data-receive="${row.id}">Receive delivery</button>`:'—'}</td></tr>`;
 }).join('')}</tbody></table>`;
}
async function createSupplier(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 try{
  const {error}=await client.from('suppliers').insert({branch_id:profile.branch_id,name:values.name.trim(),contact_name:values.contact_name||null,phone:values.phone||null,email:values.email||null});
  if(error)dbError(error);appMessage('Supplier saved.',false);await renderPurchasing();
 }catch(error){appMessage(error.message);}
}
async function createPurchaseOrder(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 if(!values.supplier_id||!values.ingredient_id){appMessage('Add a supplier and ingredient first.');return;}
 try{
  const {error}=await client.rpc('create_purchase_order',{
   p_supplier_id:values.supplier_id,
   p_items:[{ingredient_id:values.ingredient_id,quantity:Number(values.quantity),unit_cost:Number(values.unit_cost)}],
   p_notes:values.notes.trim()||null
  });
  if(error)dbError(error);appMessage('Purchase order created. Receive it when the delivery arrives.',false);await renderPurchasing();
 }catch(error){appMessage(error.message);}
}
async function receivePurchase(orderId){
 if(!window.confirm('Mark this purchase as received and add its quantity to stock?'))return;
 try{
  const {error}=await client.rpc('receive_purchase_order',{p_order_id:orderId});
  if(error)dbError(error);appMessage('Delivery received and stock updated.',false);await renderPurchasing();
 }catch(error){appMessage(error.message);}
}
async function renderKitchen(){
 const {data,error}=await client.from('sales_orders')
  .select('id,order_number,status,order_type,notes,created_at,sales_order_items(product_name,quantity)')
  .in('status',['new','preparing','ready']).order('created_at',{ascending:true}).limit(100);
 if(error)dbError(error);
 const tickets=data||[],counts={new:tickets.filter(order=>order.status==='new').length,preparing:tickets.filter(order=>order.status==='preparing').length,ready:tickets.filter(order=>order.status==='ready').length};
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">LIVE ORDER QUEUE</span><h2>Kitchen display</h2><p>New orders appear here as they are placed.</p></div><button id="refreshKitchen" class="secondary refresh-button" type="button"><span aria-hidden="true">↻</span> Refresh</button></div>
  <div class="kitchen-summary"><div class="kitchen-summary-item"><span class="kitchen-status-dot status-new"></span><span>New</span><b>${counts.new}</b></div><div class="kitchen-summary-item"><span class="kitchen-status-dot status-preparing"></span><span>Preparing</span><b>${counts.preparing}</b></div><div class="kitchen-summary-item"><span class="kitchen-status-dot status-ready"></span><span>Ready</span><b>${counts.ready}</b></div></div>
  <div class="grid kitchen-grid">${tickets.map(order=>`<article class="panel ticket ticket-${order.status}"><div class="ticket-top"><div><span class="ticket-number-label">ORDER</span><b class="ticket-number">#${order.order_number}</b></div><span class="pill ${order.status==='ready'?'green':order.status==='preparing'?'orange':'blue'}">${esc(order.status)}</span></div><div class="ticket-meta"><span>${new Date(order.created_at).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'})}</span><span>${esc(order.order_type.replace('_',' '))}</span></div><ul class="ticket-items">${order.sales_order_items.map(line=>`<li><b>${line.quantity}×</b><span>${esc(line.product_name)}</span></li>`).join('')}</ul>${order.notes?`<div class="notice ticket-note"><b>Kitchen note</b><span>${esc(order.notes)}</span></div>`:''}<div class="ticket-actions">${order.status==='new'?`<button class="primary" data-status="${order.id}" data-next="preparing">Start preparing</button>`:order.status==='preparing'?`<button class="success" data-status="${order.id}" data-next="ready">Mark ready</button>`:`<button class="success" data-status="${order.id}" data-next="served">Mark served</button>`}</div></article>`).join('')||'<div class="panel kitchen-empty"><span class="empty-success-mark">✓</span><b>Kitchen is all caught up</b><span>No active tickets right now.</span></div>'}</div>`;
 $('refreshKitchen').addEventListener('click',()=>openPage('kitchen'));
 $('pageContent').querySelectorAll('[data-status]').forEach(button=>button.addEventListener('click',()=>updateKitchenStatus(button.dataset.status,button.dataset.next)));
}
async function updateKitchenStatus(orderId,status){
 try{
  const {error}=await client.rpc('set_kitchen_status',{p_order_id:orderId,p_status:status});
  if(error)dbError(error);await renderKitchen();
 }catch(error){appMessage(error.message);}
}
async function renderStaff(){
 const {data,error}=await client.from('staff_profiles').select('user_id,display_name,role,active,created_at').order('created_at');
 if(error)dbError(error);
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">TEAM MANAGEMENT</span><h2>Staff & access</h2><p>Invite staff by email. Each person sets their own password from the invitation email.</p></div><span class="pill">${(data||[]).length} staff</span></div>
  <div class="grid two-col staff-layout"><section class="panel module-panel"><div class="module-form-heading"><span class="module-form-icon">＋</span><div><h2>Invite staff member</h2><p>Choose the access needed for their role.</p></div></div><form id="staffForm" class="staff-form"><label>Staff name</label><input name="display_name" maxlength="120" autocomplete="name" required><label>Email</label><input name="email" type="email" autocomplete="off" required><label>Role</label><select name="role"><option value="manager">Manager</option><option value="cashier">Cashier</option><option value="kitchen">Kitchen</option></select><button class="primary wide" type="submit">Send invitation</button></form><p class="hint staff-security-note">Managers handle inventory and purchasing. Owner/Admin access cannot be assigned from this form. Keep the service-role key server-side only.</p></section>
  <section class="panel module-panel"><div class="section-heading"><div><h2>Role access</h2><p>Access is limited by each staff member's role.</p></div></div><div class="role-guide"><div><span class="role-guide-mark role-admin">A</span><span><b>Owner / Admin</b><small>All modules and business setup</small></span></div><div><span class="role-guide-mark role-manager">M</span><span><b>Manager</b><small>All modules except Staff & access</small></span></div><div><span class="role-guide-mark role-cashier">C</span><span><b>Cashier</b><small>POS, Kitchen, and read-only Inventory</small></span></div><div><span class="role-guide-mark role-kitchen">K</span><span><b>Kitchen</b><small>Kitchen display and read-only Inventory</small></span></div></div><div class="staff-list-heading"><h2>Staff accounts</h2><span class="pill">${(data||[]).length}</span></div><div class="table-wrap">${staffTable(data||[])}</div></section></div>`;
 $('staffForm').addEventListener('submit',createStaff);
 $('pageContent').querySelectorAll('[data-resend-invite]').forEach(button=>button.addEventListener('click',()=>resendStaffInvite(button)));
}
function staffTable(rows){
 return rows.length?`<table><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Invite</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.display_name)}</td><td>${esc(ROLE_LABELS[row.role]||row.role)}</td><td><span class="pill ${row.active?'green':'red'}">${row.active?'Active':'Inactive'}</span></td><td>${row.role==='owner_admin'?'—':`<button class="secondary actions-button" type="button" data-resend-invite="${esc(row.user_id)}">Resend invite</button>`}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No staff profiles found.</div>';
}
async function resendStaffInvite(button){
 const userId=button.dataset.resendInvite;
 button.disabled=true;
 try{
  const {data:{session},error:sessionError}=await client.auth.getSession();
  if(sessionError||!session)throw new Error('Your sign-in expired. Sign in again.');
  const response=await fetch('/api/staff',{
   method:'POST',
   headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},
   body:JSON.stringify({action:'resend',user_id:userId})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||'Could not resend the staff invitation.');
  appMessage(`A new setup email was sent to ${result.email}. The previous link will no longer be needed.`,false);
 }catch(error){appMessage(error.message||'Could not resend the staff invitation.');}
 finally{button.disabled=false;}
}
async function createStaff(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 const button=event.currentTarget.querySelector('button[type="submit"],button:not([type])');if(button)button.disabled=true;
 try{
  if(window.location.protocol==='file:')throw new Error('Staff invitations work after deployment to Vercel. Open the deployed app to invite staff.');
  const {data:{session},error:sessionError}=await client.auth.getSession();
  if(sessionError||!session)throw new Error('Your sign-in expired. Sign in again.');
  const response=await fetch('/api/staff',{
   method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},
   body:JSON.stringify({display_name:values.display_name.trim(),email:values.email.trim(),role:values.role})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||'Could not send the staff invitation. Check the Vercel API setup.');
  appMessage(`Invitation sent to ${values.email.trim()}. Ask them to open the email and set their own password.`,false);await renderStaff();
 }catch(error){appMessage(error.message);}
 finally{if(button)button.disabled=false;}
}
async function renderExpenses(){
 const {data,error}=await client.from('expenses').select('id,category,description,amount,payment_method,spent_at,created_at').order('spent_at',{ascending:false}).order('created_at',{ascending:false}).limit(100);
 if(error)dbError(error);
 const today=manilaDateString(),tomorrow=shiftDateString(today,1);
 const report=await getOperationalReport(today,tomorrow);
 const total=Number(report.expenses.total);
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">OPERATING COSTS</span><h2>Expenses</h2><p>Track spending by category, date, and payment method.</p></div></div>
  <div class="expense-summary stat"><div class="stat-top"><div class="stat-label">Recorded today · Manila time</div><span class="stat-icon">−</span></div><div class="stat-value">${peso(total)}</div><p class="stat-caption">Expenses for ${today}</p></div>
  <section class="panel module-panel expense-form-panel"><div class="module-form-heading"><span class="module-form-icon">₱</span><div><h2>Record expense</h2><p>Keep a note of each business expense.</p></div></div><form id="expenseForm" class="form-grid"><div><label>Category</label><input name="category" maxlength="80" placeholder="Utilities, rent, supplies" required></div><div><label>Amount (₱)</label><input name="amount" type="number" min="0.01" step="0.01" required></div><div class="full"><label>Description</label><input name="description" maxlength="240" required></div><div><label>Payment method</label><select name="payment_method"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="card">Card</option><option value="other">Other</option></select></div><div><label>Date</label><input name="spent_at" type="date" value="${today}" required></div><div class="full"><button class="primary wide">Save expense</button></div></form></section>
  <section class="panel module-panel"><div class="section-heading"><div><h2>Recent expenses</h2><p>Latest 100 entries; the daily total above includes all records.</p></div><span class="pill">${(data||[]).length} shown</span></div><div class="table-wrap">${expenseTable(data||[])}</div></section>`;
 $('expenseForm').addEventListener('submit',createExpense);
}
function expenseTable(rows){
 return rows.length?`<table class="expense-table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Payment</th><th class="right">Amount</th></tr></thead><tbody>${rows.map(row=>`<tr><td class="nowrap">${esc(row.spent_at)}</td><td><span class="expense-category">${esc(row.category)}</span></td><td>${esc(row.description)}</td><td><span class="pill">${esc(row.payment_method)}</span></td><td class="right expense-amount">${peso(row.amount)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No expenses recorded.</div>';
}
async function createExpense(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 try{
  const {error}=await client.from('expenses').insert({
   branch_id:profile.branch_id,category:values.category.trim(),description:values.description.trim(),
   amount:Number(values.amount),payment_method:values.payment_method,spent_at:values.spent_at,created_by:profile.user_id
  });
  if(error)dbError(error);appMessage('Expense recorded.',false);await renderExpenses();
 }catch(error){appMessage(error.message);}
}
async function renderReports(){
 const today=manilaDateString(),weekAgo=shiftDateString(today,-6);
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">BUSINESS PERFORMANCE</span><h2>Sales & payment reports</h2><p>Order value/voids use order dates; payments/refunds use their recorded dates; expenses use expense dates. Outstanding online orders show the current all-date balance. This is not a profit report because cost of goods sold is not included.</p></div></div>
  <section class="panel module-panel report-filter-panel"><form id="reportForm" class="inline-form"><div><label>From</label><input name="start_date" type="date" value="${weekAgo}" required></div><div><label>Through</label><input name="end_date" type="date" value="${today}" required></div><button class="primary"><span aria-hidden="true">⌕</span> Run report</button></form></section><div id="reportResults" class="report-results empty">Loading report…</div>`;
 $('reportForm').addEventListener('submit',event=>{event.preventDefault();loadReport(event.currentTarget);});
 const exportButton=document.createElement('button');exportButton.id='exportReportCsv';exportButton.className='secondary';exportButton.type='button';exportButton.textContent='Export CSV';exportButton.addEventListener('click',exportReportCsv);$('reportForm').append(exportButton);
 await loadReport($('reportForm'));
}
async function loadReport(form){
 const values=Object.fromEntries(new FormData(form));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(values.start_date)||!/^\d{4}-\d{2}-\d{2}$/.test(values.end_date)||values.start_date>values.end_date){appMessage('Choose a valid report date range.');return;}
 const nextDay=shiftDateString(values.end_date,1);
 const target=$('reportResults');target.className='empty';target.textContent='Loading report…';
 try{
   const data=await getOperationalReport(values.start_date,nextDay);lastReportData={data,startDate:values.start_date,endDate:values.end_date};
  const orders=data.orders,payments=data.payments,outstanding=data.outstanding,expenses=data.expenses;
  const cashNet=Number(payments.cash_collected)-Number(payments.cash_refunded);
  const gcashNet=Number(payments.gcash_collected)-Number(payments.gcash_refunded);
  const cardNet=Number(payments.card_collected)-Number(payments.card_refunded);
  const voidedUnreturned=Number(payments.voided_unreturned_amount);
  target.className='';
  target.innerHTML=`<div class="grid stats report-stats"><div class="stat stat-orders"><div class="stat-top"><div class="stat-label">Orders recorded · non-void</div><span class="stat-icon">#</span></div><div class="stat-value">${Number(orders.order_count)}</div><p class="stat-caption">${Number(orders.void_count)} voided in this order-date range</p></div><div class="stat stat-sales"><div class="stat-top"><div class="stat-label">Order value recorded</div><span class="stat-icon">₱</span></div><div class="stat-value">${peso(orders.recorded_order_value)}</div></div><div class="stat stat-payment"><div class="stat-top"><div class="stat-label">Net payments received</div><span class="stat-icon">✓</span></div><div class="stat-value">${peso(payments.net_collected)}</div><p class="stat-caption">${peso(payments.payments_collected)} received − ${peso(payments.refunds_issued)} refunded</p></div><div class="stat stat-expenses"><div class="stat-top"><div class="stat-label">Unpaid online · current</div><span class="stat-icon">…</span></div><div class="stat-value">${peso(outstanding.amount)}</div><p class="stat-caption">${Number(outstanding.unpaid_order_count)} open orders · all dates</p></div></div><div class="grid two-col report-detail-grid"><section class="panel module-panel"><div class="section-heading"><div><h2>Net receipts by method</h2><p>Actual payment records less refunds recorded in this period.</p></div></div><div class="report-breakdown"><div><span>Cash</span><b>${peso(cashNet)}</b></div><div><span>GCash</span><b>${peso(gcashNet)}</b></div><div><span>Card</span><b>${peso(cardNet)}</b></div></div>${voidedUnreturned>0?`<p class="report-void-count">Still collected on voided orders <b>${peso(voidedUnreturned)}</b></p>`:''}</section><section class="panel module-panel"><div class="section-heading"><div><h2>Expenses</h2><p>Based on expense date in the selected range.</p></div></div><div class="report-expense-total">${peso(expenses.total)}</div><p class="muted">${Number(expenses.expense_count)} recorded ${Number(expenses.expense_count)===1?'expense':'expenses'}</p></section></div>`;
 }catch(error){target.className='empty';target.textContent='Report could not be loaded.';appMessage(error.message);}
}
function exportReportCsv(){
 if(!lastReportData){appMessage('Run a report before exporting.');return;}
 const {data,startDate,endDate}=lastReportData,rows=[
  ['Havens Burger report','Value'],['From',startDate],['Through',endDate],['Orders recorded',data.orders.order_count],['Voided orders',data.orders.void_count],['Order value',data.orders.recorded_order_value],['Payments collected',data.payments.payments_collected],['Refunds issued',data.payments.refunds_issued],['Net collected',data.payments.net_collected],['Outstanding online orders',data.outstanding.unpaid_order_count],['Outstanding amount',data.outstanding.amount],['Expenses',data.expenses.total]
 ];
 const csv=rows.map(row=>row.map(value=>`"${String(value??'').replaceAll('"','""')}"`).join(',')).join('\n');
 const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=`havens-report-${startDate}-to-${endDate}.csv`;link.click();URL.revokeObjectURL(url);
}
async function renderCashClosing(){
 const today=manilaDateString();
 const {data,error}=await client.from('cashier_closings').select('business_date,expected_cash,actual_cash,difference,notes,created_at').order('business_date',{ascending:false}).limit(30);
 if(error)dbError(error);
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">END OF DAY</span><h2>Cash closing</h2><p>Compare recorded cash payments with the cash counted in the drawer.</p></div></div><section class="panel module-panel"><form id="cashClosingForm" class="form-grid"><div><label>Business date</label><input name="business_date" type="date" value="${today}" required></div><div><label>Actual cash counted (₱)</label><input name="actual_cash" type="number" min="0" step="0.01" required></div><div class="full"><label>Notes</label><input name="notes" maxlength="240" placeholder="Optional closing note"></div><div class="full"><button class="primary wide">Close cashier day</button></div></form></section><section class="panel module-panel"><div class="section-heading"><div><h2>Recent closings</h2><p>Latest 30 closing records.</p></div><span class="pill">${(data||[]).length} shown</span></div>${cashClosingTable(data||[])}</section>`;
 $('cashClosingForm').addEventListener('submit',closeCashierDay);
}
function cashClosingTable(rows){
 return rows.length?`<div class="table-wrap"><table><thead><tr><th>Date</th><th class="right">Expected</th><th class="right">Actual</th><th class="right">Difference</th><th>Notes</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(row.business_date)}</td><td class="right">${peso(row.expected_cash)}</td><td class="right">${peso(row.actual_cash)}</td><td class="right ${Number(row.difference)<0?'stock-quantity-low':''}>${peso(row.difference)}</td><td>${esc(row.notes||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No cashier closings recorded yet.</div>';
}
async function closeCashierDay(event){
 event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));
 try{
  const {data,error}=await client.rpc('close_cashier_day',{p_business_date:values.business_date,p_actual_cash:Number(values.actual_cash),p_notes:values.notes.trim()||null});
  if(error)dbError(error);appMessage(`Cash closing saved. Difference: ${peso(data.difference)}.`,false);await renderCashClosing();
 }catch(error){appMessage('Could not close cashier day: '+error.message);}
}
async function renderAudit(){
 const {data,error}=await client.from('audit_logs').select('id,actor_id,action,entity_type,entity_id,details,created_at').order('created_at',{ascending:false}).limit(100);
 if(error)dbError(error);
 $('pageContent').innerHTML=`<div class="page-heading module-heading"><div><span class="inventory-item-label">ACCOUNTABILITY</span><h2>Audit log</h2><p>Recent operational actions recorded for this branch.</p></div><span class="pill">${(data||[]).length} shown</span></div><section class="panel module-panel">${auditTable(data||[])}</section>`;
}
function auditTable(rows){
 return rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>${rows.map(row=>`<tr><td class="nowrap">${new Date(row.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'short',timeStyle:'short'})}</td><td><span class="pill">${esc(row.action)}</span></td><td>${esc(row.entity_type)}</td><td>${esc(JSON.stringify(row.details||{}))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No audit events recorded yet.</div>';
}
async function initialize(){
 const config=loadConfig();
 if(!config.url||!config.key){showMessage('loginMessage','Set the Supabase URL and publishable key in WST/supabase-config.js first.');return;}
 if(!window.supabase?.createClient){showMessage('loginMessage','Supabase client could not load. Check your connection and refresh.');return;}
 client=window.supabase.createClient(config.url,config.key);
 clientConfig={url:config.url,key:config.key};
 try{
  if(authCallbackError){
   clearAuthCallback();
   const message=authCallbackErrorCode==='otp_expired'
    ?'This email link expired. Ask the Owner/Admin to select Resend invite beside your staff account, then open the newest email.'
    :authCallbackError;
   showMessage('loginMessage',message);
   return;
  }
  const {data,error}=await client.auth.getSession();
  if(error)dbError(error);
  if(data.session&&needsPasswordSetup){
   clearAuthCallback();
   showPasswordSetup();
   return;
  }
  if(data.session)await resolveSignedInUser(data.session.user);
  else if(needsPasswordSetup){
   clearAuthCallback();
   showMessage('loginMessage','This setup link is invalid or expired. Ask the Owner/Admin to send a new invite or request a password reset.');
  }
 }catch(error){showMessage('loginMessage',error.message||'Could not restore your sign-in.');}
}
$('loginForm').addEventListener('submit',onLogin);
$('passwordSetupForm').addEventListener('submit',onPasswordSetup);
$('forgotPasswordButton').addEventListener('click',onForgotPassword);
$('bootstrapForm').addEventListener('submit',onBootstrap);
$('cancelBootstrap').addEventListener('click',signOut);
$('signOutButton').addEventListener('click',signOut);
 $('menuToggle').addEventListener('click',toggleMobileNavigation);
 $('sidebarBackdrop').addEventListener('click',closeMobileNavigation);
 document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMobileNavigation();});
 window.matchMedia('(max-width: 980px)').addEventListener('change',syncMobileNavigation);
 syncMobileNavigation();
 initialize();
