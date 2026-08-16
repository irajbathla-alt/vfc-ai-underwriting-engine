function vfcPureStoredTotals_(row) {
  if(row.opening===null||row.closing===null||row.deposits===null||row.withdrawals===null) return {ok:false};
  const diff=Math.abs((row.opening+row.deposits-row.withdrawals)-row.closing);
  if(diff>VFC_BANK_ENGINE.RECONCILE_TOLERANCE) return {ok:false,diff:diff};
  return {ok:true,opening:row.opening,closing:row.closing,deposits:row.deposits,withdrawals:row.withdrawals,diff:diff,source:'PDF_SUMMARY_RECONCILED'};
}

function vfcPureVerifiedTotals_(h,row) {
  const choices=[];
  const extracted={opening:vfcPureNullableNumber_(h.openingBalance),closing:vfcPureNullableNumber_(h.closingBalance),deposits:vfcPureNullableNumber_(h.totalDeposits),withdrawals:vfcPureNullableNumber_(h.totalWithdrawals)};
  if(extracted.opening!==null&&extracted.closing!==null&&extracted.deposits!==null&&extracted.withdrawals!==null) choices.push(Object.assign({source:'EXTRACTED_HEADER'},extracted));
  if(row.opening!==null&&row.closing!==null&&extracted.deposits!==null&&extracted.withdrawals!==null) choices.push({source:'EXTRACTED_TOTALS_STORED_BALANCES',opening:row.opening,closing:row.closing,deposits:extracted.deposits,withdrawals:extracted.withdrawals});
  let best=null;
  choices.forEach(function(c){const diff=Math.abs((c.opening+c.deposits-c.withdrawals)-c.closing);if(diff<=VFC_BANK_ENGINE.RECONCILE_TOLERANCE&&(!best||diff<best.diff))best=Object.assign({ok:true,diff:diff},c);});
  return best||{ok:false};
}

function vfcPurePayloadUsable_(p, recent) {
  if(!p) return false;
  // Accept both v2 frozen facts and the current v1 cache so deployment does not re-read the same PDFs.
  const versionOk = p.extractionVersion===VFC_BANK_ENGINE.FACTS_VERSION || p.modelVersion==='VFC-BANKING-PURE-1.0' || p.version===1 || p.version===2;
  if(!versionOk) return false;
  if(!(vfcPurePositive_(p.totalDeposits)>0) || !(vfcPurePositive_(p.totalWithdrawals)>=0)) return false;
  if(recent && !p.transactionsVerified) return false;
  return true;
}

function vfcPurePayloadScore_(p) { return p ? (100 + ((p.transactions||[]).length*2) + (p.transactionsVerified?50:0)) : 0; }

function vfcPureParseCache_(s) {
  s=String(s||'');
  const prefixes=[VFC_BANK_ENGINE.CACHE_PREFIX].concat(VFC_BANK_ENGINE.LEGACY_CACHE_PREFIXES||[]);
  for(let i=0;i<prefixes.length;i++) {
    const prefix=prefixes[i];
    if(s.indexOf(prefix)!==0) continue;
    try{return JSON.parse(s.slice(prefix.length));}catch(e){return null;}
  }
  return null;
}

/* ------------------------- regression / repeatability ------------------------- */

/**
 * Saves a deterministic approved result fingerprint for a company/period/bank.
 * Run this once after an RBC case is approved. TD/BMO/etc. rule changes cannot silently alter it.
 */
function lockBankRegressionBaseline(companyName, period, bankId) {
  bankId=String(bankId||'RBC').toUpperCase();
  const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});
  if(!result.ok) throw new Error((result.errors||[]).join(' | '));

  const ss=SpreadsheetApp.getActiveSpreadsheet();
  let sh=ss.getSheetByName('BANK_REGRESSION_LOCKS');
  if(!sh) {
    sh=ss.insertSheet('BANK_REGRESSION_LOCKS');
    sh.appendRow(['Company Name','Period','Bank','Result Fingerprint','Gross Monthly Deposits','Operating Monthly Deposits','Confirmed Monthly Debt','Financing Credits','Rules Version','Locked At']);
    sh.setFrozenRows(1);
  }

  const values=sh.getDataRange().getValues();
  let rowNum=0;
  for(let i=1;i<values.length;i++) {
    if(vfcPureSame_(values[i][0],companyName)&&vfcPureSame_(values[i][1],period)&&vfcPureSame_(values[i][2],bankId)){rowNum=i+1;break;}
  }
  const bf=result.bankingFeatures||{};
  const row=[companyName,period,bankId,result.resultFingerprint,bf.averageMonthlyDeposits||0,bf.estimatedOperatingMonthlyDeposits||0,bf.existingMonthlyDebtService||0,bf.detectedFinancingCredits||0,VFC_BANK_ENGINE.RULES_VERSION,new Date()];
  if(rowNum) sh.getRange(rowNum,1,1,row.length).setValues([row]); else sh.appendRow(row);
  return {ok:true,locked:true,companyName:companyName,period:period,bank:bankId,resultFingerprint:result.resultFingerprint};
}

function verifyBankRegressionBaseline(companyName, period, bankId) {
  bankId=String(bankId||'RBC').toUpperCase();
  const result=refreshDebtSignalsForPeriodSafe({companyName:companyName,period:period});
  if(!result.ok) return result;
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('BANK_REGRESSION_LOCKS');
  if(!sh||sh.getLastRow()<2) return {ok:false,error:'No regression baseline is locked.'};
  const values=sh.getDataRange().getValues();
  for(let i=1;i<values.length;i++) {
    if(vfcPureSame_(values[i][0],companyName)&&vfcPureSame_(values[i][1],period)&&vfcPureSame_(values[i][2],bankId)) {
      const expected=String(values[i][3]||'');
      return {ok:true,match:expected===result.resultFingerprint,expectedFingerprint:expected,actualFingerprint:result.resultFingerprint,companyName:companyName,period:period,bank:bankId};
    }
  }
  return {ok:false,error:'No matching regression baseline is locked.'};
}

function vfcPureResultFingerprint_(features) {
  const d=features.debtProfile||{};
  const canonical={
    statementCount:features.statementCount||0,
    totalDeposits:vfcPureRound_(features.totalDeposits||0,.01),
    averageMonthlyDeposits:vfcPureRound_(features.averageMonthlyDeposits||0,.01),
    estimatedOperatingMonthlyDeposits:vfcPureRound_(features.estimatedOperatingMonthlyDeposits||0,.01),
    detectedFinancingCredits:vfcPureRound_(features.detectedFinancingCredits||0,.01),
    existingMonthlyDebtService:vfcPureRound_(features.existingMonthlyDebtService||0,.01),
    informationalRecurringMonthlyObligations:vfcPureRound_(features.informationalRecurringMonthlyObligations||0,.01),
    debt:(d.activeDebtObligations||[]).map(function(x){return [x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),
    info:(d.otherRecurringObligations||[]).map(function(x){return [x.entityKey,x.monthlyEquivalent,x.frequency,x.paymentAmount,x.lastSeen];}),
    financing:(d.financingCredits||[]).map(function(x){return [x.date,x.amount,x.description];})
  };
  return vfcPureDigest_(JSON.stringify(canonical));
}

/* ------------------------- helpers ------------------------- */

function vfcPureBaseFeatures_(companyName,period){
  if(typeof buildPowerFeatures_==='function') return buildPowerFeatures_(companyName,period);
  if(typeof buildFeaturesForCase_==='function') return buildFeaturesForCase_(companyName,period);
  return null;
}
function vfcPureRequest_(a,p){if(a&&typeof a==='object')return{companyName:String(a.companyName||'').trim(),period:String(a.period||p||'').trim()};return{companyName:String(a||'').trim(),period:String(p||'').trim()};}
function vfcPureStatementKey_(r){const s=vfcPureIso_(r.startDate),e=vfcPureIso_(r.endDate);return (s&&e?(s+'|'+e):String(r.fileName||'').toLowerCase().trim())+'|'+String(r.bank||'').toLowerCase().trim();}
function vfcPureHeader_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcPureSame_(a,b){return String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();}
function vfcPureNumber_(v){const n=Number(String(v==null?'':v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0;}
function vfcPureNullableNumber_(v){if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}
function vfcPurePositive_(v){return Math.max(0,vfcPureNumber_(v));}
function vfcPureBool_(v){return /^(true|yes|y|1)$/i.test(String(v||'').trim())||/negative/i.test(String(v||''));}
function vfcPureRound_(v,step){step=step||.01;return Math.round((v+Number.EPSILON)/step)*step;}
function vfcPureDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcPureIso_(v){const d=vfcPureDate_(v);if(!d)return String(v||'').match(/^\d{4}-\d{2}-\d{2}$/)?String(v):'';return Utilities.formatDate(d,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd');}
function vfcPureTime_(v){const d=vfcPureDate_(v);return d?d.getTime():0;}
function vfcPureSum_(a){return(a||[]).reduce(function(s,x){return s+vfcPureNumber_(x);},0);}
function vfcPureMedian_(a){const x=(a||[]).slice().sort(function(m,n){return m-n;});if(!x.length)return 0;const k=Math.floor(x.length/2);return x.length%2?x[k]:(x[k-1]+x[k])/2;}
function vfcPureCv_(a){if(!a||!a.length)return 0;const mean=vfcPureSum_(a)/a.length;if(!mean)return 0;const variance=a.reduce(function(s,x){return s+Math.pow(x-mean,2);},0)/a.length;return Math.sqrt(variance)/mean;}
function vfcPureTrend_(a){if(!a||a.length<2)return 0;const first=a.slice(0,Math.ceil(a.length/2)),last=a.slice(Math.floor(a.length/2));const f=vfcPureSum_(first)/first.length,l=vfcPureSum_(last)/last.length;return f?((l-f)/f):0;}
function vfcPureDedupeTransactions_(a){const out=[],seen={};(a||[]).forEach(function(t){const k=[t.date,t.direction,t.amount,String(t.description||'').toLowerCase()].join('|');if(!seen[k]){seen[k]=1;out.push(t);}});out.sort(function(a,b){const d=vfcPureTime_(a.date)-vfcPureTime_(b.date);if(d)return d;if(a.direction!==b.direction)return a.direction.localeCompare(b.direction);if(a.amount!==b.amount)return a.amount-b.amount;return String(a.description||'').localeCompare(String(b.description||''));});return out;}
function vfcPureTokens_(s){const stop={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,LOAN:1,CREDIT:1,DEBIT:1,THE:1,INC:1,LTD:1,CORP:1,CORPORATION:1,COMPANY:1,001:1};return String(s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(function(x){return x.length>=3&&!stop[x]&&!/^\d+$/.test(x);});}
function vfcPureCounterpartyKey_(s){const tokens=vfcPureTokens_(s);return tokens.slice(0,4).join('_')||String(s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,60);}
function vfcPureDaysBetween_(a,b){const da=vfcPureDate_(a),db=vfcPureDate_(b);if(!da||!db)return null;return Math.max(0,Math.round((db-da)/86400000));}
function vfcPureMeanObjectValues_(obj){const ks=Object.keys(obj||{});if(!ks.length)return 0;return ks.reduce(function(s,k){return s+vfcPureNumber_(obj[k]);},0)/ks.length;}
function vfcPureSortedObject_(obj){const out={};Object.keys(obj||{}).sort().forEach(function(k){out[k]=vfcPureRound_(obj[k],.01);});return out;}
function vfcPureRecentMonthlyAverage_(monthTotals,count,latestStatementEnd){
  const keys=Object.keys(monthTotals||{}).sort();
  if(!keys.length)return 0;
  // Prefer the latest observed months. This intentionally captures current debt structure after refinances/new advances.
  const selected=keys.slice(Math.max(0,keys.length-Math.max(1,count||3)));
  return selected.reduce(function(s,k){return s+vfcPureNumber_(monthTotals[k]);},0)/selected.length;
}
function vfcPureObligationSort_(a,b){if((b.monthlyEquivalent||0)!==(a.monthlyEquivalent||0))return (b.monthlyEquivalent||0)-(a.monthlyEquivalent||0);return String(a.counterparty||'').localeCompare(String(b.counterparty||''));}
function vfcPureDigest_(s){
  const bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(s||''),Utilities.Charset.UTF_8);
  return bytes.map(function(b){const v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('').substring(0,24);
}
