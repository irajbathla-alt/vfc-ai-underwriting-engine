function vfcPureBuildFeatures_(base, verifiedRows) {
  let totalDeposits=0, totalWithdrawals=0, nsf=0, negative=0;
  const monthlyDeposits=[], monthlyWithdrawals=[], openings=[], closings=[], audit=[];
  verifiedRows.forEach(function(x) {
    const p=x.payload;
    totalDeposits+=p.totalDeposits; totalWithdrawals+=p.totalWithdrawals;
    monthlyDeposits.push(p.totalDeposits); monthlyWithdrawals.push(p.totalWithdrawals);
    openings.push(p.openingBalance); closings.push(p.closingBalance);
    nsf+=Math.max(0,vfcPureNumber_(p.nsfCount)); if(p.negativeBalanceDetected) negative=1;
    audit.push({
      fileName:x.row.fileName,
      bankId:p.bankId,
      bank:p.bankName,
      statementStartDate:p.statementStartDate,
      statementEndDate:p.statementEndDate,
      totalDeposits:p.totalDeposits,
      totalWithdrawals:p.totalWithdrawals,
      openingBalance:p.openingBalance,
      closingBalance:p.closingBalance,
      reconciliationDifference:p.reconciliationDifference,
      totalsSource:p.totalsSource,
      transactionsVerified:p.transactionsVerified,
      verified:true
    });
  });

  const recent=verifiedRows.slice(Math.max(0,verifiedRows.length-VFC_BANK_ENGINE.DEBT_LOOKBACK));
  const debt=vfcPureDebtProfile_(recent);
  const months=Math.max(1,verifiedRows.length);
  const grossMonthly=totalDeposits/months;
  const operatingTotal=Math.max(0,totalDeposits-debt.financingCreditsTotal);
  const operatingMonthly=operatingTotal/months;
  const warnings=[];
  if(debt.revolvingFinancingActivity.length) warnings.push('Generic LOAN CREDIT / LOAN PAYMENT sweep activity is excluded from fixed monthly debt.');
  if(debt.possibleFinancingCredits.length) warnings.push('Possible financing credits are shown separately and are not removed from operating deposits unless confirmed.');
  if(debt.inactiveInformationalObligations.length) warnings.push('Stale informational obligations are shown without a fabricated monthly equivalent.');

  const result = Object.assign({},base,{
    statementCount:verifiedRows.length,
    monthsCovered:verifiedRows.length,
    totalDeposits:vfcPureRound_(totalDeposits,.01),
    averageMonthlyDeposits:vfcPureRound_(grossMonthly,.01),
    totalWithdrawals:vfcPureRound_(totalWithdrawals,.01),
    depositWithdrawalRatio:totalWithdrawals>0?vfcPureRound_(totalDeposits/totalWithdrawals,.01):0,
    nsfCount:nsf,
    nsfPerMonth:vfcPureRound_(nsf/months,.01),
    negativeBalanceFlag:negative,
    mcaPaymentFlag:debt.activeDebtObligations.length?1:0,
    monthlyDeposits:monthlyDeposits,
    monthlyWithdrawals:monthlyWithdrawals,
    depositVolatility:vfcPureRound_(vfcPureCv_(monthlyDeposits),.01),
    depositTrend:vfcPureRound_(vfcPureTrend_(monthlyDeposits),.01),
    averageOpeningBalance:vfcPureRound_(vfcPureSum_(openings)/Math.max(1,openings.length),.01),
    averageClosingBalance:vfcPureRound_(vfcPureSum_(closings)/Math.max(1,closings.length),.01),
    estimatedOperatingTotalDeposits:vfcPureRound_(operatingTotal,.01),
    estimatedOperatingMonthlyDeposits:vfcPureRound_(operatingMonthly,.01),
    detectedFinancingCredits:vfcPureRound_(debt.financingCreditsTotal,.01),
    existingMonthlyDebtService:vfcPureRound_(debt.confirmedMonthlyDebtService,.01),
    informationalRecurringMonthlyObligations:vfcPureRound_(debt.informationalMonthlyObligations,.01),
    otherRecurringMonthlyObligations:vfcPureRound_(debt.informationalMonthlyObligations,.01),
    debtServiceToDepositsRatio:grossMonthly>0?vfcPureRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001):0,
    debtProfile:debt,
    inputQualityAudit:{
      modelVersion:VFC_BANK_ENGINE.VERSION,
      factsVersion:VFC_BANK_ENGINE.FACTS_VERSION,
      rulesVersion:VFC_BANK_ENGINE.RULES_VERSION,
      verified:true,
      selectedStatementRows:verifiedRows.length,
      grossAverageMonthlyDeposits:vfcPureRound_(grossMonthly,.01),
      estimatedOperatingMonthlyDeposits:vfcPureRound_(operatingMonthly,.01),
      statementAudit:audit,
      warnings:warnings
    }
  });

  result.resultFingerprint = vfcPureResultFingerprint_(result);
  result.inputQualityAudit.resultFingerprint = result.resultFingerprint;
  return result;
}

function vfcPureDebtProfile_(recentRows) {
  let transactions=[];
  let latestStatementEnd='';
  recentRows.forEach(function(x) {
    if (!latestStatementEnd || vfcPureTime_(x.payload.statementEndDate) > vfcPureTime_(latestStatementEnd)) latestStatementEnd=x.payload.statementEndDate;
    (x.payload.transactions||[]).forEach(function(t){
      transactions.push(Object.assign({ statementEnd:x.payload.statementEndDate, bankId:x.payload.bankId || 'UNKNOWN' },t));
    });
  });

  transactions=vfcPureDedupeTransactions_(transactions);
  const debits=transactions.filter(function(t){return t.direction==='DEBIT';});
  const credits=transactions.filter(function(t){return t.direction==='CREDIT';});

  const classifiedDebits=debits.map(vfcPureClassifyDebit_).filter(Boolean);
  const groups={};
  classifiedDebits.forEach(function(t){
    const key=t.family+'|'+t.entityKey;
    if(!groups[key]) groups[key]={family:t.family,entityKey:t.entityKey,label:t.label,items:[]};
    groups[key].items.push(t);
  });

  const loanCredits=credits.filter(function(c){return /\bLOAN\s+CREDIT\b/i.test(c.description);});
  const hasSweep=loanCredits.length>=2;
  let allGroups=Object.keys(groups).sort().map(function(k){
    return vfcPureSummarizeEntity_(groups[k],latestStatementEnd);
  }).filter(Boolean);

  // Generic amount/cadence merge pass: different labels can still be the same obligation.
  allGroups=vfcPureMergeGenericAmountMatches_(allGroups);

  const revolving=[];
  const active=[];
  const tax=[];
  const other=[];
  const inactiveInfo=[];
  const observedOnce=[];

  allGroups.forEach(function(g){
    if(hasSweep && g.family==='FINANCING' && g.entityKey==='GENERIC_LOAN_PAYMENT') { revolving.push(g); return; }
    if(!g.recurring) { observedOnce.push(g); return; }

    if(g.family==='FINANCING' || g.family==='MCA' || g.family==='PAD') {
      if(g.active) active.push(g); else observedOnce.push(g);
    } else if(g.family==='TAX') {
      if(g.active) tax.push(g); else inactiveInfo.push(g);
    } else {
      if(g.active) other.push(g); else inactiveInfo.push(g);
    }
  });

  const creditResult=vfcPureFinancingCredits_(credits, classifiedDebits);
  const confirmedMonthly=active.reduce(function(s,g){return s+g.monthlyEquivalent;},0);
  const infoMonthly=tax.concat(other).reduce(function(s,g){return s+g.monthlyEquivalent;},0);

  // Deterministic display order: highest current debt first, then label.
  active.sort(vfcPureObligationSort_);
  tax.sort(vfcPureObligationSort_);
  other.sort(vfcPureObligationSort_);
  inactiveInfo.sort(vfcPureObligationSort_);
  observedOnce.sort(vfcPureObligationSort_);

  return {
    confirmedMonthlyDebtService:vfcPureRound_(confirmedMonthly,.01),
    informationalMonthlyObligations:vfcPureRound_(infoMonthly,.01),
    activeDebtObligations:active,
    revolvingFinancingActivity:revolving,
    taxGovernmentPads:tax,
    otherRecurringObligations:other,
    inactiveInformationalObligations:inactiveInfo,
    observedOnce:observedOnce,
    allDetectedObligations:allGroups,
    financingCredits:creditResult.confirmed,
    possibleFinancingCredits:creditResult.possible,
    financingCreditsTotal:vfcPureRound_(creditResult.total,.01),
    note:'Debt equals recurring financing debits observed in the recent statement window. Different descriptions may merge when amount/cadence match; the same lender may split into amount components. Generic RBC revolving sweeps are excluded from fixed monthly debt.'
  };
}

function vfcPureClassifyDebit_(t) {
  const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s)) return null;
  if(/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|PETROLEUM|FUEL/.test(s)) return null;

  let family='', entityKey='', label=t.counterparty||t.description;

  // Explicit lender/counterparty identities first.
  if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)) {
    family='MCA'; entityKey='MERCHANT_GROWTH'; label='Merchant Growth';
  } else if(/\bBDC\b/.test(s) && (/\bPAD\b|LOAN|FINANC/.test(s))) {
    family='FINANCING'; entityKey='BDC'; label='BDC';
  } else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)) {
    family='TAX'; entityKey=vfcPureCounterpartyKey_(t.counterparty||t.description); label=t.counterparty||t.description;
  } else if(/INSURANCE|\bIPFS\b|PREMIUM\s+FIN/.test(s)) {
    family='OTHER';
    if(/ICBC/.test(s)) { entityKey='INSURANCE_ICBC'; label='Auto Insurance ICBC'; }
    else if(/EQUITABLE\s+LIFE/.test(s)) { entityKey='INSURANCE_EQUITABLE_LIFE'; label='Insurance EQUITABLE LIFE'; }
    else if(/IND\s+ALL\s+LIFE/.test(s)) { entityKey='INSURANCE_IND_ALL_LIFE'; label='Insurance IND ALL LIFE IN'; }
    else if(/\bOWIC\b/.test(s)) { entityKey='INSURANCE_OWIC'; label='Insurance OWIC'; }
    else { entityKey=vfcPureCounterpartyKey_(t.counterparty||t.description); }
  } else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD/.test(s)) {
    family='OTHER'; entityKey=vfcPureCounterpartyKey_(t.counterparty||t.description); label=t.counterparty||t.description;
  } else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)) {
    family='PAD'; entityKey=vfcPureCounterpartyKey_(t.counterparty||t.description); label=t.counterparty||t.description;
  } else if(/LOAN\s+PAYMENT|LOAN\s+PYMT|LOAN\s+PMT|LOAN\s+INTEREST|\bFINANC/.test(s)) {
    family='FINANCING';
    if(/^LOAN\s+PAYMENT$/i.test(String(t.description||'').trim())) {
      entityKey='GENERIC_LOAN_PAYMENT'; label='Generic LOAN PAYMENT';
    } else {
      const loanNo=s.match(/(?:NO\.?|NUMBER)\s*([0-9-]{5,})/);
      if(loanNo) {
        const n=loanNo[1].replace(/[^0-9]/g,'');
        if(/LOAN\s+INTEREST/.test(s)) { entityKey='LOAN_INTEREST_'+n; label='Loan interest NO.'+n; }
        else { entityKey='LOAN_'+n; label='Loan payment NO.'+n; }
      } else {
        entityKey=vfcPureCounterpartyKey_(t.counterparty||t.description);
      }
    }
  } else return null;

  if(!entityKey) entityKey=vfcPureCounterpartyKey_(t.description);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label});
}

function vfcPureSummarizeEntity_(g, latestStatementEnd) {
  const items=(g.items||[]).slice().sort(function(a,b){return vfcPureDate_(a.date)-vfcPureDate_(b.date);});
  if(!items.length) return null;

  const monthTotals={}, monthCounts={};
  items.forEach(function(i){
    const m=String(i.date).slice(0,7);
    monthTotals[m]=(monthTotals[m]||0)+i.amount;
    monthCounts[m]=(monthCounts[m]||0)+1;
  });

  const distinctMonths=Object.keys(monthTotals).length;
  const occurrences=items.length;
  const recurring=(distinctMonths>=2 && occurrences>=2) || occurrences>=3;
  const amounts=items.map(function(i){return i.amount;});
  const paymentMedian=vfcPureMedian_(amounts);
  const paymentMean=vfcPureSum_(amounts)/Math.max(1,amounts.length);
  const amountCv=vfcPureCv_(amounts);
  const first=items[0], last=items[items.length-1];
  const gaps=[];
  for(let i=1;i<items.length;i++) gaps.push((vfcPureDate_(items[i].date)-vfcPureDate_(items[i-1].date))/86400000);
  const medianGap=gaps.length?vfcPureMedian_(gaps):0;
  const activeDays=vfcPureDaysBetween_(last.date,latestStatementEnd);
  const active=activeDays===null ? true : activeDays<=VFC_BANK_ENGINE.ACTIVE_DAYS;

  let frequency='Observed statement-period cash flow';
  let monthly=0;
  let method='OBSERVED_ONLY';

  const weeklyGapRatio=gaps.length?gaps.filter(function(x){return x>=5&&x<=10;}).length/gaps.length:0;
  const biweeklyGapRatio=gaps.length?gaps.filter(function(x){return x>10&&x<=18;}).length/gaps.length:0;

  if(recurring && medianGap>=5 && medianGap<=10 && occurrences>=4 && weeklyGapRatio>=0.65) {
    frequency='Weekly observed cadence';
    monthly=paymentMedian*52/12;
    method='WEEKLY_MEDIAN_X_52_12';
  } else if(recurring && medianGap>10 && medianGap<=18 && occurrences>=3 && biweeklyGapRatio>=0.55) {
    frequency='Biweekly observed cadence';
    monthly=paymentMedian*26/12;
    method='BIWEEKLY_MEDIAN_X_26_12';
  } else if(recurring && distinctMonths>=2 && occurrences===distinctMonths) {
    frequency='Monthly observed cadence';
    if(amountCv<=0.03) {
      monthly=paymentMedian;
      method='MONTHLY_FIXED_MEDIAN';
    } else {
      monthly=vfcPureMeanObjectValues_(monthTotals);
      method='MONTHLY_VARIABLE_MEAN';
    }
  } else if(recurring) {
    frequency='Multiple payments per month';
    monthly=vfcPureRecentMonthlyAverage_(monthTotals,3,latestStatementEnd);
    method='RECENT_3_MONTH_OBSERVED_AVERAGE';
  }

  // Never turn a stale informational item into a fake prorated monthly number.
  if(!active && !(g.family==='FINANCING' || g.family==='MCA' || g.family==='PAD')) {
    monthly=0;
    method='STALE_INFORMATIONAL_NO_MONTHLY_EQUIVALENT';
  }

  const components=vfcPureAmountComponents_(items);
  return {
    family:g.family,
    key:g.entityKey,
    entityKey:g.entityKey,
    counterparty:g.label,
    description:g.label,
    category:g.family==='FINANCING'?'LOAN':g.family,
    paymentAmount:vfcPureRound_(paymentMedian,.01),
    averagePayment:vfcPureRound_(paymentMean,.01),
    amountRange:{ min:vfcPureRound_(Math.min.apply(null,amounts),.01), max:vfcPureRound_(Math.max.apply(null,amounts),.01) },
    frequency:frequency,
    monthlyEquivalent:vfcPureRound_(monthly,.01),
    monthlyEquivalentMethod:method,
    occurrences:occurrences,
    distinctMonths:distinctMonths,
    firstSeen:first.date,
    lastSeen:last.date,
    daysSinceLastObserved:activeDays,
    active:active,
    recurring:recurring,
    confidence:(!recurring?'Low':(distinctMonths>=3?'High':'Moderate')),
    observedTotal:vfcPureRound_(vfcPureSum_(amounts),.01),
    observedMonthlyTotals:vfcPureSortedObject_(monthTotals),
    components:components
  };
}

/**
 * Splits one lender/description into stable amount bands.
 * This addresses same name + materially different amounts (e.g. BDC).
 */
function vfcPureAmountComponents_(items) {
  const sorted=(items||[]).slice().sort(function(a,b){return a.amount-b.amount;});
  const clusters=[];
  sorted.forEach(function(item){
    let best=null, bestDiff=Infinity;
    clusters.forEach(function(c){
      const center=vfcPureMedian_(c.items.map(function(x){return x.amount;}));
      const pct=center<2000?0.15:0.065;
      const tolerance=Math.max(12,center*pct);
      const diff=Math.abs(item.amount-center);
      if(diff<=tolerance && diff<bestDiff){best=c;bestDiff=diff;}
    });
    if(best) best.items.push(item);
    else clusters.push({items:[item]});
  });

  return clusters.map(function(c,index){
    const a=c.items.map(function(x){return x.amount;});
    const months={};
    c.items.forEach(function(x){months[String(x.date).slice(0,7)]=1;});
    return {
      componentId:'C'+(index+1),
      representativeAmount:vfcPureRound_(vfcPureMedian_(a),.01),
      averageAmount:vfcPureRound_(vfcPureSum_(a)/a.length,.01),
      minAmount:vfcPureRound_(Math.min.apply(null,a),.01),
      maxAmount:vfcPureRound_(Math.max.apply(null,a),.01),
      occurrences:a.length,
      distinctMonths:Object.keys(months).length
    };
  }).sort(function(a,b){return a.representativeAmount-b.representativeAmount;});
}

/**
 * Conservative cross-name merge. Only generic descriptions are eligible.
 * Strong name/lender identities are never merged merely because amounts match.
 */
function vfcPureMergeGenericAmountMatches_(groups) {
  const strong=/MERCHANT_GROWTH|\bBDC\b|LOAN_[0-9]|LOAN_INTEREST_[0-9]|INSURANCE_/;
  const result=[];
  (groups||[]).forEach(function(g){
    if(strong.test(String(g.entityKey||''))) { result.push(g); return; }

    let target=null;
    result.some(function(existing){
      if(strong.test(String(existing.entityKey||''))) return false;
      if(existing.family!==g.family) return false;
      if(existing.frequency!==g.frequency) return false;
      const a=existing.paymentAmount, b=g.paymentAmount;
      const tolerance=Math.max(8,Math.min(a,b)*0.02);
      const em=Object.keys(existing.observedMonthlyTotals||{}), gm=Object.keys(g.observedMonthlyTotals||{});
      const overlap=em.filter(function(m){return gm.indexOf(m)>=0;}).length;
      const overlapRatio=overlap/Math.max(1,Math.min(em.length,gm.length));
      // Same amount appearing simultaneously under two labels is probably two obligations, not one.
      if(Math.abs(a-b)<=tolerance && Math.min(existing.distinctMonths,g.distinctMonths)>=2 && overlapRatio<=0.20){target=existing;return true;}
      return false;
    });

    if(!target){result.push(g);return;}
    target.description=target.description+' / '+g.description;
    target.counterparty=target.description;
    target.observedTotal=vfcPureRound_(target.observedTotal+g.observedTotal,.01);
    target.occurrences+=g.occurrences;
    target.firstSeen=vfcPureTime_(g.firstSeen)<vfcPureTime_(target.firstSeen)?g.firstSeen:target.firstSeen;
    target.lastSeen=vfcPureTime_(g.lastSeen)>vfcPureTime_(target.lastSeen)?g.lastSeen:target.lastSeen;
    target.observedMonthlyTotals=Object.assign({},target.observedMonthlyTotals||{},g.observedMonthlyTotals||{});
    target.distinctMonths=Object.keys(target.observedMonthlyTotals).length;
    target.confidence='High';
    target.mergedByAmountCadence=true;
  });
  return result;
}

function vfcPureFinancingCredits_(credits, classifiedDebits) {
  const confirmed=[], possible=[];
  credits.forEach(function(c){
    const s=String(c.description||'').toUpperCase();
    const amount=vfcPurePositive_(c.amount);
    if(!(amount>0)) return;

    const explicit=/\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|FINANCING|FUNDING|CASH\s+ADVANCE|MERCHANT\s+CASH\s+ADVANCE|\bMCA\b|\bLOAN\b.*\bBDC\b/.test(s);
    const correlated=vfcPureCreditHasPaymentMatch_(c,classifiedDebits);
    const financingLabel=/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|CANACAP|GREENBOX/.test(s);
    const item={
      date:c.date,
      description:c.description,
      counterparty:c.counterparty,
      amount:c.amount,
      direction:'CREDIT',
      linkedPaymentEntity:vfcPureMatchedPaymentEntity_(c,classifiedDebits),
      confidence:explicit||correlated?'High':'Moderate'
    };

    if(explicit || (amount>=5000 && correlated && financingLabel)) confirmed.push(item);
    else if(amount>=5000 && (correlated || financingLabel || /INVESTMENT|CAPITAL/.test(s))) possible.push(item);
  });
  const conf=vfcPureDedupeTransactions_(confirmed);
  const poss=vfcPureDedupeTransactions_(possible);
  return { confirmed:conf, possible:poss, total:conf.reduce(function(s,x){return s+x.amount;},0) };
}

function vfcPureMatchedPaymentEntity_(credit, debits) {
  const ct=vfcPureTokens_(credit.counterparty||credit.description);
  if(!ct.length) return '';
  let match='';
  (debits||[]).some(function(d){
    const dt=vfcPureTokens_(d.counterparty||d.description);
    if(!dt.length) return false;
    let matches=0;
    ct.forEach(function(a){if(dt.some(function(b){return a===b || (a.length>=4&&b.length>=4&&(a.indexOf(b)===0||b.indexOf(a)===0));})) matches++;});
    if(matches/Math.min(ct.length,dt.length)>=0.5){match=d.entityKey||d.key||'';return true;}
    return false;
  });
  return match;
}

function vfcPureCreditHasPaymentMatch_(credit, debits) {
  return !!vfcPureMatchedPaymentEntity_(credit,debits);
}

/* ------------------------- totals + stable cache validation ------------------------- */
