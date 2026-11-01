/** Amounts use integer cents; rates use integer parts per million. */
export const GST_PPM = 50000;
export const QST_PPM = 99750;
export function amountCents(value){
  const s=String(value ?? '').trim().replace(',','.');
  if(!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(s)) throw new Error('Montant invalide');
  const [whole, fractional='']=s.split('.');
  return Number(whole)*100+Number((fractional+'00').slice(0,2));
}
export function calculate(items, discountCents=0, applyGst=true, applyQst=true){
  if(!Array.isArray(items)||items.length<1||items.length>100) throw new Error('Entre 1 et 100 lignes requises');
  let subtotal=0;
  const cleaned=items.map((item)=>{
    const description=String(item.description||'').trim().slice(0,250);
    const quantity=Number(item.quantity);
    const unitCents=Number(item.unitCents);
    if(!description||!Number.isSafeInteger(quantity)||quantity<1||quantity>100000||!Number.isSafeInteger(unitCents)||unitCents<0||unitCents>100000000) throw new Error('Ligne invalide');
    const lineCents=quantity*unitCents;
    if(!Number.isSafeInteger(lineCents)) throw new Error('Total de ligne trop élevé');
    subtotal+=lineCents;
    return {description,quantity,unitCents,lineCents};
  });
  if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(discountCents)||discountCents<0||discountCents>subtotal) throw new Error('Rabais invalide');
  const taxable=subtotal-discountCents;
  const gst=applyGst?Math.round(taxable*GST_PPM/1e6):0;
  const qst=applyQst?Math.round(taxable*QST_PPM/1e6):0;
  return {items:cleaned,subtotalCents:subtotal,discountCents,gstCents:gst,qstCents:qst,totalCents:taxable+gst+qst};
}
