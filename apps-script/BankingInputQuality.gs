const VFC_BANKING_PURE = {
  VERSION: 'VFC-BANKING-PURE-3.1-SINGLE-PASS',
  PREFIX: 'VFC_BANK_PURE_V31:',
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  MAX_TEXT_CHARS: 50000,
  RECONCILE_TOLERANCE: 5
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING_PURE.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    singlePassDuringAssessment: true,
    bankAgnostic: true,
    usesIntakeHeaderTotals: true,
    transactionDirectionLocked: true,
    creditsNeverCountAsDebt: true,
    revolvingSweepSeparated: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcBankRequest_(companyOrRequest, requestedPeriod);
    return { ok:true, modelVersion:VFC_BANKING_PURE.VERSION, companyName:req.companyName, period:req.period || requestedPeriod || '', deferredToAssessment:true, errors:[] };
  } catch (e) {
    return { ok:false, modelVersion:VFC_BANKING_PURE.VERSION, errors:[String(e && e.message || e)] };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcBankSummaryRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a,b){ return vfcBankTime_(a.createdAt)-vfcBankTime_(b.createdAt); });
  const last = rows[rows.length-1];
  const result = getValidatedBankingFeatures_(last.companyName,last.period);
  console.log(JSON.stringify(result && result.debtProfile ? result.debtProfile : result,null,2));
  return result;
}
function diagnoseLatestBankingInputs(){ return refreshLatestDebtSignals(); }

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function' ? buildPowerFeatures_(companyName,period) :
    (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName,period) : null);
  if (!base) return null;

  const rows = vfcBankSelectedRows_(companyName,period);
  if (!rows.length) return base;

  const prepared = vfcBankPrepareRows_(rows);
  if (prepared.errors.length) throw new Error('Unable to verify uploaded bank statement(s): ' + prepared.errors.join(' | '));

  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;
  const monthlyDeposits=[],monthlyWithdrawals=[],audit=[];
  prepared.rows.forEach(function(x){
    const p=x.payload;
    totalDeposits += p.totalDeposits;
    totalWithdrawals += p.totalWithdrawals;
    monthlyDeposits.push(p.totalDeposits);
    monthlyWithdrawals.push(p.totalWithdrawals);
    nsf += Math.max(0,p.nsfCount||0);
    if (p.negativeBalanceDetected) negative=1;
    audit.push({fileName:x.row.fileName,bank:p.bankName,start:p.statementStartDate,end:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,reconciliationDifference:p.reconciliationDifference,transactionsVerified:p.transactionsVerified});
  });

  const recent = prepared.rows.slice(Math.max(0,prepared.rows.length-VFC_BANKING_PURE.DEBT_LOOKBACK));
  const debt = vfcBankDebtProfile_(recent);
  const months = Math.max(1,prepared.rows.length);
  const grossMonthly = totalDeposits/months;
  const operatingTotal = Math.max(0,totalDeposits-debt.financingCreditsTotal);
  const operatingMonthly = operatingTotal/months;

  return Object.assign({},base,{
    statementCount: prepared.rows.length,
    monthsCovered: months,
    totalDeposits:vfcBankRound_(totalDeposits,.01),
    averageMonthlyDeposits:vfcBankRound_(grossMonthly,.01),
    totalWithdrawals:vfcBankRound_(totalWithdrawals,.01),
    depositWithdrawalRatio: totalWithdrawals ? vfcBankRound_(totalDeposits/totalWithdrawals,.01) : 0,
    nsfCount:nsf,
    nsfPerMonth:vfcBankRound_(nsf/months,.01),
    negativeBalanceFlag:negative,
    mcaPaymentFlag:debt.activeDebtObligations.length?1:0,
    monthlyDeposits:monthlyDeposits,
    monthlyWithdrawals:monthlyWithdrawals,
    estimatedOperatingTotalDeposits:vfcBankRound_(operatingTotal,.01),
    estimatedOperatingMonthlyDeposits:vfcBankRound_(operatingMonthly,.01),
    detectedFinancingCredits:vfcBankRound_(debt.financingCreditsTotal,.01),
    existingMonthlyDebtService:vfcBankRound_(debt.confirmedMonthlyDebtService,.01),
    otherRecurringMonthlyObligations:vfcBankRound_(debt.otherRecurringMonthlyObligations,.01),
    debtServiceToDepositsRatio:grossMonthly?vfcBankRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,
    debtProfile:debt,
    inputQualityAudit:{modelVersion:VFC_BANKING_PURE.VERSION,statementAudit:audit,warnings:debt.warnings}
  });
}

function vfcBankSelectedRows_(companyName,period){
  const all=vfcBankSummaryRows_(companyName,period); if(!all.length)return[];
  const map={};
  all.forEach(function(r){const k=vfcBankStatementKey_(r);const old=map[k];if(!old||vfcBankTime_(r.createdAt)>=vfcBankTime_(old.createdAt))map[k]=r;});
  const rows=Object.keys(map).map(function(k){return map[k];});
  rows.sort(function(a,b){return (vfcBankDate_(a.endDate)||vfcBankDate_(a.startDate)||new Date(0))-(vfcBankDate_(b.endDate)||vfcBankDate_(b.startDate)||new Date(0));});
  return rows.slice(Math.max(0,rows.length-VFC_BANKING_PURE.MAX_STATEMENTS));
}

function vfcBankSummaryRows_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if(!sh||sh.getLastRow()<2)return[];
  const values=sh.getDataRange().getValues(), headers=values[0].map(vfcBankHeader_), idx={}; headers.forEach(function(h,i){idx[h]=i;});
  function val(r,n){const i=idx[vfcBankHeader_(n)];return i===undefined?'':r[i];}
  const out=[];
  for(let i=1;i<values.length;i++){
    const r=values[i],company=String(val(r,'Company Name')||'').trim(),detected=String(val(r,'Detected Period')||'').trim();
    if(companyName&&!vfcBankSame_(company,companyName))continue;
    if(period&&!vfcBankSame_(detected,period))continue;
    out.push({rowNumber:i+1,signalColumn:idx[vfcBankHeader_('Possible MCA Or Loan Payments')]===undefined?-1:idx[vfcBankHeader_('Possible MCA Or Loan Payments')]+1,
      uploadId:String(val(r,'Upload ID')||'').trim(),companyName:company,period:detected,fileName:String(val(r,'File Name')||'').trim(),bank:String(val(r,'Bank Name')||'').trim(),
      startDate:val(r,'Statement Start Date'),endDate:val(r,'Statement End Date'),opening:vfcBankNullable_(val(r,'Opening Balance')),closing:vfcBankNullable_(val(r,'Closing Balance')),
      deposits:vfcBankNullable_(val(r,'Total Deposits')),withdrawals:vfcBankNullable_(val(r,'Total Withdrawals')),nsf:vfcBankNumber_(val(r,'NSF Count')),
      negative:vfcBankBool_(val(r,'Negative Balance Detected')),signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),createdAt:val(r,'Created At')});
  }
  return out;
}

function vfcBankPrepareRows_(rows){
  const uploads=vfcBankUploadIndex_(), sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries'), out=[], errors=[];
  rows.forEach(function(row,index){
    const recent=index>=Math.max(0,rows.length-VFC_BANKING_PURE.DEBT_LOOKBACK);
    let p=vfcBankParsePayload_(row.signalRaw);
    if(!vfcBankPayloadUsable_(p,recent)){
      try{
        const totals=vfcBankTotals_(row); if(!totals.ok)throw new Error('statement totals do not reconcile');
        let transactions=[];
        if(recent){
          const upload=vfcBankResolveUpload_(row,uploads); if(!upload||!upload.fileId)throw new Error('uploaded PDF file ID not found');
          const text=extractTextFromPdf_(upload.fileId);
          const raw=vfcBankExtractTransactions_(text,row);
          transactions=vfcBankNormalizeTransactions_(raw.transactions||[]);
        }
        p={version:31,modelVersion:VFC_BANKING_PURE.VERSION,fileName:row.fileName,bankName:row.bank||'Unknown',statementStartDate:vfcBankIso_(row.startDate),statementEndDate:vfcBankIso_(row.endDate),
          openingBalance:totals.opening,closingBalance:totals.closing,totalDeposits:totals.deposits,totalWithdrawals:totals.withdrawals,reconciliationDifference:totals.diff,
          nsfCount:Math.max(0,row.nsf||0),negativeBalanceDetected:!!row.negative,transactionsVerified:recent,transactions:transactions,analyzedAt:new Date().toISOString()};
        if(row.signalColumn>0)sh.getRange(row.rowNumber,row.signalColumn).setValue(VFC_BANKING_PURE.PREFIX+JSON.stringify(p));
      }catch(e){errors.push(row.fileName+': '+String(e&&e.message||e));return;}
    }
    out.push({row:row,payload:p});
  });
  return{rows:out,errors:errors};
}

function vfcBankExtractTransactions_(text,row){
  const prompt=[
    'Return JSON only with key transactions.',
    'Each transaction: {date:"YYYY-MM-DD",description:"exact description",counterparty:"short name",direction:"DEBIT" or "CREDIT",amount:number}.',
    'FACT EXTRACTION ONLY. Bank column controls direction. Deposits/Credits=CREDIT; Cheques/Debits=DEBIT. Wording never overrides the column.',
    'Extract financing/loan/PAD/MCA/capital/advance/funding transactions, BDC, Journey/OnDeck, Merchant/Merch PAD, loan interest, tax/CRA/CCRA/GST/HST/EMPTX/TXINS, insurance/IPFS/premium finance and credit-card payments.',
    'Do not extract ordinary suppliers, payroll, customer receipts, utilities, fuel/gas, phone, bank fees or ordinary transfers unless clearly financing/tax/insurance.',
    'Never duplicate cheque-image pages. If uncertain, omit.',
    'Metadata:'+JSON.stringify({fileName:row.fileName,start:vfcBankIso_(row.startDate),end:vfcBankIso_(row.endDate),bank:row.bank}),
    'STATEMENT TEXT:',String(text||'').substring(0,VFC_BANKING_PURE.MAX_TEXT_CHARS)
  ].join('\n');
  return callOpenAIJson_(prompt)||{};
}

function vfcBankDebtProfile_(recent){
  const tx=[]; recent.forEach(function(x){(x.payload.transactions||[]).forEach(function(t){tx.push(t);});});
  const financingCredits=[], debtGroups={}, otherGroups={}, genericLoanCredits=[],genericLoanPayments=[];
  tx.forEach(function(t){
    const d=String(t.description||'').toUpperCase(), dir=t.direction, amount=vfcBankNumber_(t.amount); if(!(amount>0))return;
    if(dir==='CREDIT'){
      if(/\bLOAN CREDIT\b|\bLOAN\b|\bADVANCE\b|\bFUND(?:ING)?\b|\bCAPITAL\b|\bMERCHANT GROWTH\b|\bBDC\b|\bJOURNEY\b|\bONDECK\b/.test(d)) financingCredits.push(Object.assign({},t,{classification:'FINANCING_CREDIT'}));
      if(/\bLOAN CREDIT\b/.test(d))genericLoanCredits.push(t);
      return;
    }
    if(dir!=='DEBIT')return;
    if(/^LOAN PAYMENT\b/.test(d)&&!/NO\.|NUMBER|#/.test(d)){genericLoanPayments.push(t);return;}
    if(/SUPERPASS|HYDRO|FORTIS|GAS BILL|TELUS|ROGERS|PHONE|PAY-FILE|BANK FEE/.test(d))return;
    if(/CRA|CCRA|GST|HST|TAX|EMPTX|TXINS|INSURANCE|IPFS|PREMIUM FINANCE/.test(d)){vfcBankAddGroup_(otherGroups,t,'OTHER');return;}
    if(/\bPAD\b|\bMCA\b|MERCH|MERCHANT|BDC|JOURNEY|ONDECK|LOAN PAYMENT|LOAN INTEREST|FINANC|ADVANCE/.test(d))vfcBankAddGroup_(debtGroups,t,'DEBT');
  });

  const active=[], observed=[], other=[];
  Object.keys(debtGroups).forEach(function(k){
    const g=debtGroups[k], months=vfcBankDistinctMonths_(g.items), occ=g.items.length, total=g.items.reduce(function(s,t){return s+t.amount;},0);
    const monthly=total/Math.max(1,recent.length);
    const item=vfcBankGroupItem_(g,monthly,occ,months);
    if(occ>=2&&months>=2)active.push(item);else observed.push(item);
  });
  Object.keys(otherGroups).forEach(function(k){const g=otherGroups[k],total=g.items.reduce(function(s,t){return s+t.amount;},0);other.push(vfcBankGroupItem_(g,total/Math.max(1,recent.length),g.items.length,vfcBankDistinctMonths_(g.items)));});

  const creditTotal=financingCredits.reduce(function(s,t){return s+t.amount;},0);
  const confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0);
  const otherMonthly=other.reduce(function(s,x){return s+x.monthlyEquivalent;},0);
  const sweep=genericLoanCredits.length&&genericLoanPayments.length?[{type:'REVOLVING_LOAN_SWEEP',creditOccurrences:genericLoanCredits.length,paymentOccurrences:genericLoanPayments.length,totalCredits:vfcBankRound_(genericLoanCredits.reduce(function(s,t){return s+t.amount;},0),.01),totalPayments:vfcBankRound_(genericLoanPayments.reduce(function(s,t){return s+t.amount;},0),.01),includedInMonthlyDebt:false}]:[];
  const warnings=[]; if(sweep.length)warnings.push('Generic LOAN CREDIT/LOAN PAYMENT activity is treated as revolving sweep activity, not fixed monthly debt.');
  return{confirmedMonthlyDebtService:vfcBankRound_(confirmed,.01),otherRecurringMonthlyObligations:vfcBankRound_(otherMonthly,.01),financingCreditsTotal:vfcBankRound_(creditTotal,.01),activeDebtObligations:active,otherRecurringObligations:other,financingCredits:financingCredits,newFinancingObserved:observed,revolvingFinancingActivity:sweep,warnings:warnings};
}

function vfcBankAddGroup_(map,t,type){const key=vfcBankCounterpartyKey_(t);if(!map[key])map[key]={key:key,type:type,items:[]};map[key].items.push(t);}
function vfcBankGroupItem_(g,monthly,occ,months){const vals=g.items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;});return{counterparty:g.items[0].counterparty||g.items[0].description,description:g.items[0].description,category:g.type,paymentAmount:vfcBankRound_(vfcBankMedian_(vals),.01),frequency:'Observed cash flow',monthlyEquivalent:vfcBankRound_(monthly,.01),occurrences:occ,monthsObserved:months,firstSeen:g.items.map(function(t){return t.date;}).sort()[0],lastSeen:g.items.map(function(t){return t.date;}).sort().slice(-1)[0],active:true,confidence:(occ>=3&&months>=2)?'High':'Moderate'};}
function vfcBankCounterpartyKey_(t){let s=String(t.counterparty||t.description||'').toUpperCase();if(/MERCH/.test(s))return'MERCHANT';if(/BDC/.test(s))return'BDC';if(/JOURNEY|ONDECK/.test(s))return'JOURNEY_ONDECK';const m=s.match(/NO\.?\s*\d+/);if(m)return'LOAN_'+m[0].replace(/\s+/g,'');return s.replace(/\b(PAD|PAYMENT|LOAN|BUSINESS|INVESTMENT|FINANCING|INTEREST)\b/g,' ').replace(/[^A-Z0-9]+/g,' ').trim().substring(0,60)||'UNKNOWN';}
function vfcBankDistinctMonths_(items){const s={};items.forEach(function(t){if(/^\d{4}-\d{2}/.test(t.date))s[t.date.slice(0,7)]=1;});return Object.keys(s).length;}

function vfcBankNormalizeTransactions_(items){if(!Array.isArray(items))return[];const out=[],seen={};items.forEach(function(x){x=x||{};const date=vfcBankIso_(x.date),desc=String(x.description||'').replace(/\s+/g,' ').trim(),dir=String(x.direction||'').toUpperCase(),amount=vfcBankPositive_(x.amount);if(!date||!desc||(dir!=='DEBIT'&&dir!=='CREDIT')||!(amount>0))return;const t={date:date,description:desc.substring(0,240),counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),direction:dir,amount:vfcBankRound_(amount,.01)};const k=[t.date,t.direction,t.amount,t.description.toUpperCase()].join('|');if(!seen[k]){seen[k]=1;out.push(t);}});return out;}

function vfcBankTotals_(r){const o=r.opening,c=r.closing,d=r.deposits,w=r.withdrawals;if(o===null||c===null||d===null||w===null||!(d>=0)||!(w>=0))return{ok:false};const diff=vfcBankRound_((o+d-w)-c,.01);return{ok:Math.abs(diff)<=VFC_BANKING_PURE.RECONCILE_TOLERANCE,opening:o,closing:c,deposits:d,withdrawals:w,diff:diff};}
function vfcBankPayloadUsable_(p,recent){return!!(p&&p.version===31&&p.modelVersion===VFC_BANKING_PURE.VERSION&&p.totalDeposits>=0&&p.totalWithdrawals>=0&&(!recent||p.transactionsVerified));}
function vfcBankParsePayload_(raw){raw=String(raw||'').trim();if(raw.indexOf(VFC_BANKING_PURE.PREFIX)!==0)return null;try{return JSON.parse(raw.slice(VFC_BANKING_PURE.PREFIX.length));}catch(e){return null;}}

function vfcBankUploadIndex_(){const rows=typeof getSheetObjects_==='function'?getSheetObjects_('Uploads'):[],idx={byId:{},byExact:{},byCompanyFile:{},byFile:{}};rows.forEach(function(r){const uploadId=String(r.uploadId||'').trim(),company=String(r.companyName||'').trim(),period=String(r.detectedPeriod||'').trim(),fileName=String(r.fileName||'').trim();let fileId=String(r.fileId||'').trim();const link=String(r.fileLink||'').trim();if(!fileId&&link){const m=link.match(/[-\w]{20,}/);if(m)fileId=m[0];}if(!fileId)return;const item={uploadId:uploadId,companyName:company,period:period,fileName:fileName,fileId:fileId,createdAt:r.createdAt||''};if(uploadId)idx.byId[uploadId]=item;vfcBankKeepNewest_(idx.byExact,vfcBankNorm_(company)+'|'+vfcBankNorm_(period)+'|'+vfcBankNorm_(fileName),item);vfcBankKeepNewest_(idx.byCompanyFile,vfcBankNorm_(company)+'|'+vfcBankNorm_(fileName),item);vfcBankKeepNewest_(idx.byFile,vfcBankNorm_(fileName),item);});return idx;}
function vfcBankResolveUpload_(r,idx){if(r.uploadId&&idx.byId[r.uploadId])return idx.byId[r.uploadId];return idx.byExact[vfcBankNorm_(r.companyName)+'|'+vfcBankNorm_(r.period)+'|'+vfcBankNorm_(r.fileName)]||idx.byCompanyFile[vfcBankNorm_(r.companyName)+'|'+vfcBankNorm_(r.fileName)]||idx.byFile[vfcBankNorm_(r.fileName)]||null;}
function vfcBankKeepNewest_(map,key,item){if(!key)return;const old=map[key];if(!old||vfcBankTime_(item.createdAt)>=vfcBankTime_(old.createdAt))map[key]=item;}

function vfcBankRequest_(x,p){if(typeof x==='string')return{companyName:String(x).trim(),period:String(p||'').trim()};x=x||{};return{companyName:String(x.companyName||x.company||'').trim(),period:String(x.period||p||'').trim()};}
function vfcBankStatementKey_(r){const s=vfcBankIso_(r.startDate),e=vfcBankIso_(r.endDate);return s&&e?s+'|'+e:vfcBankNorm_(r.fileName);}
function vfcBankHeader_(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcBankSame_(a,b){return vfcBankNorm_(a)===vfcBankNorm_(b);}
function vfcBankNorm_(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');}
function vfcBankNullable_(v){if(v===null||v===undefined||String(v).trim()==='')return null;const n=vfcBankNumber_(v);return isFinite(n)?n:null;}
function vfcBankNumber_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function vfcBankPositive_(v){return Math.max(0,vfcBankNumber_(v));}
function vfcBankBool_(v){return /yes|true|detected|negative|1/i.test(String(v||''));}
function vfcBankRound_(v,step){step=step||1;return Math.round((Number(v)||0)/step)*step;}
function vfcBankDate_(v){if(!v)return null;const d=new Date(v);return isNaN(d.getTime())?null:d;}
function vfcBankIso_(v){const d=vfcBankDate_(v);if(!d)return'';return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd');}
function vfcBankTime_(v){const d=vfcBankDate_(v);return d?d.getTime():0;}
function vfcBankMedian_(a){if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}