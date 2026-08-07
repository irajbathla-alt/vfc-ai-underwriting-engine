const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-2.1-FIXED-HEADERS',
  SIGNAL_PREFIX: 'VFC_BANKING_V3:',
  ACTIVE_LOOKBACK_DAYS: 45,
  LATEST_BATCH_GAP_MINUTES: 10
};

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcBiqReq_(companyOrRequest, requestedPeriod);
    const period = req.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(req.companyName, req.period)
      : req.period);
    return vfcBiqRefresh_(req.companyName, period);
  } catch (e) {
    return {ok:false, modelVersion:VFC_BANKING_INPUT_CONFIG.MODEL_VERSION, filesAnalyzed:0, filesSkipped:0, errors:[String(e && e.message || e)]};
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcBiqSummaryRows_('', '');
  if (!rows.length) throw new Error('PDF Summaries has no records.');
  const last = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({companyName:last.companyName, period:last.detectedPeriod});
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getBankingInputQualityStatus() {
  const result = {
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    usesExactSheetHeaders:true,
    usesLatestUploadBatchOnly:true,
    verifiesStatementHeaderTotals:true,
    extractsRecurringDebtPayments:true,
    extractsFinancingCredits:true,
    debtExtractionUsesOpenAI:false,
    createsNewSheets:false,
    changesProductionFormula:false
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName, period)
    : (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName, period) : null);
  if (!base) return null;

  const audit = vfcBiqAudit_(companyName, period, base);
  if (!audit.rows.length) return base;
  const debt = vfcBiqDebtProfile_(audit.rows, audit.monthsCovered, audit.latestStatementDate);
  const grossMonthly = audit.totalDeposits / Math.max(1, audit.monthsCovered);
  const operatingTotal = Math.max(0, audit.totalDeposits - debt.financingCreditsTotal);
  const operatingMonthly = operatingTotal / Math.max(1, audit.monthsCovered);
  const warnings = audit.warnings.slice();
  const oldAvg = vfcBiqNum_(base.averageMonthlyDeposits);
  if (oldAvg > 0 && grossMonthly > 0 && Math.abs(oldAvg - grossMonthly) / grossMonthly >= 0.05) {
    warnings.push('Average monthly deposits corrected from ' + vfcBiqRound_(oldAvg,1) + ' to ' + vfcBiqRound_(grossMonthly,1) + ' using statement-header totals.');
  }
  if (debt.financingCreditsTotal > 0) warnings.push('Financing credits were detected and shown separately from estimated operating deposits.');

  return Object.assign({}, base, {
    statementCount:audit.rows.length,
    monthsCovered:audit.monthsCovered,
    totalDeposits:vfcBiqRound_(audit.totalDeposits,0.01),
    averageMonthlyDeposits:vfcBiqRound_(grossMonthly,0.01),
    totalWithdrawals:vfcBiqRound_(audit.totalWithdrawals,0.01),
    depositWithdrawalRatio:vfcBiqRound_(audit.totalWithdrawals ? audit.totalDeposits / audit.totalWithdrawals : 0,0.01),
    nsfCount:audit.nsfCount,
    nsfPerMonth:vfcBiqRound_(audit.nsfCount / Math.max(1,audit.monthsCovered),0.01),
    negativeBalanceFlag:audit.negativeBalanceFlag,
    mcaPaymentFlag:debt.activeDebtObligations.length ? 1 : vfcBiqFlag_(base.mcaPaymentFlag),
    monthlyDeposits:audit.monthlyDeposits,
    monthlyWithdrawals:audit.monthlyWithdrawals,
    depositVolatility:vfcBiqRound_(vfcBiqCv_(audit.monthlyDeposits),0.01),
    depositTrend:vfcBiqRound_(vfcBiqTrend_(audit.monthlyDeposits),0.01),
    estimatedOperatingTotalDeposits:vfcBiqRound_(operatingTotal,0.01),
    estimatedOperatingMonthlyDeposits:vfcBiqRound_(operatingMonthly,0.01),
    detectedFinancingCredits:vfcBiqRound_(debt.financingCreditsTotal,0.01),
    existingMonthlyDebtService:vfcBiqRound_(debt.confirmedMonthlyDebtService,0.01),
    otherRecurringMonthlyObligations:vfcBiqRound_(debt.otherRecurringMonthlyObligations,0.01),
    debtServiceToDepositsRatio:grossMonthly ? vfcBiqRound_(debt.confirmedMonthlyDebtService / grossMonthly,0.0001) : 0,
    debtProfile:debt,
    inputQualityAudit:{
      modelVersion:VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      allMatchingRows:audit.allMatchingRows,
      latestBatchRows:audit.latestBatchRows,
      olderRowsIgnored:audit.olderRowsIgnored,
      validatedMonthsCovered:audit.monthsCovered,
      grossAverageMonthlyDeposits:vfcBiqRound_(grossMonthly,0.01),
      estimatedOperatingMonthlyDeposits:vfcBiqRound_(operatingMonthly,0.01),
      warnings:warnings
    }
  });
}

function vfcBiqRefresh_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = ss.getSheetByName('PDF Summaries');
  if (!summarySheet) throw new Error('Missing PDF Summaries sheet.');
  const allRows = vfcBiqSummaryRows_(companyName, period);
  if (!allRows.length) throw new Error('No PDF Summary rows found for this company and period.');
  const rows = vfcBiqLatestBatch_(allRows);
  const uploadMap = vfcBiqUploadMap_();
  let filesAnalyzed = 0, filesSkipped = 0;
  const errors = [];

  rows.forEach(function(row) {
    const cached = vfcBiqParseCell_(row.possibleMcaOrLoanPayments);
    if (cached && cached.version >= 3 && cached.headerSummary && vfcBiqNum_(cached.headerSummary.totalDeposits) > 0) {
      filesSkipped++;
      return;
    }
    const upload = uploadMap[String(row.uploadId || '')] || {};
    if (!upload.fileId) {
      errors.push(row.fileName + ': upload file ID not found.');
      return;
    }
    try {
      const text = extractTextFromPdf_(upload.fileId);
      const parsed = vfcBiqParseStatement_(text, row);
      const payload = {version:3, analyzedAt:new Date().toISOString(), fileName:row.fileName, headerSummary:parsed.headerSummary, debtPayments:parsed.debtPayments, financingCredits:parsed.financingCredits};
      summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload));
      filesAnalyzed++;
    } catch (e) {
      errors.push(row.fileName + ': ' + String(e && e.message || e));
    }
  });

  const features = getValidatedBankingFeatures_(companyName, period);
  return {ok:errors.length===0, modelVersion:VFC_BANKING_INPUT_CONFIG.MODEL_VERSION, companyName:companyName, period:period, filesAnalyzed:filesAnalyzed, filesSkipped:filesSkipped, errors:errors, debtProfile:features && features.debtProfile || {}, inputQualityAudit:features && features.inputQualityAudit || {}};
}

function vfcBiqSummaryRows_(companyName, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const h = values[0];
  const c = {
    upload:vfcBiqCol_(h,'Upload ID'), company:vfcBiqCol_(h,'Company Name'), period:vfcBiqCol_(h,'Detected Period'), file:vfcBiqCol_(h,'File Name'),
    start:vfcBiqCol_(h,'Statement Start Date'), end:vfcBiqCol_(h,'Statement End Date'), dep:vfcBiqCol_(h,'Total Deposits'), wd:vfcBiqCol_(h,'Total Withdrawals'),
    nsf:vfcBiqCol_(h,'NSF Count'), neg:vfcBiqCol_(h,'Negative Balance Detected'), signal:vfcBiqCol_(h,'Possible MCA Or Loan Payments'), created:vfcBiqCol_(h,'Created At')
  };
  return values.slice(1).map(function(r,i){
    return {uploadId:r[c.upload], companyName:r[c.company], detectedPeriod:r[c.period], fileName:String(r[c.file]||'statement.pdf'), statementStartDate:r[c.start], statementEndDate:r[c.end], totalDeposits:r[c.dep], totalWithdrawals:r[c.wd], nsfCount:r[c.nsf], negativeBalanceDetected:r[c.neg], possibleMcaOrLoanPayments:r[c.signal], createdAt:r[c.created], rowNumber:i+2, signalColumn:c.signal+1};
  }).filter(function(r){ return (!companyName || sameText_(r.companyName,companyName)) && (!period || sameText_(r.detectedPeriod,period)); });
}

function vfcBiqUploadMap_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads');
  if (!sheet) return {};
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};
  const h = values[0], u = vfcBiqCol_(h,'Upload ID'), f = vfcBiqCol_(h,'File ID'), n = vfcBiqCol_(h,'File Name');
  const map = {};
  values.slice(1).forEach(function(r){ const id=String(r[u]||'').trim(); if(id) map[id]={fileId:String(r[f]||'').trim(),fileName:String(r[n]||'')}; });
  return map;
}

function vfcBiqLatestBatch_(rows) {
  const out=[], seen={}; let lastTime=null;
  for (let i=rows.length-1;i>=0;i--) {
    const r=rows[i], name=String(r.fileName||'').toLowerCase(), d=vfcBiqDate_(r.createdAt);
    if (out.length) {
      if (name && seen[name]) break;
      if (d && lastTime!==null && Math.abs(lastTime-d.getTime())/60000 > VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES) break;
    }
    out.push(r); if(name) seen[name]=true; if(d) lastTime=d.getTime();
  }
  return out.reverse();
}

function vfcBiqParseStatement_(text, fallback) {
  const clean=String(text||'').replace(/\u00a0/g,' '), signals=vfcBiqTransactions_(clean);
  return {headerSummary:vfcBiqHeader_(clean,fallback||{}), debtPayments:signals.debtPayments, financingCredits:signals.financingCredits};
}

function vfcBiqHeader_(text, fallback) {
  const dep=vfcBiqMatch_(text,[/Total\s+deposits\s*(?:&|and)\s*credits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,/Total\s+deposits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i]);
  const wd=vfcBiqMatch_(text,[/Total\s+cheques\s*(?:&|and)\s*debits(?:\s*\([^)]*\))?\s*-?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,/Total\s+withdrawals(?:\s*\([^)]*\))?\s*-?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i]);
  const range=vfcBiqRange_(text);
  return {statementStartDate:range.start||vfcBiqIso_(fallback.statementStartDate), statementEndDate:range.end||vfcBiqIso_(fallback.statementEndDate), totalDeposits:vfcBiqRound_(dep||vfcBiqNum_(fallback.totalDeposits),0.01), totalWithdrawals:vfcBiqRound_(wd||vfcBiqNum_(fallback.totalWithdrawals),0.01), verifiedFromStatementHeader:dep>0};
}

function vfcBiqTransactions_(text) {
  const lines=String(text||'').replace(/\r/g,'\n').split(/\n+/).map(function(x){return x.replace(/\s+/g,' ').trim();}).filter(Boolean);
  const ym=text.match(/\b(20\d{2})\b/), year=ym?Number(ym[1]):new Date().getFullYear();
  let date=''; const debt=[], credits=[];
  for(let i=0;i<lines.length;i++){
    const d=vfcBiqDateLine_(lines[i],year); if(d) date=d;
    const w=[lines[i],lines[i+1]||'',lines[i+2]||''].join(' ');
    vfcBiqCap_(debt,date,w,/loan\s+payment\b.{0,120}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'TERM_LOAN',vfcBiqLoan_(w),'High');
    vfcBiqCap_(debt,date,w,/(?:merch\s+pad|merchant\s+(?:growth\s+)?pad)\b.{0,120}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'MCA','Merchant Growth / MERCH PAD','High');
    vfcBiqCap_(debt,date,w,/commercial\s+loans?.{0,150}?business\s+cr\s+eft.{0,90}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'COMMERCIAL_LOAN','Commercial Loans','High');
    vfcBiqCap_(debt,date,w,/(?:a-?kan\/?ipfs|\bipfs\b|premium\s+finance).{0,100}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'INSURANCE_FINANCE','A-KAN/IPFS','High');
    vfcBiqCap_(debt,date,w,/(?:cra|ccra)\s+canada.{0,100}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'TAX_GOVERNMENT',/ccra/i.test(w)?'CCRA Canada':'CRA Canada','High');
    if(/\bpad\b/i.test(w)&&!/merch\s+pad|merchant\s+(?:growth\s+)?pad|ipfs|cra|ccra/i.test(w)) vfcBiqCap_(debt,date,w,/\bpad\b.{0,120}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'OTHER_RECURRING_PAD',vfcBiqPad_(w),'Moderate');
    if(!/merch\s+pad|payment|debit/i.test(w)) vfcBiqCap_(credits,date,w,/merchant\s+growth\b.{0,100}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'MCA_ADVANCE','Merchant Growth','High');
    vfcBiqCap_(credits,date,w,/bcc\s+bf\s+rs\s*<?deftpymt>?\b.{0,100}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i,'UNKNOWN_FINANCING_CREDIT','Possible Commercial Financing','Moderate');
  }
  return {debtPayments:vfcBiqDedupe_(debt), financingCredits:vfcBiqDedupe_(credits)};
}

function vfcBiqCap_(arr,date,text,re,category,counterparty,confidence){ const m=String(text||'').match(re); if(!m)return; const amount=vfcBiqNum_(m[1]); if(amount>0) arr.push({date:date,description:String(text).substring(0,180),counterparty:counterparty,amount:vfcBiqRound_(amount,0.01),category:category,confidence:confidence}); }

function vfcBiqAudit_(companyName, period, base) {
  const all=vfcBiqSummaryRows_(companyName,period), latest=vfcBiqLatestBatch_(all), by={};
  latest.forEach(function(r){ const p=vfcBiqParseCell_(r.possibleMcaOrLoanPayments), h=p&&p.headerSummary||{}, key=(h.statementStartDate||vfcBiqIso_(r.statementStartDate))+'|'+(h.statementEndDate||vfcBiqIso_(r.statementEndDate))||String(r.fileName).toLowerCase(); by[key]=r; });
  const rows=Object.keys(by).map(function(k){return by[k];}).sort(function(a,b){return vfcBiqEffDate_(a)-vfcBiqEffDate_(b);});
  let dep=0,wd=0,nsf=0,neg=0; const starts=[],ends=[],months={},md=[],mw=[];
  rows.forEach(function(r){ const p=vfcBiqParseCell_(r.possibleMcaOrLoanPayments), h=p&&p.headerSummary||{}, s=vfcBiqDate_(h.statementStartDate||r.statementStartDate), e=vfcBiqDate_(h.statementEndDate||r.statementEndDate), d=vfcBiqNum_(h.totalDeposits||r.totalDeposits), w=vfcBiqNum_(h.totalWithdrawals||r.totalWithdrawals); if(s)starts.push(s); if(e)ends.push(e); dep+=d; wd+=w; nsf+=Math.max(0,vfcBiqNum_(r.nsfCount)); if(vfcBiqFlag_(r.negativeBalanceDetected))neg=1; md.push(d); mw.push(w); const x=e||s; if(x)months[x.getUTCFullYear()+'-'+('0'+(x.getUTCMonth()+1)).slice(-2)]=1; });
  const earliest=starts.length?new Date(Math.min.apply(null,starts.map(function(d){return d.getTime();}))):null, latestDate=ends.length?new Date(Math.max.apply(null,ends.map(function(d){return d.getTime();}))):null;
  const span=earliest&&latestDate?Math.max(1,Math.round((((latestDate-earliest)/86400000)+1)/30.4375)):0, covered=Math.max(1,Object.keys(months).length,span,rows.length||vfcBiqNum_(base.monthsCovered)||1), ignored=Math.max(0,all.length-latest.length), warnings=[];
  if(ignored)warnings.push('Using the latest upload batch; '+ignored+' older statement row(s) were ignored.');
  return {rows:rows,allMatchingRows:all.length,latestBatchRows:latest.length,olderRowsIgnored:ignored,monthsCovered:covered,totalDeposits:dep,totalWithdrawals:wd,nsfCount:nsf,negativeBalanceFlag:neg,monthlyDeposits:md,monthlyWithdrawals:mw,latestStatementDate:latestDate,warnings:warnings};
}

function vfcBiqDebtProfile_(rows, monthsCovered, latestDate) {
  let payments=[],credits=[]; rows.forEach(function(r){const p=vfcBiqParseCell_(r.possibleMcaOrLoanPayments); if(p){payments=payments.concat(p.debtPayments||[]);credits=credits.concat(p.financingCredits||[]);}}); payments=vfcBiqDedupe_(payments);credits=vfcBiqDedupe_(credits);
  const groups={}; payments.forEach(function(p){const k=p.category+'|'+vfcBiqNormParty_(p.counterparty||p.description);(groups[k]||(groups[k]=[])).push(p);});
  const obligations=Object.keys(groups).map(function(k){const items=groups[k].slice().sort(function(a,b){return (vfcBiqDate_(a.date)||0)-(vfcBiqDate_(b.date)||0);}), dates=items.map(function(x){return vfcBiqDate_(x.date);}).filter(Boolean), amounts=items.map(function(x){return vfcBiqNum_(x.amount);}).filter(function(n){return n>0;}), amount=vfcBiqMedian_(amounts), freq=vfcBiqFreq_(dates,items.length,monthsCovered), monthly=vfcBiqMonthly_(amount,freq,items.length,monthsCovered), last=dates.length?dates[dates.length-1]:null; return {counterparty:items[0].counterparty||items[0].description,description:items[0].description||'',category:items[0].category,paymentAmount:vfcBiqRound_(amount,0.01),frequency:freq,monthlyEquivalent:vfcBiqRound_(monthly,0.01),occurrences:items.length,firstSeen:dates.length?Utilities.formatDate(dates[0],'UTC','yyyy-MM-dd'):'',lastSeen:last?Utilities.formatDate(last,'UTC','yyyy-MM-dd'):'',active:vfcBiqActive_(last,latestDate,freq),confidence:vfcBiqConf_(items)};});
  const confirmed=['MCA','TERM_LOAN','COMMERCIAL_LOAN','LOC','LEASE_FINANCE'], other=['INSURANCE_FINANCE','CREDIT_CARD','OTHER_RECURRING_PAD'];
  const activeDebt=obligations.filter(function(x){return x.active&&confirmed.indexOf(x.category)>=0&&x.frequency!=='Observed once'&&x.confidence!=='Low';}), otherRecurring=obligations.filter(function(x){return x.active&&other.indexOf(x.category)>=0&&x.frequency!=='Observed once';}), tax=obligations.filter(function(x){return x.active&&x.category==='TAX_GOVERNMENT';}), validCredits=credits.filter(function(x){return x.confidence!=='Low';});
  return {confirmedMonthlyDebtService:vfcBiqRound_(activeDebt.reduce(function(s,x){return s+x.monthlyEquivalent;},0),0.01),otherRecurringMonthlyObligations:vfcBiqRound_(otherRecurring.reduce(function(s,x){return s+x.monthlyEquivalent;},0),0.01),activeDebtObligations:activeDebt,otherRecurringObligations:otherRecurring,taxGovernmentPads:tax,allDetectedObligations:obligations,financingCredits:validCredits,financingCreditsTotal:vfcBiqRound_(validCredits.reduce(function(s,x){return s+vfcBiqNum_(x.amount);},0),0.01),note:'Monthly equivalents are inferred from observed transaction frequency. Outstanding balances are not inferred.'};
}

function vfcBiqParseCell_(value){const t=String(value||'').trim();if(t.indexOf(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX)!==0)return null;try{const p=JSON.parse(t.substring(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length));return {version:vfcBiqNum_(p.version),headerSummary:p.headerSummary||{},debtPayments:Array.isArray(p.debtPayments)?p.debtPayments:[],financingCredits:Array.isArray(p.financingCredits)?p.financingCredits:[]};}catch(e){return null;}}
function vfcBiqCol_(headers,wanted){const t=String(wanted).toLowerCase().replace(/[^a-z0-9]/g,'');for(let i=0;i<headers.length;i++){if(String(headers[i]||'').toLowerCase().replace(/[^a-z0-9]/g,'')===t)return i;}throw new Error('Missing required column: '+wanted);}
function vfcBiqEffDate_(r){const p=vfcBiqParseCell_(r.possibleMcaOrLoanPayments),h=p&&p.headerSummary||{};return vfcBiqDate_(h.statementEndDate||r.statementEndDate||h.statementStartDate||r.statementStartDate)||new Date(0);}
function vfcBiqMatch_(text,patterns){for(let i=0;i<patterns.length;i++){const m=String(text||'').match(patterns[i]);if(m&&m[1]&&vfcBiqNum_(m[1])>0)return vfcBiqNum_(m[1]);}return 0;}
function vfcBiqRange_(text){const m=String(text||'').match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s*(20\d{2})\s+to\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s*(20\d{2})/i);if(!m)return{start:'',end:''};return{start:vfcBiqNamed_(m[1],m[2],m[3]),end:vfcBiqNamed_(m[4],m[5],m[6])};}
function vfcBiqNamed_(mon,day,year){const ms={jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11},m=ms[String(mon).toLowerCase()];return m===undefined?'':Utilities.formatDate(new Date(Date.UTC(Number(year),m,Number(day))),'UTC','yyyy-MM-dd');}
function vfcBiqDedupe_(items){const seen={};return(items||[]).filter(function(x){const k=[vfcBiqIso_(x.date),vfcBiqRound_(vfcBiqNum_(x.amount),0.01),x.category,vfcBiqNormParty_(x.counterparty||x.description)].join('|').toLowerCase();if(seen[k])return false;seen[k]=1;return true;});}
function vfcBiqFreq_(dates,n,months){if(dates.length>=2){const a=[];for(let i=1;i<dates.length;i++){const d=Math.abs((dates[i]-dates[i-1])/86400000);if(d>0)a.push(d);}const m=vfcBiqMedian_(a);if(m<=3.5)return'Business daily';if(m<=10)return'Weekly';if(m<=20)return'Biweekly';if(m<=40)return'Monthly';if(m<=75)return'Every 2 months';return'Irregular';}const p=n/Math.max(1,months||1);if(p>=3)return'Weekly';if(p>=1.5)return'Biweekly';if(p>=0.65)return'Monthly';return'Observed once';}
function vfcBiqMonthly_(a,f,n,m){if(f==='Business daily')return a*21.7;if(f==='Weekly')return a*4.33;if(f==='Biweekly')return a*2.17;if(f==='Monthly')return a;if(f==='Every 2 months')return a*0.5;if(f==='Irregular')return a*n/Math.max(1,m||1);return 0;}
function vfcBiqActive_(last,latest,f){if(!last||!latest)return f!=='Observed once';const d=(latest-last)/86400000;return d>=-3&&d<=(f==='Every 2 months'?80:VFC_BANKING_INPUT_CONFIG.ACTIVE_LOOKBACK_DAYS);}
function vfcBiqConf_(items){if(!items.length)return'Low';const a=items.reduce(function(s,x){return s+(x.confidence==='High'?2:x.confidence==='Moderate'?1:0);},0)/items.length;return a>=1.5?'High':a>=0.75?'Moderate':'Low';}
function vfcBiqDateLine_(line,year){const m=String(line||'').match(/^\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i)||String(line||'').match(/^\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/i);if(!m)return'';const ms={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11},day=/^\d/.test(m[1])?Number(m[1]):Number(m[2]),mon=/^\d/.test(m[1])?m[2]:m[1];return Utilities.formatDate(new Date(Date.UTC(year,ms[String(mon).toLowerCase()],day)),'UTC','yyyy-MM-dd');}
function vfcBiqLoan_(line){const m=String(line||'').match(/loan\s+payment\s+([^\s]+(?:\s+\d{1,4})?)/i);return m?'Loan '+m[1]:'Loan Payment';}
function vfcBiqPad_(line){return String(line||'').replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b.*$/,'').trim().substring(0,80)||'Recurring PAD';}
function vfcBiqNormParty_(v){return String(v||'').toLowerCase().replace(/\b(payment|payments|business|pad|investment|eft|deftpymt)\b/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim().substring(0,80);}
function vfcBiqReq_(x,p){let c='',q=p||'';if(x&&typeof x==='object'){c=x.companyName||x.company||'';q=x.period||x.detectedPeriod||q;}else c=x||'';c=String(c).trim();q=String(q).trim();if(!c)throw new Error('Company name is required.');return{companyName:c,period:q};}
function vfcBiqDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcBiqIso_(v){const d=vfcBiqDate_(v);return d?Utilities.formatDate(d,'UTC','yyyy-MM-dd'):'';}
function vfcBiqNum_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function vfcBiqFlag_(v){return/^(1|true|yes|detected)$/i.test(String(v||'').trim())?1:0;}
function vfcBiqRound_(v,s){const n=vfcBiqNum_(v),i=vfcBiqNum_(s)||1;return Math.round(n/i)*i;}
function vfcBiqMedian_(v){const a=(v||[]).map(vfcBiqNum_).filter(function(n){return n>0;}).sort(function(x,y){return x-y;});if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function vfcBiqCv_(v){const a=(v||[]).map(vfcBiqNum_).filter(function(n){return n>=0;});if(!a.length)return 1;const avg=a.reduce(function(s,n){return s+n;},0)/a.length;if(!avg)return 1;return Math.sqrt(a.reduce(function(s,n){return s+Math.pow(n-avg,2);},0)/a.length)/avg;}
function vfcBiqTrend_(v){const a=(v||[]).map(vfcBiqNum_);if(a.length<2)return 0;const k=Math.max(1,Math.floor(a.length/2)),x=a.slice(0,k),y=a.slice(k),xa=x.reduce(function(s,n){return s+n;},0)/x.length,ya=y.length?y.reduce(function(s,n){return s+n;},0)/y.length:xa;return xa>0?(ya-xa)/xa:0;}
