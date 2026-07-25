const VFC_POWER_CONFIG = {
  MODEL_VERSION: 'VFC-HYBRID-FINAL-2.0',
  MAX_SIMILAR_CASES: 12,
  HISTORICAL_WEIGHT: 0.58,
  FUNDAMENTAL_WEIGHT: 0.32,
  AI_WEIGHT: 0.10,
  MIN_AMOUNT: 5000,
  ROUNDING: 500
};

function generatePowerAssessmentSafe(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const period = resolveLatestAssessmentPeriod_(request.companyName, request.period);
  return generatePowerAssessment(request.companyName, period);
}

function normalizeAssessmentRequest_(companyOrRequest, requestedPeriod) {
  let companyName = '';
  let period = requestedPeriod || '';
  if (companyOrRequest && typeof companyOrRequest === 'object') {
    companyName = companyOrRequest.companyName || companyOrRequest.company || '';
    period = companyOrRequest.period || companyOrRequest.detectedPeriod || period;
  } else {
    companyName = companyOrRequest || '';
  }
  companyName = String(companyName || '').trim();
  period = String(period || '').trim();
  if (!companyName || /^(undefined|null)$/i.test(companyName)) {
    throw new Error('Company name was not provided. Run the assessment from the deployed web app.');
  }
  return { companyName: companyName, period: period };
}

function resolveLatestAssessmentPeriod_(companyName, requestedPeriod) {
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName);
  });
  if (!rows.length) {
    throw new Error('No PDF Summary rows were found for "' + companyName + '". Confirm the upload completed successfully.');
  }
  if (requestedPeriod) {
    const exact = rows.filter(function(row) { return sameText_(row.detectedPeriod, requestedPeriod); });
    if (exact.length) return String(exact[exact.length - 1].detectedPeriod || requestedPeriod).trim();
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const value = String(rows[i].detectedPeriod || '').trim();
    if (value) return value;
  }
  return '';
}

function diagnoseAssessmentLookup(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) { return sameText_(row.companyName, request.companyName); });
  return {
    companyName: request.companyName,
    requestedPeriod: request.period,
    matchingRows: rows.length,
    availablePeriods: unique_(rows.map(function(row) { return row.detectedPeriod || ''; }).filter(Boolean)),
    resolvedPeriod: rows.length ? resolveLatestAssessmentPeriod_(request.companyName, request.period) : ''
  };
}

function generatePowerAssessment(companyName, period) {
  setupVFC();
  ensurePowerEngineSheets_();
  const current = buildPowerFeatures_(companyName, period);
  if (!current || !current.statementCount) throw new Error('No bank-statement summaries were found for this company and period.');

  const outcomes = collectHistoricalOutcomes_().filter(function(row) {
    return !(sameText_(row.companyName, companyName) && sameText_(row.period, period));
  });
  if (!outcomes.length) throw new Error('No historical lender outcomes are available. Add approvals and declines in Training Data first.');

  const fundamental = calculateFundamentalScore_(current);
  const aiReview = createExpertReview_(current, fundamental);
  const lenders = unique_(outcomes.map(function(row) { return row.lenderName; }).filter(Boolean));
  const rankings = lenders.map(function(lender) {
    return scorePowerLender_(lender, current, outcomes, fundamental, aiReview);
  }).sort(function(a, b) { return b.compositeScore - a.compositeScore; });

  const capacity = calculateExactLendingCapacity_(current, fundamental, aiReview, rankings);
  const decision = buildPowerDecision_(current, fundamental, aiReview, rankings, capacity);
  const assessmentId = Utilities.getUuid();

  rankings.forEach(function(result) {
    appendRow_('Hybrid Assessments', [
      assessmentId,VFC_POWER_CONFIG.MODEL_VERSION,companyName,period,result.lenderName,
      result.compositeScore,result.observedScore,fundamental.score,result.aiRiskScore,
      result.observedFit,result.confidence,result.historicalCases,result.similarCases,
      result.similarApprovals,result.similarDeclines,result.observedApprovalRate,
      result.lowApprovedAmount,result.highApprovedAmount,result.medianApprovedAmount,
      capacity.recommendedAmount,capacity.stretchAmount,capacity.confidenceScore,
      result.reasoning,cleanCell_(result.conditions),cleanCell_(result.risks),new Date()
    ]);
  });

  appendRow_('Risk Scorecards', [
    assessmentId,companyName,period,fundamental.score,fundamental.grade,
    fundamental.cashFlowScore,fundamental.nsfScore,fundamental.balanceScore,
    fundamental.debtLoadScore,fundamental.coverageScore,fundamental.dataQualityScore,
    capacity.recommendedAmount,capacity.stretchAmount,capacity.confidenceScore,
    cleanCell_(capacity.calculationNotes),cleanCell_(fundamental.strengths),
    cleanCell_(fundamental.risks),cleanCell_(aiReview.missing_information),new Date()
  ]);

  return {
    ok:true,
    assessmentId:assessmentId,
    modelVersion:VFC_POWER_CONFIG.MODEL_VERSION,
    companyName:companyName,
    period:period,
    currentFeatures:current,
    fundamentalScorecard:fundamental,
    expertReview:aiReview,
    lendingCapacity:capacity,
    lenderRankings:rankings,
    underwritingSummary:decision,
    disclaimer:'The exact amount is VFC internal decision support based on uploaded banking data and observed historical outcomes. It is not a lender approval or official lender policy.'
  };
}

function ensurePowerEngineSheets_() {
  ensureSheetSchema_('Hybrid Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Lender Name','Composite Score',
    'Observed Score','Fundamental Score','AI Risk Score','Observed Fit','Confidence',
    'Historical Cases','Similar Cases','Similar Approvals','Similar Declines','Observed Approval Rate',
    'Low Approved Amount','High Approved Amount','Median Approved Amount','Recommended Exact Amount',
    'Stretch Amount','Amount Confidence','Reasoning','Conditions','Risks','Created At'
  ]);
  ensureSheetSchema_('Risk Scorecards', [
    'Assessment ID','Company Name','Period','Fundamental Score','Risk Grade','Cash Flow Score',
    'NSF Score','Balance Score','Debt Load Score','Coverage Score','Data Quality Score',
    'Recommended Exact Amount','Stretch Amount','Amount Confidence','Amount Calculation Notes',
    'Strengths','Risks','Missing Information','Created At'
  ]);
}

function buildPowerFeatures_(companyName, period) {
  const base = buildFeaturesForCase_(companyName, period);
  if (!base) return null;
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period));
  });
  const opening = rows.map(function(r) { return toNumber_(r.openingBalance); }).filter(isFiniteNumber_);
  const closing = rows.map(function(r) { return toNumber_(r.closingBalance); }).filter(isFiniteNumber_);
  const deposits = rows.map(function(r) { return toNumber_(r.totalDeposits); }).filter(function(n) { return n > 0; });
  const withdrawals = rows.map(function(r) { return toNumber_(r.totalWithdrawals); }).filter(function(n) { return n > 0; });
  const avgDeposit = average_(deposits);
  const text = rows.map(function(r) { return [r.summary,r.risks,r.missingInfo,r.possibleMcaOrLoanPayments].join(' '); }).join(' ').toLowerCase();
  return Object.assign({}, base, {
    averageOpeningBalance:round2_(average_(opening)),
    averageClosingBalance:round2_(average_(closing)),
    depositVolatility:round2_(avgDeposit ? standardDeviation_(deposits) / avgDeposit : 1),
    depositTrend:round2_(calculateTrend_(deposits)),
    nsfPerMonth:round2_(base.nsfCount / Math.max(base.monthsCovered, 1)),
    overdraftFlag:/overdraft|od fee|over limit|insufficient funds/.test(text) ? 1 : 0,
    returnedPaymentFlag:/returned payment|returned item|reversal|chargeback/.test(text) ? 1 : 0,
    suspectedStacking:/stack|multiple mca|multiple loan|several daily|several weekly/.test(text) ? 1 : 0,
    missingInfoFlag:rows.some(function(r) { return String(r.missingInfo || '').trim().length > 3; }) ? 1 : 0,
    monthlyDeposits:deposits,
    monthlyWithdrawals:withdrawals
  });
}

function calculateFundamentalScore_(f) {
  const strengths = [], risks = [];
  let cashFlow = f.depositWithdrawalRatio >= 1.15 ? 90 : f.depositWithdrawalRatio >= 1.02 ? 76 : f.depositWithdrawalRatio >= 0.92 ? 58 : f.depositWithdrawalRatio >= 0.80 ? 38 : 20;
  if (f.depositTrend >= 0.08) { cashFlow += 6; strengths.push('Deposits are trending upward.'); }
  if (f.depositTrend <= -0.08) { cashFlow -= 10; risks.push('Deposits are trending downward.'); }
  if (f.depositVolatility <= 0.18) { cashFlow += 4; strengths.push('Deposits are relatively stable.'); }
  if (f.depositVolatility >= 0.45) { cashFlow -= 8; risks.push('Deposits are highly volatile.'); }
  cashFlow = clamp_(Math.round(cashFlow),0,100);

  let nsf = f.nsfPerMonth === 0 ? 100 : f.nsfPerMonth <= 0.5 ? 82 : f.nsfPerMonth <= 1 ? 68 : f.nsfPerMonth <= 2 ? 45 : 20;
  if (f.nsfPerMonth > 0) risks.push('NSF activity averages ' + f.nsfPerMonth + ' per month.'); else strengths.push('No NSF activity was extracted.');

  let balance = 78;
  if (f.negativeBalanceFlag) { balance -= 32; risks.push('Negative balances were detected.'); }
  if (f.overdraftFlag) { balance -= 15; risks.push('Overdraft activity was detected.'); }
  if (f.returnedPaymentFlag) { balance -= 12; risks.push('Returned-payment activity was detected.'); }
  if (f.averageClosingBalance > 0 && f.averageMonthlyDeposits > 0) {
    const days = f.averageClosingBalance / (f.averageMonthlyDeposits / 30);
    if (days >= 7) { balance += 10; strengths.push('Closing balances provide a reasonable operating cushion.'); }
    else if (days < 2) { balance -= 10; risks.push('The average closing-balance cushion is thin.'); }
  }
  balance = clamp_(balance,0,100);

  let debt = 88;
  if (f.mcaPaymentFlag) { debt -= 25; risks.push('Existing MCA or loan payments were identified.'); }
  if (f.suspectedStacking) { debt -= 28; risks.push('Possible stacking was identified.'); }
  debt = clamp_(debt,0,100);

  const coverage = f.monthsCovered >= 6 ? 100 : f.monthsCovered >= 4 ? 82 : f.monthsCovered >= 3 ? 68 : f.monthsCovered >= 2 ? 50 : 35;
  if (f.monthsCovered < 3) risks.push('Limited statement history reduces reliability.'); else strengths.push(f.monthsCovered + ' months of statements were analyzed.');

  let data = 100;
  if (f.missingInfoFlag) data -= 20;
  if (!f.averageMonthlyDeposits) data -= 35;
  if (!f.totalWithdrawals) data -= 20;
  if (f.statementCount < 2) data -= 15;
  data = clamp_(data,0,100);

  const score = Math.round(cashFlow*0.30 + nsf*0.18 + balance*0.17 + debt*0.17 + coverage*0.10 + data*0.08);
  const grade = score >= 82 ? 'Strong' : score >= 70 ? 'Acceptable' : score >= 58 ? 'Caution' : score >= 45 ? 'Elevated Risk' : 'High Risk';
  return {score:score,grade:grade,cashFlowScore:cashFlow,nsfScore:nsf,balanceScore:balance,debtLoadScore:debt,coverageScore:coverage,dataQualityScore:data,strengths:unique_(strengths),risks:unique_(risks)};
}

function scorePowerLender_(lenderName, current, outcomes, fundamental, aiReview) {
  const records = outcomes.filter(function(r) { return sameText_(r.lenderName,lenderName); }).map(function(r) {
    const features = buildPowerFeatures_(r.companyName,r.period);
    return {companyName:r.companyName,period:r.period,decision:normalizeDecision_(r.decision),approvedAmount:toNumber_(r.approvedAmount),declineReason:r.declineReason||'',features:features,similarity:features&&features.statementCount?powerSimilarity_(current,features):0};
  }).filter(function(r) { return r.features && r.features.statementCount; });
  records.sort(function(a,b) { return b.similarity-a.similarity; });
  const similar = records.slice(0,VFC_POWER_CONFIG.MAX_SIMILAR_CASES);
  const approvals = similar.filter(function(r) { return r.decision==='Approved'||r.decision==='Conditional'; });
  const declines = similar.filter(function(r) { return r.decision==='Declined'; });
  const approvalRate = similar.length ? approvals.length/similar.length : 0;
  const avgSimilarity = similar.length ? average_(similar.map(function(r){return r.similarity;})) : 0;
  const sampleFactor = clamp_(records.length/15,0.25,1);
  const observedRaw = approvalRate*72 + avgSimilarity*28;
  const observedScore = Math.round(50 + (observedRaw-50)*sampleFactor);
  const aiScore = clamp_(toNumber_(aiReview.risk_score||fundamental.score),0,100);
  let composite = observedScore*VFC_POWER_CONFIG.HISTORICAL_WEIGHT + fundamental.score*VFC_POWER_CONFIG.FUNDAMENTAL_WEIGHT + aiScore*VFC_POWER_CONFIG.AI_WEIGHT;
  composite = Math.round(50 + (composite-50)*(fundamental.dataQualityScore/100));
  const amounts = approvals.map(function(r){return r.approvedAmount;}).filter(function(n){return n>0;}).sort(function(a,b){return a-b;});
  const fit = records.length<3 ? 'Insufficient history' : composite>=78 ? 'Strong fit' : composite>=65 ? 'Good fit' : composite>=52 ? 'Caution' : 'Weak fit';
  const confidence = records.length>=15&&similar.length>=9&&fundamental.dataQualityScore>=80 ? 'High' : records.length>=6&&similar.length>=4&&fundamental.dataQualityScore>=65 ? 'Moderate' : 'Low';
  return {
    lenderName:lenderName,compositeScore:composite,observedScore:observedScore,aiRiskScore:aiScore,observedFit:fit,confidence:confidence,
    historicalCases:records.length,similarCases:similar.length,similarApprovals:approvals.length,similarDeclines:declines.length,
    observedApprovalRate:similar.length?Math.round(approvalRate*100)+'%':'N/A',
    lowApprovedAmount:amounts.length?amounts[0]:'',highApprovedAmount:amounts.length?amounts[amounts.length-1]:'',medianApprovedAmount:amounts.length?median_(amounts):'',
    reasoning:similar.length?approvals.length+' of '+similar.length+' closest VFC cases were approved or conditional.':'No comparable historical cases were available.',
    conditions:unique_((aiReview.recommended_conditions||[]).concat(fundamental.dataQualityScore<75?['Manually verify extracted figures.']:[])),
    risks:unique_(topTextReasons_(declines.map(function(r){return r.declineReason;})).concat(fundamental.risks).concat(aiReview.key_risks||[])).slice(0,8)
  };
}

function calculateExactLendingCapacity_(f, fundamental, aiReview, rankings) {
  const top = rankings[0] || {};
  const approvedMedians = rankings.map(function(r){return toNumber_(r.medianApprovedAmount);}).filter(function(n){return n>0;});
  const historicalAnchor = approvedMedians.length ? weightedHistoricalAnchor_(rankings) : 0;

  const revenueBase = f.averageMonthlyDeposits * 0.70;
  const surplusRatio = clamp_(f.depositWithdrawalRatio - 0.78, 0.12, 0.50);
  const cashFlowCapacity = f.averageMonthlyDeposits * surplusRatio * 3.25;
  const balanceCapacity = Math.max(0, f.averageClosingBalance * 4);

  let base;
  if (historicalAnchor > 0) base = historicalAnchor*0.45 + revenueBase*0.30 + cashFlowCapacity*0.20 + balanceCapacity*0.05;
  else base = revenueBase*0.60 + cashFlowCapacity*0.35 + balanceCapacity*0.05;

  const fundamentalFactor = clamp_(fundamental.score/75,0.52,1.15);
  const lenderFitFactor = clamp_((toNumber_(top.compositeScore)||50)/72,0.65,1.15);
  const aiFactor = clamp_(toNumber_(aiReview.risk_score||fundamental.score)/75,0.70,1.10);
  const dataFactor = clamp_(fundamental.dataQualityScore/100,0.55,1);

  let behaviourFactor = 1;
  if (f.nsfPerMonth > 0.5) behaviourFactor -= Math.min(0.25,f.nsfPerMonth*0.06);
  if (f.negativeBalanceFlag) behaviourFactor -= 0.12;
  if (f.overdraftFlag) behaviourFactor -= 0.08;
  if (f.returnedPaymentFlag) behaviourFactor -= 0.06;
  if (f.mcaPaymentFlag) behaviourFactor -= 0.14;
  if (f.suspectedStacking) behaviourFactor -= 0.18;
  if (f.depositTrend < -0.08) behaviourFactor -= 0.08;
  if (f.depositVolatility > 0.45) behaviourFactor -= 0.07;
  behaviourFactor = clamp_(behaviourFactor,0.35,1.08);

  const raw = base * fundamentalFactor * lenderFitFactor * aiFactor * dataFactor * behaviourFactor;
  const revenueCap = f.averageMonthlyDeposits * (fundamental.score>=82?0.95:fundamental.score>=70?0.80:fundamental.score>=58?0.65:0.45);
  let recommended = Math.min(raw,revenueCap);
  if (historicalAnchor>0) recommended = Math.min(recommended,historicalAnchor*1.25);
  recommended = roundToNearest_(Math.max(0,recommended),VFC_POWER_CONFIG.ROUNDING);
  if (recommended < VFC_POWER_CONFIG.MIN_AMOUNT && fundamental.score >= 45) recommended = VFC_POWER_CONFIG.MIN_AMOUNT;
  if (fundamental.score < 40 || !f.averageMonthlyDeposits) recommended = 0;

  let stretchFactor = top.compositeScore>=78&&fundamental.score>=75 ? 1.18 : top.compositeScore>=65&&fundamental.score>=65 ? 1.12 : 1.07;
  let stretch = roundToNearest_(Math.min(recommended*stretchFactor,revenueCap*1.10),VFC_POWER_CONFIG.ROUNDING);
  if (stretch < recommended) stretch = recommended;

  const sampleScore = Math.min(100,(toNumber_(top.historicalCases)||0)*6);
  const confidenceScore = Math.round(fundamental.dataQualityScore*0.45 + Math.min(100,f.monthsCovered/6*100)*0.25 + sampleScore*0.20 + Math.min(100,(toNumber_(top.similarCases)||0)/8*100)*0.10);
  const confidence = confidenceScore>=80?'High':confidenceScore>=60?'Moderate':'Low';

  return {
    recommendedAmount:recommended,
    stretchAmount:stretch,
    confidenceScore:confidenceScore,
    confidence:confidence,
    historicalAnchor:roundToNearest_(historicalAnchor,VFC_POWER_CONFIG.ROUNDING),
    cashFlowCapacity:roundToNearest_(cashFlowCapacity,VFC_POWER_CONFIG.ROUNDING),
    revenueCapacity:roundToNearest_(revenueCap,VFC_POWER_CONFIG.ROUNDING),
    calculationNotes:[
      'Average monthly deposits: '+roundToNearest_(f.averageMonthlyDeposits,VFC_POWER_CONFIG.ROUNDING),
      'Historical approval anchor: '+roundToNearest_(historicalAnchor,VFC_POWER_CONFIG.ROUNDING),
      'Fundamental risk adjustment: '+fundamental.score+'/100',
      'Top lender fit adjustment: '+(top.compositeScore||0)+'/100',
      'Banking-behaviour factor: '+Math.round(behaviourFactor*100)+'%',
      'Data-confidence factor: '+Math.round(dataFactor*100)+'%'
    ]
  };
}

function weightedHistoricalAnchor_(rankings) {
  let total=0, weight=0;
  rankings.forEach(function(r,index){
    const amount=toNumber_(r.medianApprovedAmount);
    if (!amount) return;
    const w=Math.max(0.15,(toNumber_(r.compositeScore)||50)/100)*(1/(index+1));
    total+=amount*w; weight+=w;
  });
  return weight?total/weight:0;
}

function powerSimilarity_(a,b) {
  return clamp_(
    numericSimilarity_(a.averageMonthlyDeposits,b.averageMonthlyDeposits)*0.29 +
    numericSimilarity_(a.depositWithdrawalRatio,b.depositWithdrawalRatio,2)*0.13 +
    numericSimilarity_(a.nsfPerMonth,b.nsfPerMonth,2)*0.14 +
    numericSimilarity_(a.depositVolatility,b.depositVolatility,1)*0.10 +
    numericSimilarity_(a.depositTrend,b.depositTrend,0.5)*0.08 +
    (a.negativeBalanceFlag===b.negativeBalanceFlag?1:0)*0.08 +
    (a.mcaPaymentFlag===b.mcaPaymentFlag?1:0)*0.08 +
    (a.suspectedStacking===b.suspectedStacking?1:0)*0.05 +
    numericSimilarity_(a.monthsCovered,b.monthsCovered,6)*0.05,0,1
  );
}

function createExpertReview_(features,fundamental) {
  const fallback={risk_score:fundamental.score,risk_grade:fundamental.grade,executive_summary:'Cash-flow analysis completed.',key_strengths:fundamental.strengths,key_risks:fundamental.risks,missing_information:[],recommended_conditions:[]};
  try {
    const prompt=[
      'You are a senior Canadian small-business cash-flow underwriter supporting VFC.',
      'Return JSON only with risk_score, risk_grade, executive_summary, key_strengths, key_risks, missing_information, recommended_conditions.',
      'Do not invent lender criteria or promise approval. Treat missing information as missing, not negative.',
      'Extracted features: '+JSON.stringify(features),
      'Deterministic scorecard: '+JSON.stringify(fundamental)
    ].join('\n');
    const r=callOpenAIJson_(prompt);
    r.risk_score=clamp_(toNumber_(r.risk_score||fundamental.score),0,100);
    r.key_strengths=arraySafe_(r.key_strengths); r.key_risks=arraySafe_(r.key_risks); r.missing_information=arraySafe_(r.missing_information); r.recommended_conditions=arraySafe_(r.recommended_conditions);
    return r;
  } catch(e) { return fallback; }
}

function buildPowerDecision_(features,fundamental,aiReview,rankings,capacity) {
  const top=rankings[0]||{};
  const summary=capacity.recommendedAmount<=0?'No lending amount recommended':top.compositeScore>=78&&capacity.confidence!=='Low'?'Strong submission candidate':top.compositeScore>=65?'Submit with conditions':top.compositeScore>=52?'Strengthen file before submission':'High risk — manual exception review';
  return {
    summary:summary,
    strongest_lender:top.lenderName||'',
    explanation:(aiReview.executive_summary||'')+(capacity.recommendedAmount?' VFC internal recommended amount: '+capacity.recommendedAmount+'.':''),
    fundamental_score:fundamental.score,
    risk_grade:fundamental.grade,
    recommended_amount:capacity.recommendedAmount,
    stretch_amount:capacity.stretchAmount,
    amount_confidence:capacity.confidence,
    amount_confidence_score:capacity.confidenceScore,
    key_strengths:fundamental.strengths,
    key_risks:unique_(fundamental.risks.concat(aiReview.key_risks||[])).slice(0,8),
    missing_information:aiReview.missing_information||[],
    recommended_conditions:aiReview.recommended_conditions||[]
  };
}

function topTextReasons_(reasons) {
  const counts={};
  reasons.filter(Boolean).forEach(function(reason){String(reason).split(/[\n;,|]+/).forEach(function(piece){const clean=piece.trim();if(!clean)return;const key=clean.toLowerCase();counts[key]=counts[key]||{text:clean,count:0};counts[key].count++;});});
  return Object.keys(counts).map(function(k){return counts[k];}).sort(function(a,b){return b.count-a.count;}).slice(0,4).map(function(x){return x.text;});
}
function calculateTrend_(values){if(!values||values.length<2)return 0;const avg=average_(values);return avg?(values[values.length-1]-values[0])/avg:0;}
function standardDeviation_(values){if(!values||values.length<2)return 0;const avg=average_(values);return Math.sqrt(values.reduce(function(s,n){return s+Math.pow(n-avg,2);},0)/values.length);}
function average_(values){const nums=(values||[]).filter(isFiniteNumber_);return nums.length?nums.reduce(function(a,b){return a+b;},0)/nums.length:0;}
function isFiniteNumber_(n){return typeof n==='number'&&isFinite(n);}
function arraySafe_(value){return Array.isArray(value)?value:value?[String(value)]:[];}
function roundToNearest_(value,nearest){return Math.round(toNumber_(value)/nearest)*nearest;}
