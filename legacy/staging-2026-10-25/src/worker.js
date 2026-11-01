import {hasEntitlement,verifySignature,stripeRequest,stripeModeReady,stripeEventMatchesMode,validStripeRedirect,PLANS,resolvePlanByPrice,activePlan,quotePeriod} from './billing.js';
import {calculate} from './money.js';
import {passwordHash,verifyPassword,sha256,newToken} from './crypto.js';
const json=(x,s=200,extra={})=>new Response(JSON.stringify(x),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
const bad=(message,s=400)=>json({error:message},s);
const clean=(x,n=200)=>String(x??'').trim().slice(0,n);
const email=x=>clean(x,254).toLowerCase();
const isoDate=x=>{const v=String(x??'').trim();if(!v)return '';if(!/^\d{4}-\d{2}-\d{2}$/.test(v))throw Error('Date invalide');const [y,m,d]=v.split('-').map(Number);const a=new Date(Date.UTC(y,m-1,d));if(a.getUTCFullYear()!==y||a.getUTCMonth()+1!==m||a.getUTCDate()!==d)throw Error('Date invalide');return v;};
const originAllowed=r=>{const o=r.headers.get('origin');if(o&&o!==new URL(r.url).origin)return false;const site=r.headers.get('sec-fetch-site');return !site||site==='same-origin'||site==='none';};
// Persisted login attempt counters. Limiting both account and network helps slow guessing.
async function throttle(db,kind,key,limit,windowMs){
  const now=Date.now(), bucket=Math.floor(now/windowMs), id=await sha256(`${kind}:${key}:${bucket}`);
  await db.prepare('INSERT INTO auth_attempts(id,attempts,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1').bind(id,(bucket+1)*windowMs).run();
  const row=await db.prepare('SELECT attempts FROM auth_attempts WHERE id=?').bind(id).first();
  return (row?.attempts||0)<=limit;
}
const clientIP=r=>r.headers.get('CF-Connecting-IP')||'unknown';
const parse=async r=>{if(Number(r.headers.get('content-length')||0)>65536)throw Error('Requête trop volumineuse');const t=await r.text();if(t.length>65536)throw Error('Requête trop volumineuse');try{return JSON.parse(t||'{}');}catch{throw Error('JSON invalide');}};
function cookie(t,ttl){return `sp_session=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`;}
async function getUser(r,db){
  const token=(r.headers.get('cookie')||'').match(/(?:^|;\s*)sp_session=([a-f0-9]{64})/)?.[1];
  if(!token)return null;
  const hash=await sha256(token);
  return db.prepare('SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>?').bind(hash,Date.now()).first();
}
async function insertSession(db,userId){const token=newToken();await db.prepare('INSERT INTO sessions (id_hash,user_id,expires_at) VALUES (?,?,?)').bind(await sha256(token),userId,Date.now()+604800000).run();return token;}
// Strictly validate the v0.9 export contract before any write.
function validateBackup(b){
  const fail=()=>{throw Error('Fichier de sauvegarde invalide ou incompatible');};
  if(!b||typeof b!=='object'||b.format!=='soumission-pro-backup'||b.version!==1||!b.company||typeof b.company!=='object')fail();
  if(!Array.isArray(b.customers)||!Array.isArray(b.quotes)||!Array.isArray(b.invoices))fail();
  if(b.customers.length>500||b.quotes.length>1000||b.invoices.length>1000)fail();
  const required=(o,k,max=2000)=>{if(typeof o?.[k]!=='string'||o[k].length>max)fail();return o[k];};
  const id=(o,k)=>{const v=required(o,k,64);if(!/^[a-zA-Z0-9-]{1,64}$/.test(v))fail();return v;};
  const dt=(o,k)=>{const v=required(o,k,50);if(!/^\d{4}-\d{2}-\d{2} /.test(v))fail();return v;};
  const date=(o,k)=>{const v=required(o,k,10);try{isoDate(v);}catch{fail();}return v;};
  const cents=(o,k)=>{const n=o?.[k];if(!Number.isSafeInteger(n)||n<0||n>100000000000)fail();return n;};
  const items=o=>{const v=required(o,'items_json',100000);let arr;try{arr=JSON.parse(v);}catch{fail();}if(!Array.isArray(arr)||arr.length>100)fail();return v;};
  const ids=a=>{const set=new Set(a.map(x=>x.id));if(set.size!==a.length)fail();return set;};
  const c=b.company,company=['name','phone','address','rbq','gst','qst'].map(k=>required(c,k,k==='address'?500:200));
  for(const k of ['apply_gst','apply_qst']){if(c[k]!==0&&c[k]!==1)fail();company.push(c[k]);}
  const customers=b.customers.map(x=>({id:id(x,'id'),name:required(x,'name'),email:required(x,'email',254),phone:required(x,'phone',40),address:required(x,'address',500),created_at:dt(x,'created_at')}));
  const customerIds=ids(customers);
  const quotes=b.quotes.map(x=>{const q={id:id(x,'id'),customer_id:id(x,'customer_id'),number:required(x,'number',100),title:required(x,'title',200),status:required(x,'status',20),notes:required(x,'notes'),valid_until:date(x,'valid_until'),items_json:items(x),created_at:dt(x,'created_at'),updated_at:dt(x,'updated_at'),last_followup_at:required(x,'last_followup_at',50)};if(!customerIds.has(q.customer_id)||!['draft','sent','accepted','rejected'].includes(q.status))fail();for(const k of ['discount_cents','subtotal_cents','gst_cents','qst_cents','total_cents'])q[k]=cents(x,k);return q;});
  const quoteIds=ids(quotes);
  const invoices=b.invoices.map(x=>{const i={id:id(x,'id'),quote_id:id(x,'quote_id'),customer_id:id(x,'customer_id'),number:required(x,'number',100),status:required(x,'status',20),due_date:date(x,'due_date'),items_json:items(x),created_at:dt(x,'created_at')};if(!quoteIds.has(i.quote_id)||!customerIds.has(i.customer_id)||!['unpaid','paid','void'].includes(i.status))fail();const q=quotes.find(q=>q.id===i.quote_id);if(q.customer_id!==i.customer_id)fail();for(const k of ['subtotal_cents','discount_cents','gst_cents','qst_cents','total_cents'])i[k]=cents(x,k);return i;});
  ids(invoices);
  if(new Set(quotes.map(x=>x.number)).size!==quotes.length||new Set(invoices.map(x=>x.number)).size!==invoices.length||new Set(invoices.map(x=>x.quote_id)).size!==invoices.length)fail();
  return {company,customers,quotes,invoices};
}
async function route(r,env){
  const db=env.DB; if(!db)return bad('Base de données Cloudflare D1 non configurée',503);
  if(!originAllowed(r) && new URL(r.url).pathname!=='/api/stripe/webhook')return bad('Origine refusée',403);
  const url=new URL(r.url),path=url.pathname,method=r.method;
  if(!['GET','POST','PUT','DELETE'].includes(method))return bad('Méthode non autorisée',405);
  if(method!=='GET' && path!=='/api/stripe/webhook' && r.headers.get('content-type')?.split(';')[0]!=='application/json')return bad('Content-Type JSON requis',415);
  if(path==='/api/health'&&method==='GET')return json({ok:true,version:'2.0.0'});
  // Readiness proves a real DB query works; it never discloses schema or secrets.
  if(path==='/api/ready'&&method==='GET'){
    try{const result=await db.prepare('SELECT 1 AS ready').first();
      if(result?.ready!==1)return bad('Base de données indisponible',503);
      return json({ok:true,version:'2.0.0',database:'reachable'});
    }catch{return bad('Base de données indisponible',503);}
  }
  if(path==='/api/stripe/webhook'&&method==='POST'){
    const raw=await r.text();if(raw.length>100000)return bad('Évènement trop volumineux',413);
    if(!await verifySignature(raw,r.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET))return bad('Signature Stripe invalide',400);
    let evt;try{evt=JSON.parse(raw);}catch{return bad('JSON invalide');}
    if(typeof evt.id!=='string'||!/^evt_[a-zA-Z0-9]+$/.test(evt.id))return bad('Évènement invalide');
    if(!stripeModeReady(env)||!stripeEventMatchesMode(evt,env))return bad('Environnement Stripe incompatible',503);
    // Only subscription lifecycle events have the authority to change entitlements.
    const allowed=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'];
    if(!allowed.includes(evt.type))return json({received:true,ignored:true});
    const sub=evt.data?.object;
    if(!sub||typeof sub.id!=='string'||typeof sub.customer!=='string')return bad('Abonnement invalide');
    const account=await db.prepare('SELECT user_id FROM billing_accounts WHERE stripe_customer_id=?').bind(sub.customer).first();
    if(!account)return bad('Client Stripe non reconnu',409);
    const status=String(sub.status||'none');
    const periodEnd=Number(sub.current_period_end||sub.items?.data?.[0]?.current_period_end||0);
    const statements=[db.prepare('INSERT OR IGNORE INTO stripe_webhook_events(id) VALUES (?)').bind(evt.id)];
    const exists=await db.prepare('SELECT id FROM stripe_webhook_events WHERE id=?').bind(evt.id).first();
    if(exists)return json({received:true,duplicate:true});
    // Retrieve authoritative latest subscription state to avoid delayed/out-of-order events.
    if(!stripeModeReady(env))return bad('Stripe non configuré',503);
    let latest;
    try{latest=await stripeRequest(env,`subscriptions/${encodeURIComponent(sub.id)}`,{},'GET');}
    catch(e){if(evt.type==='customer.subscription.deleted')latest=sub;else return bad('Synchronisation Stripe indisponible',503);}
    if(latest.customer!==sub.customer)return bad('Client Stripe incohérent',409);
    const priceIds=latest.items?.data?.map(item=>item.price?.id).filter(Boolean)||[];
    const planKeys=priceIds.map(id=>resolvePlanByPrice(id,env));
    if(planKeys.length!==1||!planKeys[0])return bad('Tarif Stripe non autorisé',409);
    const planKey=planKeys[0];
    const latestStatus=String(latest.status||status);
    if(!['active','trialing','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(latestStatus))return bad('État Stripe inconnu',409);
    const latestEnd=Number(latest.current_period_end||latest.items?.data?.[0]?.current_period_end||periodEnd);
    statements.push(db.prepare("UPDATE billing_accounts SET stripe_subscription_id=?, stripe_status=?,current_period_end=?,plan_key=?,updated_at=datetime('now') WHERE user_id=? AND stripe_customer_id=?").bind(latest.id,latestStatus,latestEnd,planKey,account.user_id,sub.customer));
    await db.batch(statements);
    return json({received:true});
  }
  if(path==='/api/register'&&method==='POST'){
    if(env.REGISTRATION_ENABLED!=='true')return bad('Inscriptions temporairement fermées : bêta privée.',403);
    const b=await parse(r),e=email(b.email),p=b.password;
    if(!await throttle(db,'register-ip',clientIP(r),8,3600000))return bad('Trop de tentatives. Réessaie plus tard.',429);
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))return bad('Courriel invalide');
    const hashed=await passwordHash(p),id=crypto.randomUUID(),companyId=crypto.randomUUID();
    try{await db.batch([db.prepare('INSERT INTO users(id,email,password_hash) VALUES (?,?,?)').bind(id,e,hashed),db.prepare('INSERT INTO companies(id,owner_id) VALUES (?,?)').bind(companyId,id)]);}catch{return bad('Compte impossible à créer (courriel déjà utilisé ou erreur serveur)',409);}
    const token=await insertSession(db,id);return json({user:{id,email:e}},201,{'set-cookie':cookie(token,604800)});
  }
  if(path==='/api/login'&&method==='POST'){
    const b=await parse(r),e=email(b.email);
    if(!await throttle(db,'login-ip',clientIP(r),25,900000)||!await throttle(db,'login-email',e,8,900000))return bad('Trop de tentatives. Réessaie dans 15 minutes.',429);
    const u=await db.prepare('SELECT * FROM users WHERE email=?').bind(e).first();
    if(!u||!await verifyPassword(b.password,u.password_hash))return bad('Identifiants invalides',401);
    const token=await insertSession(db,u.id);return json({user:{id:u.id,email:u.email}},200,{'set-cookie':cookie(token,604800)});
  }
  const user=await getUser(r,db);if(!user)return bad('Connexion requise',401);
  if(path==='/api/logout'&&method==='POST'){
    const token=(r.headers.get('cookie')||'').match(/sp_session=([a-f0-9]{64})/)?.[1];
    if(token)await db.prepare('DELETE FROM sessions WHERE id_hash=? AND user_id=?').bind(await sha256(token),user.id).run();
    return json({ok:true},200,{'set-cookie':cookie('',0)});
  }
  if(path==='/api/me'&&method==='GET')return json({user});
  const billing=await db.prepare('SELECT * FROM billing_accounts WHERE user_id=?').bind(user.id).first();
  const entitled=hasEntitlement(billing) && (Boolean(activePlan(billing)) || (billing?.beta_until && Date.parse(billing.beta_until)>Date.now()));
  const currentPlan=activePlan(billing);
  if(path==='/api/billing/status'&&method==='GET'){
    const month=quotePeriod();
    const used=(await db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE owner_id=? AND substr(created_at,1,7)=?").bind(user.id,month).first())?.n||0;
    return json({enabled:stripeModeReady(env),plans:Object.entries(PLANS).map(([id,p])=>({id,...p})),plan:currentPlan,period:month,used,limit:currentPlan?PLANS[currentPlan].limit:null,currency:'CAD',interval:'month',status:billing?.stripe_status||'none',betaUntil:billing?.beta_until||null,access:entitled,enforced:env.BILLING_ENFORCEMENT==='true'});
  }
  if(path==='/api/resources/guide'&&method==='GET'){
    if(currentPlan!=='pro' && !(billing?.beta_until && Date.parse(billing.beta_until)>Date.now()))return bad('Guide réservé au forfait Pro',403);
    const {guideHtml}=await import('./guide.js');return new Response(guideHtml,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
  }
  if(path==='/api/billing/checkout'&&method==='POST'){
    if(!stripeModeReady(env))return bad('Paiements désactivés',503);
    if(!await throttle(db,'billing-checkout',user.id,10,3600000))return bad('Trop de tentatives',429);
    if(entitled)return bad('Accès déjà actif. Pour changer de forfait, utilise le portail de facturation.',409);
    const wanted=(await parse(r)).plan;
    if(!PLANS[wanted])return bad('Forfait invalide',400);
    const priceField={base:'STRIPE_PRICE_BASE',croissance:'STRIPE_PRICE_CROISSANCE',pro:'STRIPE_PRICE_PRO'}[wanted];
    const priceId=env[priceField];if(!priceId?.startsWith('price_'))return bad('Tarif de ce forfait non configuré',503);
    let customerId=billing?.stripe_customer_id;
    if(!customerId){
      const c=await stripeRequest(env,'customers',{email:user.email,'metadata[user_id]':user.id});customerId=c.id;
      await db.prepare('INSERT INTO billing_accounts(user_id,stripe_customer_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=COALESCE(billing_accounts.stripe_customer_id,excluded.stripe_customer_id)').bind(user.id,customerId).run();
      customerId=(await db.prepare('SELECT stripe_customer_id FROM billing_accounts WHERE user_id=?').bind(user.id).first()).stripe_customer_id;
    }
    const base=new URL(r.url).origin;
    const session=await stripeRequest(env,'checkout/sessions',{
      mode:'subscription',customer:customerId,'line_items[0][price]':priceId,'line_items[0][quantity]':'1',success_url:`${base}/?checkout=success`,cancel_url:`${base}/?checkout=cancel`,client_reference_id:user.id
    });
    if (!validStripeRedirect(session.url,'checkout')) return bad('Destination Stripe inattendue',502);
    return json({url:session.url});
  }
  if(path==='/api/billing/portal'&&method==='POST'){
    if(!billing?.stripe_customer_id||!stripeModeReady(env))return bad('Compte Stripe absent ou Stripe désactivé',503);
    const session=await stripeRequest(env,'billing_portal/sessions',{customer:billing.stripe_customer_id,return_url:new URL(r.url).origin});
    if (!validStripeRedirect(session.url,'portal')) return bad('Destination Stripe inattendue',502);
    return json({url:session.url});
  }
  // Do not lock existing production clients by surprise: opt into enforcement only after staging and beta grants are checked.
  if(env.BILLING_ENFORCEMENT==='true'&&!entitled && !['/api/export','/api/logout','/api/me'].includes(path))return bad('Abonnement ou accès bêta requis',402);
  // Portable user-owned backup. Does not include credentials, sessions or other accounts.
  if(path==='/api/export'&&method==='GET'){
    const company=await db.prepare('SELECT name,phone,address,rbq,gst,qst,apply_gst,apply_qst FROM companies WHERE owner_id=?').bind(user.id).first();
    const customers=(await db.prepare('SELECT id,name,email,phone,address,created_at FROM customers WHERE owner_id=? ORDER BY created_at').bind(user.id).all()).results;
    const quotes=(await db.prepare('SELECT id,customer_id,number,title,status,notes,valid_until,discount_cents,subtotal_cents,gst_cents,qst_cents,total_cents,items_json,created_at,updated_at,last_followup_at FROM quotes WHERE owner_id=? ORDER BY created_at').bind(user.id).all()).results;
    const invoices=(await db.prepare('SELECT id,quote_id,customer_id,number,due_date,status,subtotal_cents,discount_cents,gst_cents,qst_cents,total_cents,items_json,created_at FROM invoices WHERE owner_id=? ORDER BY created_at').bind(user.id).all()).results;
    return json({format:'soumission-pro-backup',version:1,exportedAt:new Date().toISOString(),company,customers,quotes,invoices},200,{'content-disposition':'attachment; filename="soumission-pro-sauvegarde.json"'});
  }
  // Preview uses the exact same validator as restoration, but writes nothing.
  // Counts are always checked server-side; browser-side checks are only convenience.
  if(path==='/api/restore/preview'&&method==='POST'){
    const b=await parse(r);
    let data;
    try{data=validateBackup(b.backup);}catch(e){return bad(e.message);}
    const existing=await Promise.all(['customers','quotes','invoices'].map(t=>db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE owner_id=?`).bind(user.id).first()));
    return json({valid:true,canRestore:existing.every(x=>x.n===0),reason:existing.some(x=>x.n>0)?'Cet espace contient déjà des dossiers. La restauration est bloquée.':null,
      companyName:data.company[0],counts:{customers:data.customers.length,quotes:data.quotes.length,invoices:data.invoices.length}});
  }
  // Restore into an empty account ONLY. A single D1 batch guarantees atomicity.
  // No cross-account deletions, no credentials, no sessions, no overwritten records.
  if(path==='/api/restore'&&method==='POST'){
    const b=await parse(r);
    if(b.confirm!=='RESTORE_TO_EMPTY_ACCOUNT')return bad('Confirmation de restauration requise');
    const backup=b.backup;
    let data;
    try{data=validateBackup(backup);}catch(e){return bad(e.message);}
    const existing=await Promise.all(['customers','quotes','invoices'].map(t=>db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE owner_id=?`).bind(user.id).first()));
    if(existing.some(x=>x.n>0))return bad('Restauration possible uniquement dans un compte sans clients, soumissions ni factures.',409);
    const customerMap=new Map(data.customers.map(c=>[c.id,crypto.randomUUID()]));
    const quoteMap=new Map(data.quotes.map(q=>[q.id,crypto.randomUUID()]));
    const statements=[db.prepare('UPDATE companies SET name=?,phone=?,address=?,rbq=?,gst=?,qst=?,apply_gst=?,apply_qst=? WHERE owner_id=?').bind(...data.company,user.id)];
    for(const c of data.customers)statements.push(db.prepare('INSERT INTO customers(id,owner_id,name,email,phone,address,created_at) VALUES (?,?,?,?,?,?,?)').bind(customerMap.get(c.id),user.id,c.name,c.email,c.phone,c.address,c.created_at));
    for(const q of data.quotes)statements.push(db.prepare('INSERT INTO quotes(id,owner_id,customer_id,number,title,status,notes,valid_until,discount_cents,subtotal_cents,gst_cents,qst_cents,total_cents,items_json,created_at,updated_at,last_followup_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(quoteMap.get(q.id),user.id,customerMap.get(q.customer_id),q.number,q.title,q.status,q.notes,q.valid_until,q.discount_cents,q.subtotal_cents,q.gst_cents,q.qst_cents,q.total_cents,q.items_json,q.created_at,q.updated_at,q.last_followup_at));
    for(const i of data.invoices)statements.push(db.prepare('INSERT INTO invoices(id,owner_id,quote_id,customer_id,number,status,due_date,subtotal_cents,discount_cents,gst_cents,qst_cents,total_cents,items_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),user.id,quoteMap.get(i.quote_id),customerMap.get(i.customer_id),i.number,i.status,i.due_date,i.subtotal_cents,i.discount_cents,i.gst_cents,i.qst_cents,i.total_cents,i.items_json,i.created_at));
    try{await db.batch(statements);}catch{return bad('Restauration annulée intégralement (conflit ou base de données).',409);}
    return json({ok:true,restored:{customers:data.customers.length,quotes:data.quotes.length,invoices:data.invoices.length}});
  }
  if(path==='/api/company'){
    if(method==='GET')return json({company:await db.prepare('SELECT name,phone,address,rbq,gst,qst,apply_gst,apply_qst FROM companies WHERE owner_id=?').bind(user.id).first()});
    if(method==='PUT'){
      const b=await parse(r);await db.prepare('UPDATE companies SET name=?,phone=?,address=?,rbq=?,gst=?,qst=?,apply_gst=?,apply_qst=? WHERE owner_id=?').bind(clean(b.name),clean(b.phone,40),clean(b.address,500),clean(b.rbq,40),clean(b.gst,40),clean(b.qst,40),b.apply_gst?1:0,b.apply_qst?1:0,user.id).run();return json({ok:true});
    }
  }
  if(path==='/api/customers'){
    if(method==='GET')return json({customers:(await db.prepare('SELECT * FROM customers WHERE owner_id=? ORDER BY created_at DESC').bind(user.id).all()).results});
    if(method==='POST'){
      const b=await parse(r),name=clean(b.name);if(!name)return bad('Nom requis');const id=crypto.randomUUID();await db.prepare('INSERT INTO customers(id,owner_id,name,email,phone,address) VALUES (?,?,?,?,?,?)').bind(id,user.id,name,email(b.email),clean(b.phone,40),clean(b.address,500)).run();return json({id},201);
    }
  }
  const customerId=path.match(/^\/api\/customers\/([a-zA-Z0-9-]+)$/)?.[1];
  if(customerId){
    if(method==='PUT'){const b=await parse(r),name=clean(b.name);if(!name)return bad('Nom requis');const x=await db.prepare('UPDATE customers SET name=?,email=?,phone=?,address=? WHERE id=? AND owner_id=?').bind(name,email(b.email),clean(b.phone,40),clean(b.address,500),customerId,user.id).run();return x.meta.changes?json({ok:true}):bad('Client introuvable',404);}
    if(method==='DELETE'){try{const x=await db.prepare('DELETE FROM customers WHERE id=? AND owner_id=?').bind(customerId,user.id).run();return x.meta.changes?json({ok:true}):bad('Client introuvable',404);}catch{return bad('Client lié à une soumission; suppression impossible',409);}}
  }
  if(path==='/api/quotes'){
    if(method==='GET'){
      const quotes=(await db.prepare('SELECT q.*,c.name AS customer_name FROM quotes q JOIN customers c ON c.id=q.customer_id AND c.owner_id=q.owner_id WHERE q.owner_id=? ORDER BY q.created_at DESC').bind(user.id).all()).results;
      return json({quotes:quotes.map(q=>({...q,items:JSON.parse(q.items_json),items_json:undefined}))});
    }
    if(method==='POST'){
      const b=await parse(r),customer=await db.prepare('SELECT id FROM customers WHERE id=? AND owner_id=?').bind(clean(b.customerId,64),user.id).first();
      if(!customer)return bad('Client introuvable');
      const company=await db.prepare('SELECT apply_gst,apply_qst FROM companies WHERE owner_id=?').bind(user.id).first();
      const calc=calculate(b.items,Number(b.discountCents||0),!!company.apply_gst,!!company.apply_qst);
      const id=crypto.randomUUID(),num='SP-'+Date.now().toString(36).toUpperCase()+'-'+id.slice(0,4).toUpperCase();
      const title=clean(b.title);if(!title)return bad('Titre requis');
      const month=quotePeriod(),limit=currentPlan?PLANS[currentPlan].limit:null;
      const statement=limit!==null && env.BILLING_ENFORCEMENT==='true' ?
        db.prepare(`INSERT INTO quotes(id,owner_id,customer_id,number,title,notes,valid_until,discount_cents,subtotal_cents,gst_cents,qst_cents,total_cents,items_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM quotes WHERE owner_id=? AND substr(created_at,1,7)=?)<?`).bind(id,user.id,customer.id,num,title,clean(b.notes,2000),isoDate(b.validUntil),calc.discountCents,calc.subtotalCents,calc.gstCents,calc.qstCents,calc.totalCents,JSON.stringify(calc.items),user.id,month,limit) :
        db.prepare(`INSERT INTO quotes(id,owner_id,customer_id,number,title,notes,valid_until,discount_cents,subtotal_cents,gst_cents,qst_cents,total_cents,items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,user.id,customer.id,num,title,clean(b.notes,2000),isoDate(b.validUntil),calc.discountCents,calc.subtotalCents,calc.gstCents,calc.qstCents,calc.totalCents,JSON.stringify(calc.items));
      const result=await statement.run();
      if(!result.meta?.changes)return bad('Limite mensuelle de soumissions atteinte. Passe au forfait supérieur.',402);
      return json({id,number:num},201);
    }
  }
  // Avenants / extras : toujours liés à une soumission du propriétaire.
  // Le statut « approuvé » est une consignation manuelle d'une approbation externe,
  // et non une signature électronique ou une approbation automatique du client.
  if(path==='/api/extras'&&method==='GET'){
    if(currentPlan!=='pro' && env.BILLING_ENFORCEMENT==='true')return bad('Fonction réservée au forfait Pro',403);
    const extras=(await db.prepare('SELECT e.* FROM quote_extras e JOIN quotes q ON q.id=e.quote_id AND q.owner_id=e.owner_id WHERE e.owner_id=? ORDER BY e.created_at DESC').bind(user.id).all()).results;
    return json({extras});
  }
  if(path==='/api/extras'&&method==='POST'){
    if(currentPlan!=='pro' && env.BILLING_ENFORCEMENT==='true')return bad('Fonction réservée au forfait Pro',403);
    const b=await parse(r);
    const quote=await db.prepare('SELECT id,status FROM quotes WHERE id=? AND owner_id=?').bind(clean(b.quoteId,64),user.id).first();
    if(!quote)return bad('Soumission introuvable',404);
    const description=clean(b.description,500),reason=clean(b.reason,1000);
    if(!description)return bad('Description requise',400);
    const labour=Number(b.labourCents),materials=Number(b.materialsCents),other=Number(b.otherCents),margin=Number(b.marginPercent);
    if(![labour,materials,other].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1000000000)||!Number.isFinite(margin)||margin<0||margin>=100||Math.round(margin*100)!==margin*100)return bad('Coûts ou marge invalides',400);
    const cost=labour+materials+other;
    if(cost<=0)return bad('Au moins un coût est requis',400);
    const sale=Math.round(cost/(1-margin/100));
    if(!Number.isSafeInteger(sale)||sale>100000000000)return bad('Montant trop élevé',400);
    const id=crypto.randomUUID();
    await db.prepare('INSERT INTO quote_extras(id,owner_id,quote_id,description,reason,labour_cents,materials_cents,other_cents,margin_percent,cost_cents,price_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,user.id,quote.id,description,reason,labour,materials,other,margin,cost,sale).run();
    return json({id,status:'pending',costCents:cost,priceCents:sale},201);
  }
  const extraId=path.match(/^\/api\/extras\/([a-zA-Z0-9-]+)$/)?.[1];
  if(extraId){
    if(currentPlan!=='pro' && env.BILLING_ENFORCEMENT==='true')return bad('Fonction réservée au forfait Pro',403);
    const extra=await db.prepare('SELECT e.* FROM quote_extras e JOIN quotes q ON q.id=e.quote_id AND q.owner_id=e.owner_id WHERE e.id=? AND e.owner_id=?').bind(extraId,user.id).first();
    if(!extra)return bad('Extra introuvable',404);
    if(method==='PUT'){
      const b=await parse(r),status=clean(b.status,20);
      if(!['approved','rejected'].includes(status))return bad('Statut invalide',400);
      if(extra.status!=='pending')return bad('Un extra finalisé ne peut être modifié',409);
      const evidence=clean(b.approvalEvidence,1000);
      if(status==='approved' && evidence.length<10)return bad('Consigne la référence de l’approbation écrite du client (10 caractères minimum)',400);
      const result=await db.prepare("UPDATE quote_extras SET status=?,approval_evidence=?,decided_at=datetime('now') WHERE id=? AND owner_id=? AND status='pending'").bind(status,evidence,extraId,user.id).run();
      if(!result.meta.changes)return bad('Extra déjà traité',409);
      return json({ok:true,status});
    }
    if(method==='DELETE'){
      if(extra.status!=='pending')return bad('Seuls les extras en attente peuvent être supprimés',409);
      await db.prepare("DELETE FROM quote_extras WHERE id=? AND owner_id=? AND status='pending'").bind(extraId,user.id).run();
      return json({ok:true});
    }
  }
  if(path==='/api/invoices'&&method==='GET'){
    const invoices=(await db.prepare(`SELECT i.*,q.title,q.number AS quote_number,c.name AS customer_name FROM invoices i JOIN quotes q ON q.id=i.quote_id AND q.owner_id=i.owner_id JOIN customers c ON c.id=i.customer_id AND c.owner_id=i.owner_id WHERE i.owner_id=? ORDER BY i.created_at DESC`).bind(user.id).all()).results;
    return json({invoices});
  }
  const convert=path.match(/^\/api\/quotes\/([a-zA-Z0-9-]+)\/invoice$/)?.[1];
  if(convert&&method==='POST'){
    const q=await db.prepare('SELECT * FROM quotes WHERE id=? AND owner_id=?').bind(convert,user.id).first();
    if(!q)return bad('Soumission introuvable',404);
    if(q.status!=='accepted')return bad('Seule une soumission acceptée peut devenir une facture',409);
    const existing=await db.prepare('SELECT id,number FROM invoices WHERE quote_id=? AND owner_id=?').bind(q.id,user.id).first();
    if(existing)return json({invoice:existing,alreadyExists:true});
    const b=await parse(r),dueDate=isoDate(b.dueDate);
    const id=crypto.randomUUID(),number='FAC-'+Date.now().toString(36).toUpperCase()+'-'+id.slice(0,6).toUpperCase();
    try{
      await db.prepare(`INSERT INTO invoices(id,owner_id,quote_id,customer_id,number,due_date,subtotal_cents,discount_cents,gst_cents,qst_cents,total_cents,items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,user.id,q.id,q.customer_id,number,dueDate,q.subtotal_cents,q.discount_cents,q.gst_cents,q.qst_cents,q.total_cents,q.items_json).run();
    }catch(e){const x=await db.prepare('SELECT id,number FROM invoices WHERE quote_id=? AND owner_id=?').bind(q.id,user.id).first();if(x)return json({invoice:x,alreadyExists:true});throw e;}
    return json({invoice:{id,number}},201);
  }
  const followup=path.match(/^\/api\/quotes\/([a-zA-Z0-9-]+)\/followup$/)?.[1];
  if(followup&&method==='POST'){
    const q=await db.prepare('SELECT id,status FROM quotes WHERE id=? AND owner_id=?').bind(followup,user.id).first();
    if(!q)return bad('Soumission introuvable',404);
    if(q.status!=='sent')return bad('Relance réservée aux soumissions envoyées',409);
    await db.prepare("UPDATE quotes SET last_followup_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND owner_id=? AND status='sent'").bind(followup,user.id).run();
    return json({ok:true});
  }
  const quoteId=path.match(/^\/api\/quotes\/([a-zA-Z0-9-]+)$/)?.[1];
  if(quoteId){
    const q=await db.prepare('SELECT * FROM quotes WHERE id=? AND owner_id=?').bind(quoteId,user.id).first();if(!q)return bad('Soumission introuvable',404);
    if(method==='DELETE'){if(await db.prepare('SELECT id FROM invoices WHERE quote_id=? AND owner_id=?').bind(q.id,user.id).first())return bad('Une facture est liée à cette soumission',409);await db.prepare('DELETE FROM quotes WHERE id=? AND owner_id=?').bind(quoteId,user.id).run();return json({ok:true});}
    if(method==='PUT'){
      const b=await parse(r);
      if(b.status!==undefined){
        const status=clean(b.status,20);if(!['draft','sent','accepted','rejected'].includes(status))return bad('Statut invalide');
        if(status!==q.status&&q.status==='accepted'&&(await db.prepare('SELECT id FROM invoices WHERE quote_id=? AND owner_id=?').bind(q.id,user.id).first()))return bad('Facture émise : statut verrouillé',409);
        await db.prepare("UPDATE quotes SET status=?,updated_at=datetime('now') WHERE id=? AND owner_id=?").bind(status,quoteId,user.id).run();return json({ok:true});
      }
      if(q.status!=='draft')return bad('Seuls les brouillons peuvent être modifiés',409);
      const customer=await db.prepare('SELECT id FROM customers WHERE id=? AND owner_id=?').bind(clean(b.customerId,64),user.id).first();if(!customer)return bad('Client introuvable');
      const company=await db.prepare('SELECT apply_gst,apply_qst FROM companies WHERE owner_id=?').bind(user.id).first();
      const calc=calculate(b.items,Number(b.discountCents||0),!!company.apply_gst,!!company.apply_qst);
      const title=clean(b.title);if(!title)return bad('Titre requis');
      await db.prepare("UPDATE quotes SET customer_id=?,title=?,notes=?,valid_until=?,discount_cents=?,subtotal_cents=?,gst_cents=?,qst_cents=?,total_cents=?,items_json=?,updated_at=datetime('now') WHERE id=? AND owner_id=? AND status='draft'").bind(customer.id,title,clean(b.notes,2000),isoDate(b.validUntil),calc.discountCents,calc.subtotalCents,calc.gstCents,calc.qstCents,calc.totalCents,JSON.stringify(calc.items),quoteId,user.id).run();
      return json({ok:true});
    }
  }
  return bad('Route inconnue',404);
}
export default {async fetch(request,env){try{const url=new URL(request.url);if(url.pathname.startsWith('/api/'))return await route(request,env);if(!env.ASSETS)return new Response('Assets indisponibles',{status:503});
  const result=await env.ASSETS.fetch(request);const h=new Headers(result.headers);
  h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','strict-origin-when-cross-origin');
  h.set('X-Frame-Options','DENY');h.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
  return new Response(result.body,{status:result.status,statusText:result.statusText,headers:h});}catch(e){const allowed=['Montant invalide','Rabais invalide','Ligne invalide','Entre 1 et 100 lignes requises','Mot de passe : 12 à 200 caractères','Total de ligne trop élevé','Requête trop volumineuse','Date invalide','JSON invalide'];return bad(allowed.includes(e.message)?e.message:'Erreur serveur',allowed.includes(e.message)?400:500);}}};
