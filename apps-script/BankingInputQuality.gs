const VFC_BANKING_PURE = {
  VERSION: 'VFC-BANKING-PURE-3.0-LEDGER',
  PREFIX: 'VFC_BANK_PURE_V3:',
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  MAX_TEXT_CHARS: 70000,
  MIN_FINANCING_CREDIT: 1000
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING_PURE.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    bankAgnostic: true,
    usesIntakeHeaderTotals: true,
    transactionDirectionLocked: true,
    recurrenceCalculatedLocally: true,
    creditsNeverCountAsDebt: true,
    revolvingSweepSeparated: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = vfcLedgerBaseFeatures_(companyName, period);
  if (!base) return null;
  const rows = vfcLedgerSelectedRows_(companyName, period);
  if (!rows.length) return base;

  const ensured = vfcLedgerEnsureStatements_(rows);
  if (ensured.errors.length) {
    throw new Error('Unable to read uploaded bank statement(s): ' + ensured.errors.join(' | '));
  }
  return vfcLedgerBuildFeatures_(base, ensured.rows);
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcLedgerRequest_(companyOrRequest, requestedPeriod);
    const period = req.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(req.companyName, req.period)
      : req.period);
    const features = getValidatedBankingFeatures_(req.companyName, period);
    if (!features) throw new Error('No banking features found.');
    return {
      ok: true,
      modelVersion: VFC_BANKING_PURE.VERSION,
      companyName: req.companyName,
      period: period,
      errors: [],
      debtProfile: features.debtProfile || {},
      inputQualityAudit: features.inputQualityAudit || {}
    };
  } catch (e) {
    return { ok:false, modelVersion:VFC_BANKING_PURE.VERSION, errors:[String(e && e.message || e)] };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcLedgerSummaryRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a,b){ return vfcLedgerTime_(a.createdAt)-vfcLedgerTime_(b.createdAt); });
  const last = rows[rows.length-1];
  const result = refreshDebtSignalsForPeriodSafe({companyName:last.companyName,period:last.period});
  console.log(JSON.stringify(result,null,2));
  return result;
}

function diagnoseLatestBankingInputs() { return refreshLatestDebtSignals(); }

/* ========================= statement selection ========================= */

function vfcLedgerSelectedRows_(companyName, period) {
  const all = vfcLedgerSummaryRows_(companyName, period);
  if (!all.length) return [];
  const byStatement = {};
  all.forEach(function(row){
    const key = vfcLedgerStatementKey_(row);
    const old = byStatement[key];
    if (!old || vfcLedgerTime_(row.createdAt) >= vfcLedgerTime_(old.createdAt)) byStatement[key]=row;
  });
  const rows = Object.keys(byStatement).map(function(k){return byStatement[k];});
  rows.sort(function(a,b){
    const ad=vfcLedgerDate_(a.endDate)||vfcLedgerDate_(a.startDate)||new Date(0);
    const bd=vfcLedgerDate_(b.endDate)||vfcLedgerDate_(b.startDate)||new Date(0);
    return ad-bd;
  });
  return rows.slice(Math.max(0,rows.length-VFC_BANKING_PURE.MAX_STATEMENTS));
}

function vfcLedgerSummaryRows_(companyName, period) {
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  const sh=ss.getSheetByName('PDF Summaries');
  if(!sh||sh.getLastRow()<2)return[];
  const values=sh.getDataRange().getValues();
  const headers=values[0].map(vfcLedgerHeader_); const idx={};
  headers.forEach(function(h,i){idx[h]=i;});
  function val(r,name){const i=idx[vfcLedgerHeader_(name)];return i===undefined?'':r[i];}
  const out=[];
  for(let i=1;i<values.length;i++){
    const r=values[i];
    const company=String(val(r,'Company Name')||'').trim();
    const detected=String(val(r,'Detected Period')||'').trim();
    if(companyName&&!vfcLedgerSame_(company,companyName))continue;
    if(period&&!vfcLedgerSame_(detected,period))continue;
    out.push({
      rowNumber:i+1,
      signalColumn:idx[vfcLedgerHeader_('Possible MCA Or Loan Payments')]===undefined?-1:idx[vfcLedgerHeader_('Possible MCA Or Loan Payments')]+1,
      uploadId:String(val(r,'Upload ID')||'').trim(), companyName:company, period:detected,
      fileName:String(val(r,'File Name')||'').trim(), bank:String(val(r,'Bank Name')||'').trim(),
      startDate:val(r,'Statement Start Date'), endDate:val(r,'Statement End Date'),
      opening:vfcLedgerNullable_(val(r,'Opening Balance')), closing:vfcLedgerNullable_(val(r,'Closing Balance')),
      deposits:vfcLedgerNullable_(val(r,'Total Deposits')), withdrawals:vfcLedgerNullable_(val(r,'Total Withdrawals')),
      nsf:vfcLedgerNumber_(val(r,'NSF Count')), negative:vfcLedgerBool_(val(r,'Negative Balance Detected')),
      signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''), createdAt:val(r,'Created At')
    });
  }
  return out;
}

/* ========================= upload resolution ========================= */

function vfcLedgerUploadIndex_() {
  const rows = typeof getSheetObjects_==='function' ? getSheetObjects_('Uploads') : [];
  const index={byId:{},byExact:{},byCompanyFile:{},byFile:{}};
  rows.forEach(function(r){
    const uploadId=String(r.uploadId||r['Upload ID']||'').trim();
    const company=String(r.companyName||r['Company Name']||'').trim();
    const period=String(r.detectedPeriod||r.period||r['Detected Period']||'').trim();
    const fileName=String(r.fileName||r['File Name']||'').trim();
    let fileId=String(r.fileId||r['File ID']||'').trim();
    const fileLink=String(r.fileLink||r.fileUrl||r['File Link']||'').trim();
    if(!fileId&&fileLink){const m=fileLink.match(/[-\w]{20,}/);if(m)fileId=m[0];}
    if(!fileId)return;
    const item={uploadId:uploadId,companyName:company,period:period,fileName:fileName,fileId:fileId,createdAt:r.createdAt||r['Created At']||''};
    if(uploadId)index.byId[uploadId]=item;
    const exact=vfcLedgerNorm_(company)+'|'+vfcLedgerNorm_(period)+'|'+vfcLedgerNorm_(fileName);
    const cf=vfcLedgerNorm_(company)+'|'+vfcLedgerNorm_(fileName);
    const f=vfcLedgerNorm_(fileName);
    vfcLedgerKeepNewest_(index.byExact,exact,item);
    vfcLedgerKeepNewest_(index.byCompanyFile,cf,item);
    vfcLedgerKeepNewest_(index.byFile,f,item);
  });
  return index;
}

function vfcLedgerResolveUpload_(row,index){
  if(row.uploadId&&index.byId[row.uploadId])return index.byId[row.uploadId];
  const exact=vfcLedgerNorm_(row.companyName)+'|'+vfcLedgerNorm_(row.period)+'|'+vfcLedgerNorm_(row.fileName);
  if(index.byExact[exact])return index.byExact[exact];
  const cf=vfcLedgerNorm_(row.companyName)+'|'+vfcLedgerNorm_(row.fileName);
  if(index.byCompanyFile[cf])return index.byCompanyFile[cf];
  return index.byFile[vfcLedgerNorm_(row.fileName)]||null;
}

function vfcLedgerKeepNewest_(map,key,item){
  if(!key)return; const old=map[key];
  if(!old||vfcLedgerTime_(item.createdAt)>=vfcLedgerTime_(old.createdAt))map[key]=item;
}

/* ========================= extraction / cache ========================= */

function vfcLedgerEnsureStatements_(rows){
  const ss=SpreadsheetApp.getActiveSpreadsheet(); const sh=ss.getSheetByName('PDF Summaries');
  const uploads=vfcLedgerUploadIndex_(); const out=[]; const errors=[];
  rows.forEach(function(row,index){
    const recent=index>=Math.max(0,rows.length-VFC_BANKING_PURE.DEBT_LOOKBACK);
    let payload=vfcLedgerParse_(row.signalRaw);
    if(!vfcLedgerPayloadUsable_(payload,recent)){
      try{
        payload=vfcLedgerExtract_(row,vfcLedgerResolveUpload_(row,uploads),recent);
        if(row.signalColumn>0)sh.getRange(row.rowNumber,row.signalColumn).setValue(VFC_BANKING_PURE.PREFIX+JSON.stringify(payload));
      }catch(e){errors.push(row.fileName+': '+String(e&&e.message||e));return;}
    }
    out.push({row:row,payload:payload});
  });
  return{rows:out,errors:errors};
}

function vfcLedgerExtract_(row,upload,needTransactions){
  const totals=vfcLedgerStoredTotals_(row);
  if(!totals.ok)throw new Error('statement summary totals do not reconcile');
  let transactions=[];
  if(needTransactions){
    if(!upload||!upload.fileId)throw new Error('could not resolve uploaded PDF from intake records');
    const text=extractTextFromPdf_(upload.fileId);
    const raw=vfcLedgerExtractTransactionsAI_(text,row);
    transactions=vfcLedgerNormalizeTransactions_(raw.transactions||[]);
  }
  return{
    version:3,modelVersion:VFC_BANKING_PURE.VERSION,fileName:row.fileName,bankName:row.bank||'Unknown',
    statementStartDate:vfcLedgerIso_(row.startDate),statementEndDate:vfcLedgerIso_(row.endDate),
    openingBalance:totals.opening,closingBalance:totals.closing,totalDeposits:totals.deposits,totalWithdrawals:totals.withdrawals,
    reconciliationDifference:totals.diff,totalsSource:'INTAKE_RECONCILED',nsfCount:Math.max(0,row.nsf||0),negativeBalanceDetected:!!row.negative,
    transactionsVerified:needTransactions,transactions:transactions,analyzedAt:new Date().toISOString()
  };
}

function vfcLedgerExtractTransactionsAI_(text,row){
  const prompt=[
    'You are reading a business bank statement ledger. Return JSON only with one key: transactions.',
    'Each transaction must be: {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short payee/funder",direction:"DEBIT" or "CREDIT",amount:number}.',
    '',
    'FACT EXTRACTION ONLY. Do not underwrite, infer recurrence, infer monthly debt, or guess lender rules.',
    'The bank column is authoritative. If printed under Deposits/Credits, direction=CREDIT. If printed under Cheques/Debits, direction=DEBIT.',
    'A description containing PAD or PAYMENT can still be CREDIT. Direction comes from the column, never the wording.',
    '',
    'Extract every transaction that is potentially relevant to financing or recurring obligations:',
    '- LOAN, LOAN CREDIT, LOAN PAYMENT, LOAN INTEREST, ADVANCE, FUNDING, FINANCING, MCA, CAPITAL',
    '- PAD / PRE-AUTH / MERCH / MERCHANT / BDC / JOURNEY / ONDECK',
    '- CRA / CCRA / GST / HST / TAX / EMPTX / TXINS',
    '- INSURANCE / IPFS / PREMIUM FINANCE / CREDIT CARD',
    '- any incoming credit >= $5,000 whose description itself suggests financing, lender funding, capital, investment, advance or loan.',
    '',
    'Do not extract ordinary supplier cheques, payroll, customer deposits, ordinary e-transfers, utilities, gas/fuel, telephone or bank fees unless the description also clearly matches a financing/tax/insurance rule above.',
    'Never copy a nearby amount. Use the exact amount on that transaction row. Do not duplicate cheque-image pages.',
    'If unclear, omit the transaction rather than guessing.',
    '',
    'Statement metadata: '+JSON.stringify({fileName:row.fileName,start:vfcLedgerIso_(row.startDate),end:vfcLedgerIso_(row.endDate),bank:row.bank}),
    '',
    'STATEMENT TEXT:',String(text||'').substring(0,VFC_BANKING_PURE.MAX_TEXT_CHARS)
  ].join('\n');
  return callOpenAIJson_(prompt)||{};
}

function vfcLedgerNormalizeTransactions_(items){
  if(!Array.isArray(items))return[]; const out=[],seen={};
  items.forEach(function(x){x=x||{};const date=vfcLedgerIso_(x.date),desc=String(x.description||'').replace(/\s+/g,' ').trim(),dir=String(x.direction||'').toUpperCase(),amount=vfcLedgerPositive_(x.amount);if(!date||!desc||(dir!=='DEBIT'&&dir!=='CREDIT')||!(amount>0))return;
    const t={date:date,description:desc.substring(0,240),counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),direction:dir,amount:vfcLedgerRound_(amount,.01)};
    const k=[t.date,t.direction,t.amount,t.description.toUpperCase()].join('|');if(!seen[k]){seen[k]=1;out.push(t);}
  });return out;
}

/* ========================= deterministic banking logic ========================= */

function vfcLedgerBuildFeatures_(base,verifiedRows){
  let totalDeposits=0,totalWithdrawals=0,nsf=0,negative=0;const monthlyDeposits=[],monthlyWithdrawals=[],openings=[],closings=[],audit=[];
  verifiedRows.forEach(function(x){const p=x.payload;totalDeposits+=p.totalDeposits;totalWithdrawals+=p.totalWithdrawals;monthlyDeposits.push(p.totalDeposits);monthlyWithdrawals.push(p.totalWithdrawals);openings.push(p.openingBalance);closings.push(p.closingBalance);nsf+=Math.max(0,p.nsfCount||0);if(p.negativeBalanceDetected)negative=1;audit.push({fileName:x.row.fileName,bank:p.bankName,statementStartDate:p.statementStartDate,statementEndDate:p.statementEndDate,totalDeposits:p.totalDeposits,totalWithdrawals:p.totalWithdrawals,openingBalance:p.openingBalance,closingBalance:p.closingBalance,reconciliationDifference:p.reconciliationDifference,transactionsVerified:p.transactionsVerified,verified:true});});
  const recent=verifiedRows.slice(Math.max(0,verifiedRows.length-VFC_BANKING_PURE.DEBT_LOOKBACK));
  const debt=vfcLedgerDebtProfile_(recent);const months=Math.max(1,verifiedRows.length);const grossMonthly=totalDeposits/months;const operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal);const operatingMonthly=operatingTotal/months;
  const warnings=[];if(debt.revolvingFinancingActivity.length)warnings.push('Revolving loan sweep activity detected. Draws are financing credits; sweep repayments are not treated as fixed monthly debt.');if(debt.newFinancingObserved.length)warnings.push('New financing was observed but did not have enough repayment history to become confirmed recurring monthly debt.');
  return Object.assign({},base,{statementCount:verifiedRows.length,monthsCovered:verifiedRows.length,totalDeposits:vfcLedgerRound_(totalDeposits,.01),averageMonthlyDeposits:vfcLedgerRound_(grossMonthly,.01),totalWithdrawals:vfcLedgerRound_(totalWithdrawals,.01),depositWithdrawalRatio:totalWithdrawals?vfcLedgerRound_(totalDeposits/totalWithdrawals,.01):0,nsfCount:nsf,nsfPerMonth:vfcLedgerRound_(nsf/months,.01),negativeBalanceFlag:negative,mcaPaymentFlag:debt.activeDebtObligations.length?1:0,monthlyDeposits:monthlyDeposits,monthlyWithdrawals:monthlyWithdrawals,depositVolatility:vfcLedgerRound_(vfcLedgerCv_(monthlyDeposits),.01),depositTrend:vfcLedgerRound_(vfcLedgerTrend_(monthlyDeposits),.01),averageOpeningBalance:vfcLedgerRound_(vfcLedgerSum_(openings)/openings.length,.01),averageClosingBalance:vfcLedgerRound_(vfcLedgerSum_(closings)/closings.length,.01),estimatedOperatingTotalDeposits:vfcLedgerRound_(operatingTotal,.01),estimatedOperatingMonthlyDeposits:vfcLedgerRound_(operatingMonthly,.01),detectedFinancingCredits:vfcLedgerRound_(debt.financingCreditsTotal,.01),existingMonthlyDebtService:vfcLedgerRound_(debt.confirmedMonthlyDebtService,.01),informationalRecurringMonthlyObligations:vfcLedgerRound_(debt.informationalMonthlyObligations,.01),otherRecurringMonthlyObligations:vfcLedgerRound_(debt.informationalMonthlyObligations,.01),debtServiceToDepositsRatio:grossMonthly?vfcLedgerRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,debtProfile:debt,inputQualityAudit:{modelVersion:VFC_BANKING_PURE.VERSION,verified:true,selectedStatementRows:verifiedRows.length,grossAverageMonthlyDeposits:vfcLedgerRound_(grossMonthly,.01),estimatedOperatingMonthlyDeposits:vfcLedgerRound_(operatingMonthly,.01),statementAudit:audit,warnings:warnings}});
}

function vfcLedgerDebtProfile_(recentRows){
  const months=Math.max(1,recentRows.length);let tx=[];recentRows.forEach(function(x){(x.payload.transactions||[]).forEach(function(t){tx.push(Object.assign({statementEnd:x.payload.statementEndDate},t));});});tx=vfcLedgerDedupe_(tx);
  const debits=tx.filter(function(t){return t.direction==='DEBIT';});const credits=tx.filter(function(t){return t.direction==='CREDIT';});
  const classified=debits.map(vfcLedgerClassifyDebit_).filter(Boolean);const groups={};classified.forEach(function(t){const k=t.family+'|'+t.key;if(!groups[k])groups[k]={family:t.family,key:t.key,label:t.label,items:[]};groups[k].items.push(t);});
  const genericLoanCredits=credits.filter(function(c){return /^\s*LOAN\s+CREDIT\b/i.test(c.description);});
  const genericLoanDebits=classified.filter(function(d){return d.key==='GENERIC_LOAN_PAYMENT';});
  const revolvingSweep=genericLoanCredits.length>=4&&genericLoanDebits.length>=4;
  const summaries=Object.keys(groups).map(function(k){return vfcLedgerSummarizeGroup_(groups[k],months);}).filter(Boolean);
  const active=[],tax=[],other=[],observedOnce=[],revolving=[];
  summaries.forEach(function(g){
    if(revolvingSweep&&g.key==='GENERIC_LOAN_PAYMENT'){revolving.push(g);return;}
    if(!g.recurring){observedOnce.push(g);return;}
    if(g.family==='FINANCING'||g.family==='MCA'||g.family==='PAD')active.push(g);
    else if(g.family==='TAX')tax.push(g);else other.push(g);
  });
  const creditResult=vfcLedgerFinancingCredits_(credits,classified);
  const newFinancing=[];
  creditResult.confirmed.forEach(function(c){const payment=vfcLedgerBestRelatedObserved_(c,observedOnce);if(payment)newFinancing.push({credit:c,observedPayment:payment});});
  const confirmedMonthly=active.reduce(function(s,g){return s+g.monthlyEquivalent;},0);const infoMonthly=tax.concat(other).reduce(function(s,g){return s+g.monthlyEquivalent;},0);
  return{confirmedMonthlyDebtService:vfcLedgerRound_(confirmedMonthly,.01),informationalMonthlyObligations:vfcLedgerRound_(infoMonthly,.01),activeDebtObligations:active,revolvingFinancingActivity:revolving,taxGovernmentPads:tax,otherRecurringObligations:other,observedOnce:observedOnce,newFinancingObserved:newFinancing,allDetectedObligations:summaries,financingCredits:creditResult.confirmed,possibleFinancingCredits:creditResult.possible,financingCreditsTotal:vfcLedgerRound_(creditResult.total,.01),note:'Direction comes from the bank column. Credits never count as debt. Recurring debt equals actual observed debit cash flow averaged across the recent statement window. Revolving loan sweeps are separated from fixed debt.'};
}

function vfcLedgerClassifyDebit_(t){
  const s=String(t.description||'').toUpperCase();
  if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s))return null;
  if(/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|PETROLEUM|FUEL/.test(s))return null;
  let family='',key='',label=t.counterparty||t.description;
  if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s))family='TAX';
  else if(/INSURANCE|\bIPFS\b|PREMIUM\s+FIN/.test(s))family='OTHER';
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD/.test(s))family='OTHER';
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH|\bMCA\b/.test(s))family='MCA';
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s))family='PAD';
  else if(/LOAN\s+PAYMENT|LOAN\s+PYMT|LOAN\s+PMT|LOAN\s+INTEREST|\bFINANC/.test(s))family='FINANCING';
  else return null;
  if(/^\s*LOAN\s+PAYMENT\s*$/i.test(String(t.description||'')))key='GENERIC_LOAN_PAYMENT';
  else{const no=s.match(/(?:NO\.?|NUMBER)\s*([0-9-]{5,})/);if(no)key=(/INTEREST/.test(s)?'LOAN_INTEREST_':'LOAN_')+no[1].replace(/[^0-9]/g,'');else key=vfcLedgerCounterpartyKey_(t.counterparty||t.description);}
  return Object.assign({},t,{family:family,key:key,label:label});
}

function vfcLedgerSummarizeGroup_(g,monthsInWindow){
  const items=(g.items||[]).slice().sort(function(a,b){return vfcLedgerDate_(a.date)-vfcLedgerDate_(b.date);});if(!items.length)return null;
  const monthSet={};items.forEach(function(i){monthSet[String(i.date).slice(0,7)]=1;});const distinctMonths=Object.keys(monthSet).length,occurrences=items.length;
  const recurring=distinctMonths>=2&&occurrences>=2;const sum=items.reduce(function(s,i){return s+i.amount;},0);const monthly=recurring?sum/Math.max(1,monthsInWindow):0;
  const gaps=[];for(let i=1;i<items.length;i++)gaps.push((vfcLedgerDate_(items[i].date)-vfcLedgerDate_(items[i-1].date))/86400000);const gap=gaps.length?vfcLedgerMedian_(gaps):0;
  let frequency='Observed';if(distinctMonths>=2&&occurrences===distinctMonths)frequency='Monthly';else if(gap>=5&&gap<=10)frequency='Weekly / multiple monthly';else if(gap>=11&&gap<=20)frequency='Biweekly / multiple monthly';else if(recurring)frequency='Multiple monthly';
  return{family:g.family,key:g.key,counterparty:g.label,description:g.label,category:g.family==='FINANCING'?'LOAN':g.family,paymentAmount:vfcLedgerRound_(vfcLedgerMedian_(items.map(function(i){return i.amount;})),.01),frequency:frequency,monthlyEquivalent:vfcLedgerRound_(monthly,.01),occurrences:occurrences,distinctMonths:distinctMonths,firstSeen:items[0].date,lastSeen:items[items.length-1].date,active:recurring,recurring:recurring,confidence:distinctMonths>=3?'High':(recurring?'Moderate':'Low'),observedTotal:vfcLedgerRound_(sum,.01)};
}

function vfcLedgerFinancingCredits_(credits,classifiedDebits){
  const confirmed=[],possible=[];
  credits.forEach(function(c){const s=String(c.description||'').toUpperCase(),amount=vfcLedgerPositive_(c.amount);if(!(amount>=VFC_BANKING_PURE.MIN_FINANCING_CREDIT))return;
    const explicit=/^\s*LOAN\s+CREDIT\b|LOAN\s+ADVANCE|LOAN\s+RETURN|FINANCING|FUNDING|CASH\s+ADVANCE|MERCHANT\s+CASH\s+ADVANCE|\bMCA\b/.test(s);
    const namedFinance=/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|CAPITAL|FUNDING|FINANCE/.test(s);
    const correlated=vfcLedgerCreditHasPaymentMatch_(c,classifiedDebits);
    const item={date:c.date,description:c.description,counterparty:c.counterparty,amount:c.amount,direction:'CREDIT',confidence:(explicit||correlated)?'High':'Moderate'};
    if(explicit||(amount>=5000&&namedFinance&&correlated))confirmed.push(item);
    else if(amount>=5000&&(namedFinance||correlated||/INVESTMENT|LOAN|ADVANCE/.test(s)))possible.push(item);
  });
  const conf=vfcLedgerDedupe_(confirmed),poss=vfcLedgerDedupe_(possible);return{confirmed:conf,possible:poss,total:conf.reduce(function(s,x){return s+x.amount;},0)};
}

function vfcLedgerCreditHasPaymentMatch_(credit,debits){
  const ct=vfcLedgerTokens_(credit.counterparty||credit.description);if(!ct.length)return false;
  return(debits||[]).some(function(d){const dt=vfcLedgerTokens_(d.counterparty||d.description);if(!dt.length)return false;let m=0;ct.forEach(function(a){if(dt.some(function(b){return a===b||(a.length>=4&&b.length>=4&&(a.indexOf(b)===0||b.indexOf(a)===0));}))m++;});return m/Math.min(ct.length,dt.length)>=0.5;});
}

function vfcLedgerBestRelatedObserved_(credit,observed){
  const ct=vfcLedgerTokens_(credit.counterparty||credit.description);let best=null,bestScore=0;(observed||[]).forEach(function(g){const gt=vfcLedgerTokens_(g.counterparty||g.description);if(!ct.length||!gt.length)return;let m=0;ct.forEach(function(a){if(gt.some(function(b){return a===b||(a.length>=4&&b.length>=4&&(a.indexOf(b)===0||b.indexOf(a)===0));}))m++;});const score=m/Math.min(ct.length,gt.length);if(score>bestScore){bestScore=score;best=g;}});return bestScore>=0.5?best:null;
}

/* ========================= totals / cache ========================= */

function vfcLedgerStoredTotals_(row){if(row.opening===null||row.closing===null||row.deposits===null||row.withdrawals===null)return{ok:false};const diff=Math.abs((row.opening+row.deposits-row.withdrawals)-row.closing);if(diff>VFC_BANKING_PURE.RECONCILE_TOLERANCE)return{ok:false,diff:diff};return{ok:true,opening:row.opening,closing:row.closing,deposits:row.deposits,withdrawals:row.withdrawals,diff:diff};}
function vfcLedgerPayloadUsable_(p,recent){if(!p||p.modelVersion!==VFC_BANKING_PURE.VERSION)return false;if(!(vfcLedgerPositive_(p.totalDeposits)>0)||p.totalWithdrawals<0)return false;if(recent&&!p.transactionsVerified)return false;return true;}
function vfcLedgerParse_(s){s=String(s||'');if(s.indexOf(VFC_BANKING_PURE.PREFIX)!==0)return null;try{return JSON.parse(s.slice(VFC_BANKING_PURE.PREFIX.length));}catch(e){return null;}}

/* ========================= helpers ========================= */

function vfcLedgerBaseFeatures_(companyName,period){if(typeof buildPowerFeatures_==='function')return buildPowerFeatures_(companyName,period);if(typeof buildFeaturesForCase_==='function')return buildFeaturesForCase_(companyName,period);return null;}
function vfcLedgerRequest_(a,p){if(a&&typeof a==='object')return{companyName:String(a.companyName||'').trim(),period:String(a.period||p||'').trim()};return{companyName:String(a||'').trim(),period:String(p||'').trim()};}
function vfcLedgerStatementKey_(r){const s=vfcLedgerIso_(r.startDate),e=vfcLedgerIso_(r.endDate);return(s&&e?s+'|'+e:vfcLedgerNorm_(r.fileName))+'|'+vfcLedgerNorm_(r.bank);}
function vfcLedgerHeader_(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcLedgerNorm_(s){return String(s||'').trim().toLowerCase().replace(/\s+/g,' ');}
function vfcLedgerSame_(a,b){return vfcLedgerNorm_(a)===vfcLedgerNorm_(b);}
function vfcLedgerNumber_(v){const n=Number(String(v==null?'':v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0;}
function vfcLedgerNullable_(v){if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null;}
function vfcLedgerPositive_(v){return Math.max(0,vfcLedgerNumber_(v));}
function vfcLedgerBool_(v){return /^(true|yes|y|1)$/i.test(String(v||'').trim())||/negative/i.test(String(v||''));}
function vfcLedgerRound_(v,step){step=step||.01;return Math.round(v/step)*step;}
function vfcLedgerDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcLedgerIso_(v){const d=vfcLedgerDate_(v);if(!d)return String(v||'').match(/^\d{4}-\d{2}-\d{2}$/)?String(v):'';return Utilities.formatDate(d,Session.getScriptTimeZone()||'GMT','yyyy-MM-dd');}
function vfcLedgerTime_(v){const d=vfcLedgerDate_(v);return d?d.getTime():0;}
function vfcLedgerSum_(a){return(a||[]).reduce(function(s,x){return s+vfcLedgerNumber_(x);},0);}
function vfcLedgerMedian_(a){const x=(a||[]).slice().sort(function(m,n){return m-n;});if(!x.length)return 0;const k=Math.floor(x.length/2);return x.length%2?x[k]:(x[k-1]+x[k])/2;}
function vfcLedgerCv_(a){if(!a||!a.length)return 0;const mean=vfcLedgerSum_(a)/a.length;if(!mean)return 0;const variance=a.reduce(function(s,x){return s+Math.pow(x-mean,2);},0)/a.length;return Math.sqrt(variance)/mean;}
function vfcLedgerTrend_(a){if(!a||a.length<2)return 0;const first=a.slice(0,Math.ceil(a.length/2)),last=a.slice(Math.floor(a.length/2));const f=vfcLedgerSum_(first)/first.length,l=vfcLedgerSum_(last)/last.length;return f?(l-f)/f:0;}
function vfcLedgerDedupe_(a){const out=[],seen={};(a||[]).forEach(function(t){const k=[t.date,t.direction,t.amount,String(t.description||'').toUpperCase()].join('|');if(!seen[k]){seen[k]=1;out.push(t);}});return out;}
function vfcLedgerTokens_(s){const stop={BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,LOAN:1,CREDIT:1,DEBIT:1,THE:1,INC:1,LTD:1,CORP:1,CORPORATION:1,COMPANY:1};return String(s||'').toUpperCase().replace(/[^A-Z0-9 ]/g,' ').split(/\s+/).filter(function(x){return x.length>=3&&!stop[x]&&!/^\d+$/.test(x);});}
function vfcLedgerCounterpartyKey_(s){const t=vfcLedgerTokens_(s);return t.slice(0,4).join('_')||String(s||'').toUpperCase().replace(/[^A-Z0-9]+/g,'_').slice(0,60);}
