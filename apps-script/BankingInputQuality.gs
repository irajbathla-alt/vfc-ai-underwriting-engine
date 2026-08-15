const VFC_BANKING_PURE = {
  VERSION: 'VFC-BANKING-PURE-3.4-STRICT-CREDITS',
  PREFIX: 'VFC_BANK_PURE_V34:',
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  MAX_TEXT_CHARS: 50000,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_LOOKBACK_DAYS: 60
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING_PURE.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    ledgerCapturedDuringIntake: true,
    liveBankingAppliesToCurrentBorrowerOnly: true,
    bankAgnostic: true,
    usesIntakeHeaderTotals: true,
    transactionDirectionLocked: true,
    creditsNeverCountAsDebt: true,
    recurrenceCalculatedFromObservedCashflow: true,
    revolvingSweepSeparated: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcBankRequest_(companyOrRequest, requestedPeriod);
    return {
      ok: true,
      modelVersion: VFC_BANKING_PURE.VERSION,
      companyName: req.companyName,
      period: req.period || requestedPeriod || '',
      deferredToAssessment: true,
      errors: []
    };
  } catch (e) {
    return {
      ok: false,
      modelVersion: VFC_BANKING_PURE.VERSION,
      errors: [String(e && e.message || e)]
    };
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

function vfcBankCreateIntakePayload_(summary, fileName) {
  summary = summary || {};
  const opening = vfcBankNullable_(summary.opening_balance);
  const closing = vfcBankNullable_(summary.closing_balance);
  const deposits = vfcBankNullable_(summary.total_deposits);
  const withdrawals = vfcBankNullable_(summary.total_withdrawals);
  const diff = (
    opening !== null && closing !== null &&
    deposits !== null && withdrawals !== null
  ) ? vfcBankRound_((opening + deposits - withdrawals) - closing, .01) : null;

  const payload = {
    version: 34,
    modelVersion: VFC_BANKING_PURE.VERSION,
    fileName: String(fileName || ''),
    bankName: String(summary.bank_name || 'Unknown'),
    statementStartDate: vfcBankIso_(summary.statement_start_date),
    statementEndDate: vfcBankIso_(summary.statement_end_date),
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: deposits,
    totalWithdrawals: withdrawals,
    reconciliationDifference: diff,
    nsfCount: Math.max(0, vfcBankNumber_(summary.nsf_count)),
    negativeBalanceDetected: vfcBankBool_(summary.negative_balance_detected),
    transactionsVerified: true,
    transactions: vfcBankNormalizeTransactions_(summary.banking_transactions || []),
    source: 'INTAKE_SINGLE_PASS',
    analyzedAt: new Date().toISOString()
  };
  return VFC_BANKING_PURE.PREFIX + JSON.stringify(payload);
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName,period)
    : (typeof buildFeaturesForCase_ === 'function'
      ? buildFeaturesForCase_(companyName,period)
      : null);
  if (!base) return null;

  const rows = vfcBankSelectedRows_(companyName,period);
  if (!rows.length) return base;

  const prepared = vfcBankPrepareRows_(rows);
  if (prepared.errors.length) {
    throw new Error('Unable to verify uploaded bank statement(s): ' + prepared.errors.join(' | '));
  }

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
    audit.push({
      fileName:x.row.fileName,
      bank:p.bankName,
      start:p.statementStartDate,
      end:p.statementEndDate,
      totalDeposits:p.totalDeposits,
      totalWithdrawals:p.totalWithdrawals,
      reconciliationDifference:p.reconciliationDifference,
      transactionsVerified:p.transactionsVerified,
      source:p.source || ''
    });
  });

  const recent = prepared.rows.slice(Math.max(0,prepared.rows.length-VFC_BANKING_PURE.DEBT_LOOKBACK));
  const debt = vfcBankDebtProfile_(recent, prepared.rows);
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
    inputQualityAudit:{
      modelVersion:VFC_BANKING_PURE.VERSION,
      statementAudit:audit,
      warnings:debt.warnings
    }
  });
}

function vfcBankSelectedRows_(companyName,period){
  const all=vfcBankSummaryRows_(companyName,period);
  if(!all.length)return[];
  const map={};
  all.forEach(function(r){
    const k=vfcBankStatementKey_(r);
    const old=map[k];
    if(!old||vfcBankTime_(r.createdAt)>=vfcBankTime_(old.createdAt))map[k]=r;
  });
  const rows=Object.keys(map).map(function(k){return map[k];});
  rows.sort(function(a,b){
    return (vfcBankDate_(a.endDate)||vfcBankDate_(a.startDate)||new Date(0))-
      (vfcBankDate_(b.endDate)||vfcBankDate_(b.startDate)||new Date(0));
  });
  return rows.slice(Math.max(0,rows.length-VFC_BANKING_PURE.MAX_STATEMENTS));
}

function vfcBankSummaryRows_(companyName,period){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if(!sh||sh.getLastRow()<2)return[];
  const values=sh.getDataRange().getValues();
  const headers=values[0].map(vfcBankHeader_);
  const idx={};
  headers.forEach(function(h,i){idx[h]=i;});
  function val(r,n){const i=idx[vfcBankHeader_(n)];return i===undefined?'':r[i];}
  const out=[];
  for(let i=1;i<values.length;i++){
    const r=values[i];
    const company=String(val(r,'Company Name')||'').trim();
    const detected=String(val(r,'Detected Period')||'').trim();
    if(companyName&&!vfcBankSame_(company,companyName))continue;
    if(period&&!vfcBankSame_(detected,period))continue;
    out.push({
      rowNumber:i+1,
      signalColumn:idx[vfcBankHeader_('Possible MCA Or Loan Payments')]===undefined
        ? -1
        : idx[vfcBankHeader_('Possible MCA Or Loan Payments')]+1,
      uploadId:String(val(r,'Upload ID')||'').trim(),
      companyName:company,
      period:detected,
      fileName:String(val(r,'File Name')||'').trim(),
      bank:String(val(r,'Bank Name')||'').trim(),
      startDate:val(r,'Statement Start Date'),
      endDate:val(r,'Statement End Date'),
      opening:vfcBankNullable_(val(r,'Opening Balance')),
      closing:vfcBankNullable_(val(r,'Closing Balance')),
      deposits:vfcBankNullable_(val(r,'Total Deposits')),
      withdrawals:vfcBankNullable_(val(r,'Total Withdrawals')),
      nsf:vfcBankNumber_(val(r,'NSF Count')),
      negative:vfcBankBool_(val(r,'Negative Balance Detected')),
      signalRaw:String(val(r,'Possible MCA Or Loan Payments')||''),
      createdAt:val(r,'Created At')
    });
  }
  return out;
}

function vfcBankPrepareRows_(rows){
  const uploads=vfcBankUploadIndex_();
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  const out=[];
  const errors=[];

  rows.forEach(function(row,index){
    const recent=index>=Math.max(0,rows.length-VFC_BANKING_PURE.DEBT_LOOKBACK);
    let p=vfcBankParsePayload_(row.signalRaw);

    if(!vfcBankPayloadUsable_(p,recent)){
      try{
        const totals=vfcBankTotals_(row);
        if(!totals.ok)throw new Error('statement totals do not reconcile');

        let transactions=[];
        if(recent){
          const upload=vfcBankResolveUpload_(row,uploads);
          if(!upload||!upload.fileId)throw new Error('uploaded PDF file ID not found');
          const text=extractTextFromPdf_(upload.fileId);
          const raw=vfcBankExtractTransactions_(text,row);
          transactions=vfcBankNormalizeTransactions_(raw.transactions||[]);
        }

        p={
          version:34,
          modelVersion:VFC_BANKING_PURE.VERSION,
          fileName:row.fileName,
          bankName:row.bank||'Unknown',
          statementStartDate:vfcBankIso_(row.startDate),
          statementEndDate:vfcBankIso_(row.endDate),
          openingBalance:totals.opening,
          closingBalance:totals.closing,
          totalDeposits:totals.deposits,
          totalWithdrawals:totals.withdrawals,
          reconciliationDifference:totals.diff,
          nsfCount:Math.max(0,row.nsf||0),
          negativeBalanceDetected:!!row.negative,
          transactionsVerified:recent,
          transactions:transactions,
          source:recent?'LEGACY_FALLBACK_READ':'INTAKE_TOTALS_ONLY',
          analyzedAt:new Date().toISOString()
        };
        if(row.signalColumn>0){
          sh.getRange(row.rowNumber,row.signalColumn)
            .setValue(VFC_BANKING_PURE.PREFIX+JSON.stringify(p));
        }
      }catch(e){
        errors.push(row.fileName+': '+String(e&&e.message||e));
        return;
      }
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
    'Extract financing/loan/PAD/MCA/capital/advance/funding transactions, loan interest, tax/government, insurance/premium finance and credit-card payments.',
    'Also extract incoming credits of $5,000 or more when the description/counterparty could plausibly be financing. Deterministic code will classify them later.',
    'Do not extract ordinary suppliers, payroll, customer receipts, utilities, fuel/gas, phone or bank fees unless clearly financing/tax/insurance.',
    'Never duplicate cheque-image pages. If uncertain, omit.',
    'Metadata:'+JSON.stringify({
      fileName:row.fileName,
      start:vfcBankIso_(row.startDate),
      end:vfcBankIso_(row.endDate),
      bank:row.bank
    }),
    'STATEMENT TEXT:',
    String(text||'').substring(0,VFC_BANKING_PURE.MAX_TEXT_CHARS)
  ].join('\n');
  return callOpenAIJson_(prompt)||{};
}

function vfcBankDebtProfile_(recentRows, allRows){
  const recentTx=[];
  (recentRows||[]).forEach(function(x){
    (x.payload.transactions||[]).forEach(function(t){recentTx.push(t);});
  });

  const allTx=[];
  (allRows||recentRows||[]).forEach(function(x){
    (x.payload.transactions||[]).forEach(function(t){allTx.push(t);});
  });

  const debtGroups={};
  const otherGroups={};
  const genericLoanCredits=[];
  const genericLoanPayments=[];

  recentTx.forEach(function(t){
    const d=String(t.description||'').toUpperCase();
    const dir=t.direction;
    const amount=vfcBankNumber_(t.amount);
    if(!(amount>0))return;

    if(dir==='CREDIT'){
      if(/\bLOAN CREDIT\b/.test(d))genericLoanCredits.push(t);
      return;
    }
    if(dir!=='DEBIT')return;

    if(/^LOAN PAYMENT\b/.test(d)&&!/NO\.|NUMBER|#/.test(d)){
      genericLoanPayments.push(t);
      return;
    }

    if(/SUPERPASS|HYDRO|FORTIS|GAS BILL|TELUS|ROGERS|PHONE|PAY-FILE|BANK FEE/.test(d))return;

    if(/CRA|CCRA|GST|HST|TAX|EMPTX|TXINS|INSURANCE|IPFS|PREMIUM FINANCE|CREDIT CARD/.test(d)){
      vfcBankAddGroup_(otherGroups,t,'OTHER');
      return;
    }

    if(/\bPAD\b|\bMCA\b|MERCH|MERCHANT|BDC|JOURNEY|ONDECK|LOAN PAYMENT|LOAN INTEREST|FINANC|ADVANCE/.test(d)){
      vfcBankAddGroup_(debtGroups,t,'DEBT');
    }
  });

  const active=[];
  const observed=[];
  const other=[];
  const latestDate=vfcBankLatestStatementDate_(recentRows);

  Object.keys(debtGroups).forEach(function(k){
    const g=debtGroups[k];
    const months=vfcBankDistinctMonths_(g.items);
    const occ=g.items.length;
    const total=g.items.reduce(function(s,t){return s+t.amount;},0);
    const first=vfcBankEarliestDate_(g.items);
    const last=vfcBankLatestDate_(g.items);
    const activeMonths=vfcBankActiveMonthCount_(first,latestDate);
    const monthly=total/Math.max(1,activeMonths);
    const item=vfcBankGroupItem_(g,monthly,occ,months);
    item.active = !latestDate || !last
      ? true
      : vfcBankDaysBetween_(last,latestDate)<=VFC_BANKING_PURE.ACTIVE_LOOKBACK_DAYS;

    if(occ>=2&&months>=2&&item.active)active.push(item);
    else observed.push(item);
  });

  Object.keys(otherGroups).forEach(function(k){
    const g=otherGroups[k];
    const total=g.items.reduce(function(s,t){return s+t.amount;},0);
    const first=vfcBankEarliestDate_(g.items);
    const activeMonths=vfcBankActiveMonthCount_(first,latestDate);
    other.push(vfcBankGroupItem_(
      g,
      total/Math.max(1,activeMonths),
      g.items.length,
      vfcBankDistinctMonths_(g.items)
    ));
  });

  const financingCredits=[];
  allTx.forEach(function(t){
    if(t.direction!=='CREDIT'||!(vfcBankNumber_(t.amount)>0))return;
    if(vfcBankIsFinancingCredit_(t,debtGroups)){
      financingCredits.push(Object.assign({},t,{classification:'FINANCING_CREDIT'}));
    }
  });

  const creditTotal=financingCredits.reduce(function(s,t){return s+t.amount;},0);
  const confirmed=active.reduce(function(s,x){return s+x.monthlyEquivalent;},0);
  const otherMonthly=other.reduce(function(s,x){return s+x.monthlyEquivalent;},0);

  const sweep=genericLoanCredits.length&&genericLoanPayments.length
    ? [{
        type:'REVOLVING_LOAN_SWEEP',
        creditOccurrences:genericLoanCredits.length,
        paymentOccurrences:genericLoanPayments.length,
        totalCredits:vfcBankRound_(
          genericLoanCredits.reduce(function(s,t){return s+t.amount;},0),.01
        ),
        totalPayments:vfcBankRound_(
          genericLoanPayments.reduce(function(s,t){return s+t.amount;},0),.01
        ),
        includedInMonthlyDebt:false
      }]
    : [];

  const warnings=[];
  if(sweep.length){
    warnings.push(
      'Generic LOAN CREDIT/LOAN PAYMENT activity is treated as revolving sweep activity, not fixed monthly debt.'
    );
  }
  if(observed.length){
    warnings.push(
      'New or insufficient-history financing activity is shown separately and is not converted into recurring monthly debt.'
    );
  }

  return{
    confirmedMonthlyDebtService:vfcBankRound_(confirmed,.01),
    otherRecurringMonthlyObligations:vfcBankRound_(otherMonthly,.01),
    financingCreditsTotal:vfcBankRound_(creditTotal,.01),
    activeDebtObligations:active,
    otherRecurringObligations:other,
    financingCredits:financingCredits,
    newFinancingObserved:observed,
    revolvingFinancingActivity:sweep,
    warnings:warnings
  };
}

function vfcBankIsFinancingCredit_(t,debtGroups){
  const d=String(t.description||'').toUpperCase();
  const amount=vfcBankNumber_(t.amount);
  if(!(amount>0))return false;

  // Bank direction is already locked before this function is called.
  // Explicit financing wording is conclusive.
  if(/\bLOAN CREDIT\b/.test(d))return true;
  if(/\b(LOAN ADVANCE|LOAN PROCEEDS|CASH ADVANCE|MCA ADVANCE|FUNDING|FINANCING ADVANCE)\b/.test(d))return true;

  // Internal transfers / client-request credit memos are not financing proceeds.
  if(/\bCREDIT MEMO\b/.test(d)&&/\b(CLIENT REQUEST|RETURN|TRF|TRANSFER|INTERNAL)\b/.test(d))return false;

  // A named credit can be financing when the SAME description/entity is also
  // observed making financing debits. This uses statement descriptions only;
  // it deliberately ignores the AI-provided counterparty field so a nearby
  // transaction cannot cause an ordinary credit to be misclassified.
  const groups=debtGroups||{};
  const keys=Object.keys(groups);
  for(let i=0;i<keys.length;i++){
    const items=groups[keys[i]]&&Array.isArray(groups[keys[i]].items)
      ? groups[keys[i]].items
      : [];
    for(let j=0;j<items.length;j++){
      if(vfcBankDescriptionsRelated_(t.description,items[j].description))return true;
    }
  }

  // Other explicit loan-labelled credits are financing unless the wording
  // itself says transfer/return/client-request activity.
  if(/\bLOAN\b/.test(d)&&!/\b(RETURN|TRF|TRANSFER|CLIENT REQUEST)\b/.test(d))return true;

  return false;
}

function vfcBankDescriptionsRelated_(left,right){
  const a=vfcBankEntityTokens_(left);
  const b=vfcBankEntityTokens_(right);
  if(!a.length||!b.length)return false;

  for(let i=0;i<a.length;i++){
    for(let j=0;j<b.length;j++){
      if(a[i]===b[j])return true;
      if(a[i].length>=4&&b[j].length>=4&&
         (a[i].indexOf(b[j])===0||b[j].indexOf(a[i])===0))return true;
    }
  }
  return false;
}

function vfcBankEntityTokens_(description){
  const stop={
    BUSINESS:1,INVESTMENT:1,PAD:1,PAYMENT:1,PAY:1,LOAN:1,CREDIT:1,DEBIT:1,
    FINANCING:1,FINANCE:1,INTEREST:1,ADVANCE:1,FUNDING:1,FUND:1,CAPITAL:1,
    DIRECT:1,DEPOSIT:1,MISC:1,EFT:1,PREAUTHORIZED:1,PREAUTH:1,TRANSFER:1,
    ONLINE:1,BANKING:1,CLIENT:1,REQUEST:1,RETURN:1,TRF:1
  };
  return String(description||'').toUpperCase()
    .replace(/[^A-Z0-9]+/g,' ')
    .trim().split(/\s+/)
    .filter(function(token){
      if(!token||stop[token])return false;
      if(/^\d+$/.test(token))return false;
      return token.length>=3;
    });
}

function vfcBankAddGroup_(map,t,type){
  const key=vfcBankCounterpartyKey_(t);
  if(!map[key])map[key]={key:key,type:type,items:[]};
  map[key].items.push(t);
}

function vfcBankGroupItem_(g,monthly,occ,months){
  const vals=g.items.map(function(t){return t.amount;}).sort(function(a,b){return a-b;});
  const dates=g.items.map(function(t){return t.date;}).sort();
  return{
    counterparty:g.items[0].counterparty||g.items[0].description,
    description:g.items[0].description,
    category:g.type,
    paymentAmount:vfcBankRound_(vfcBankMedian_(vals),.01),
    frequency:'Observed cash flow',
    monthlyEquivalent:vfcBankRound_(monthly,.01),
    occurrences:occ,
    monthsObserved:months,
    firstSeen:dates[0]||'',
    lastSeen:dates.length?dates[dates.length-1]:'',
    active:true,
    confidence:(occ>=3&&months>=2)?'High':'Moderate'
  };
}

function vfcBankCounterpartyKey_(t){
  const description=String(t.description||'').toUpperCase();
  const numberMatch=description.match(/NO\.?\s*\d+/);
  if(numberMatch)return'LOAN_'+numberMatch[0].replace(/\s+/g,'');

  let s=String(t.counterparty||t.description||'').toUpperCase();
  if(/MERCH/.test(s))return'MERCHANT';
  if(/BDC/.test(s))return'BDC';
  if(/JOURNEY|ONDECK/.test(s))return'JOURNEY_ONDECK';

  return s
    .replace(/\b(PAD|PAYMENT|LOAN|BUSINESS|INVESTMENT|FINANCING|INTEREST|ADVANCE|FUNDING)\b/g,' ')
    .replace(/[^A-Z0-9]+/g,' ')
    .trim()
    .substring(0,60)||'UNKNOWN';
}

function vfcBankDistinctMonths_(items){
  const s={};
  (items||[]).forEach(function(t){
    if(/^\d{4}-\d{2}/.test(t.date))s[t.date.slice(0,7)]=1;
  });
  return Object.keys(s).length;
}

function vfcBankActiveMonthCount_(firstDate,latestDate){
  const a=vfcBankDate_(firstDate);
  const b=vfcBankDate_(latestDate);
  if(!a||!b)return 1;
  return Math.max(1,(b.getFullYear()-a.getFullYear())*12+(b.getMonth()-a.getMonth())+1);
}

function vfcBankLatestStatementDate_(rows){
  let latest=null;
  (rows||[]).forEach(function(x){
    const d=vfcBankDate_(x.payload.statementEndDate||x.row.endDate);
    if(d&&(!latest||d>latest))latest=d;
  });
  return latest?Utilities.formatDate(latest,Session.getScriptTimeZone(),'yyyy-MM-dd'):'';
}

function vfcBankEarliestDate_(items){
  const dates=(items||[]).map(function(t){return vfcBankDate_(t.date);}).filter(Boolean).sort(function(a,b){return a-b;});
  return dates.length?Utilities.formatDate(dates[0],Session.getScriptTimeZone(),'yyyy-MM-dd'):'';
}

function vfcBankLatestDate_(items){
  const dates=(items||[]).map(function(t){return vfcBankDate_(t.date);}).filter(Boolean).sort(function(a,b){return a-b;});
  return dates.length?Utilities.formatDate(dates[dates.length-1],Session.getScriptTimeZone(),'yyyy-MM-dd'):'';
}

function vfcBankDaysBetween_(left,right){
  const a=vfcBankDate_(left),b=vfcBankDate_(right);
  if(!a||!b)return 0;
  return Math.abs(b-a)/(1000*60*60*24);
}

function vfcBankNormalizeTransactions_(items){
  if(!Array.isArray(items))return[];
  const out=[],seen={};
  items.forEach(function(x){
    x=x||{};
    const date=vfcBankIso_(x.date);
    const desc=String(x.description||'').replace(/\s+/g,' ').trim();
    const dir=String(x.direction||'').toUpperCase();
    const amount=vfcBankPositive_(x.amount);
    if(!date||!desc||(dir!=='DEBIT'&&dir!=='CREDIT')||!(amount>0))return;
    const t={
      date:date,
      description:desc.substring(0,240),
      counterparty:String(x.counterparty||desc).replace(/\s+/g,' ').trim().substring(0,140),
      direction:dir,
      amount:vfcBankRound_(amount,.01)
    };
    const k=[t.date,t.direction,t.amount,t.description.toUpperCase()].join('|');
    if(!seen[k]){
      seen[k]=1;
      out.push(t);
    }
  });
  return out;
}

function vfcBankTotals_(r){
  const o=r.opening,c=r.closing,d=r.deposits,w=r.withdrawals;
  if(o===null||c===null||d===null||w===null||!(d>=0)||!(w>=0))return{ok:false};
  const diff=vfcBankRound_((o+d-w)-c,.01);
  return{
    ok:Math.abs(diff)<=VFC_BANKING_PURE.RECONCILE_TOLERANCE,
    opening:o,
    closing:c,
    deposits:d,
    withdrawals:w,
    diff:diff
  };
}

function vfcBankPayloadUsable_(p,recent){
  if(!p||p.version!==34||p.modelVersion!==VFC_BANKING_PURE.VERSION)return false;
  if(p.openingBalance===null||p.closingBalance===null||p.totalDeposits===null||p.totalWithdrawals===null)return false;
  if(!(p.totalDeposits>=0)||!(p.totalWithdrawals>=0))return false;
  if(p.reconciliationDifference===null||Math.abs(vfcBankNumber_(p.reconciliationDifference))>VFC_BANKING_PURE.RECONCILE_TOLERANCE)return false;
  if(recent&&!p.transactionsVerified)return false;
  if(recent&&!Array.isArray(p.transactions))return false;
  return true;
}

function vfcBankParsePayload_(raw){
  raw=String(raw||'').trim();
  if(raw.indexOf(VFC_BANKING_PURE.PREFIX)!==0)return null;
  try{return JSON.parse(raw.slice(VFC_BANKING_PURE.PREFIX.length));}
  catch(e){return null;}
}

function vfcBankUploadIndex_(){
  const rows=typeof getSheetObjects_==='function'?getSheetObjects_('Uploads'):[];
  const idx={byId:{},byExact:{},byCompanyFile:{},byFile:{}};
  rows.forEach(function(r){
    const uploadId=String(r.uploadId||'').trim();
    const company=String(r.companyName||'').trim();
    const period=String(r.detectedPeriod||'').trim();
    const fileName=String(r.fileName||'').trim();
    let fileId=String(r.fileId||'').trim();
    const link=String(r.fileLink||'').trim();
    if(!fileId&&link){
      const m=link.match(/[-\w]{20,}/);
      if(m)fileId=m[0];
    }
    if(!fileId)return;
    const item={
      uploadId:uploadId,
      companyName:company,
      period:period,
      fileName:fileName,
      fileId:fileId,
      createdAt:r.createdAt||''
    };
    if(uploadId)idx.byId[uploadId]=item;
    vfcBankKeepNewest_(
      idx.byExact,
      vfcBankNorm_(company)+'|'+vfcBankNorm_(period)+'|'+vfcBankNorm_(fileName),
      item
    );
    vfcBankKeepNewest_(
      idx.byCompanyFile,
      vfcBankNorm_(company)+'|'+vfcBankNorm_(fileName),
      item
    );
    vfcBankKeepNewest_(
      idx.byFile,
      vfcBankNorm_(fileName),
      item
    );
  });
  return idx;
}

function vfcBankResolveUpload_(r,idx){
  if(r.uploadId&&idx.byId[r.uploadId])return idx.byId[r.uploadId];
  return idx.byExact[
    vfcBankNorm_(r.companyName)+'|'+vfcBankNorm_(r.period)+'|'+vfcBankNorm_(r.fileName)
  ]||idx.byCompanyFile[
    vfcBankNorm_(r.companyName)+'|'+vfcBankNorm_(r.fileName)
  ]||idx.byFile[vfcBankNorm_(r.fileName)]||null;
}

function vfcBankKeepNewest_(map,key,item){
  if(!key)return;
  const old=map[key];
  if(!old||vfcBankTime_(item.createdAt)>=vfcBankTime_(old.createdAt))map[key]=item;
}

function vfcBankRequest_(x,p){
  if(typeof x==='string')return{companyName:String(x).trim(),period:String(p||'').trim()};
  x=x||{};
  return{
    companyName:String(x.companyName||x.company||'').trim(),
    period:String(x.period||p||'').trim()
  };
}
function vfcBankStatementKey_(r){
  const s=vfcBankIso_(r.startDate),e=vfcBankIso_(r.endDate);
  return s&&e?s+'|'+e:vfcBankNorm_(r.fileName);
}
function vfcBankHeader_(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');}
function vfcBankSame_(a,b){return vfcBankNorm_(a)===vfcBankNorm_(b);}
function vfcBankNorm_(v){return String(v||'').trim().toLowerCase().replace(/\s+/g,' ');}
function vfcBankNullable_(v){
  if(v===null||v===undefined||String(v).trim()==='')return null;
  const n=vfcBankNumber_(v);
  return isFinite(n)?n:null;
}
function vfcBankNumber_(v){
  if(typeof v==='number')return isFinite(v)?v:0;
  const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));
  return isFinite(n)?n:0;
}
function vfcBankPositive_(v){return Math.max(0,vfcBankNumber_(v));}
function vfcBankBool_(v){return /yes|true|detected|negative|1/i.test(String(v||''));}
function vfcBankRound_(v,step){step=step||1;return Math.round((Number(v)||0)/step)*step;}
function vfcBankDate_(v){if(!v)return null;const d=new Date(v);return isNaN(d.getTime())?null:d;}
function vfcBankIso_(v){
  const d=vfcBankDate_(v);
  if(!d)return'';
  return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd');
}
function vfcBankTime_(v){const d=vfcBankDate_(v);return d?d.getTime():0;}
function vfcBankMedian_(a){
  if(!a.length)return 0;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
