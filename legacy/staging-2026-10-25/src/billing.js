// Stripe Billing integration. Server-side only: no secret is ever sent to the browser.
export const ACTIVE_STATUSES = new Set(['active','trialing']);
export function hasEntitlement(record, now=Date.now()) {
  if (!record) return false;
  if (record.beta_until && Date.parse(record.beta_until) > now) return true;
  return ACTIVE_STATUSES.has(record.stripe_status) && Number(record.current_period_end || 0) * 1000 > now;
}
export function verifySignature(payload, header, secret, now=Math.floor(Date.now()/1000)) {
  return _verifySignature(payload,header,secret,now);
}
async function _verifySignature(payload, header, secret, now) {
  if (!header || !secret) return false;
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const signatures = [...header.matchAll(/(?:^|,)\s*v1=([a-f0-9]{64})/g)].map(m=>m[1]);
  if (!t || !signatures.length || Math.abs(now-Number(t))>300) return false;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...signature].map(x=>x.toString(16).padStart(2,'0')).join('');
  return signatures.some(s=> { let diff=0;for(let i=0;i<64;i++)diff|=s.charCodeAt(i)^hex.charCodeAt(i);return diff===0; });
}
export async function stripeRequest(env, path, params, method='POST') {
  if (!env.STRIPE_SECRET_KEY) throw Error('Stripe non configuré');
  const body = new URLSearchParams(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let r;
  try {
    r = await fetch(`https://api.stripe.com/v1/${path}`,{method,headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:method==='GET'?undefined:body,signal:controller.signal});
  } catch { throw Error('Stripe API indisponible ou délai dépassé'); }
  finally { clearTimeout(timeout); }
  let data;
  try { data = await r.json(); } catch { throw Error('Stripe API: réponse invalide'); }
  if(!r.ok)throw Error('Stripe API: '+(data.error?.type||r.status));
  return data;
}
export function safeRedirectUrl(url,host) { try { const u=new URL(url);return u.protocol==='https:' && u.hostname===host; } catch { return false; } }

// Fail closed: a test staging instance must never charge a live Stripe key.
export function stripeModeReady(env) {
  const mode=env.STRIPE_MODE;
  if (mode !== 'test' && mode !== 'live') return false;
  if (env.STRIPE_LIVE_ENABLED !== 'true') return false;
  if (![env.STRIPE_PRICE_BASE,env.STRIPE_PRICE_CROISSANCE,env.STRIPE_PRICE_PRO].every(x=>x?.startsWith('price_'))) return false;
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) return false;
  const key=env.STRIPE_SECRET_KEY || '';
  if (mode === 'test') return key.startsWith('sk_test_');
  // Requires a separate positive go-live switch, not just valid credentials.
  return env.STRIPE_PRODUCTION_APPROVED === 'true' && key.startsWith('sk_live_');
}
export function stripeEventMatchesMode(event, env) {
  if (typeof event?.livemode !== 'boolean') return false;
  return event.livemode === (env.STRIPE_MODE === 'live');
}

// Strict URL allowlist for browser redirects produced by Stripe.
export function validStripeRedirect(raw, kind='checkout') {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    if (kind === 'checkout') return u.hostname === 'checkout.stripe.com';
    if (kind === 'portal') return u.hostname === 'billing.stripe.com';
    return false;
  } catch { return false; }
}

// Montants en cents CAD; quotas par mois civil UTC, créations seulement.
export const PLANS = Object.freeze({base:{name:'Essentiel',priceCents:4999,limit:50},croissance:{name:'Croissance',priceCents:8999,limit:125},pro:{name:'Pro Illimité',priceCents:11999,limit:null}});
export function resolvePlanByPrice(priceId,env){
 if(!priceId)return null;
 for(const [key,field] of [['base','STRIPE_PRICE_BASE'],['croissance','STRIPE_PRICE_CROISSANCE'],['pro','STRIPE_PRICE_PRO']])if(env[field] && env[field]===priceId && priceId.startsWith('price_'))return key;
 return null;
}
export function activePlan(record,now=Date.now()){return hasEntitlement(record,now)?(record?.plan_key && PLANS[record.plan_key] ? record.plan_key : null):null;}
export function quotePeriod(now=new Date()){return now.toISOString().slice(0,7);}
