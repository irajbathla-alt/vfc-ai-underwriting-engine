const VFC_POWER_CONFIG = {
  MODEL_VERSION: 'VFC-HYBRID-FINAL-1.0',
  MAX_SIMILAR_CASES: 12,
  HISTORICAL_WEIGHT: 0.58,
  FUNDAMENTAL_WEIGHT: 0.32,
  AI_WEIGHT: 0.10
};

/**
 * Public web-app entry point. Accepts either:
 *   generatePowerAssessmentSafe('Company Ltd', 'Jan 2026 to Jun 2026')
 * or
 *   generatePowerAssessmentSafe({companyName:'Company Ltd', period:'Jan 2026 to Jun 2026'})
 */
function generatePowerAssessmentSafe(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const resolvedPeriod = resolveLatestAssessmentPeriod_(request.companyName, request.period);
  return generatePowerAssessment(request.companyName, resolvedPeriod);
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

  if (!companyName || companyName.toLowerCase() === 'undefined' || companyName.toLowerCase() === 'null') {
    throw new Error('Company name was not provided to the underwriting engine. Run the assessment from the deployed web app after entering the company name; do not run this function directly from the Apps Script editor.');
  }

  return { companyName: companyName, period: period };
}

function resolveLatestAssessmentPeriod_(companyName, requestedPeriod) {
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName);
  });

  if (!rows.length) {
    throw new Error('The upload completed, but no PDF Summary rows were found for "' + companyName + '". Check the PDF Summaries sheet and confirm that uploadStatementBatch completed successfully.');
  }

  if (requestedPeriod) {
    const exact = rows.filter(function(row) {
      return sameText_(row.detectedPeriod, requestedPeriod);
    });
    if (exact.length) return String(exact[exact.length - 1].detectedPeriod || requestedPeriod).trim();
  }

  for (let i = rows.length - 1; i >= 0; i--) {
    const period = String(rows[i].detectedPeriod || '').trim();
    if (period) return period;
  }
  return '';
}

function diagnoseAssessmentLookup(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, request.companyName);
  });
  return {
    companyName: request.companyName,
    requestedPeriod: request.period,
    matchingRows: rows.length,
    availablePeriods: unique_(rows.map(function(row) { return row.detectedPeriod || ''; }).filter(Boolean)),
    resolvedPeriod: rows.length ? resolveLatestAssessmentPeriod_(request.companyName, request.period) : ''
  };
}

/** Main hybrid underwriting engine. */
function generatePowerAssessment(companyName, period) {
  setupVFC();
  ensurePowerEngineSheets_();

  const current = buildPowerFeatures_(companyName, period);
  if (!current || !current.statementCount) {
    throw new Error('No bank-statement summaries were found for this company and period.');
  }

  const outcomes = collectHistoricalOutcomes_().filter(function(row) {
    return !(sameText_(row.companyName, companyName) && sameText_(row.period, period));
  });
  if (!outcomes.length) {
    throw new Error('No historical lender outcomes are available. Add approvals and declines in the Training Data tab first.');
  }

  const fundamental = calculateFundamentalScore_(current);
  const aiReview = createExpertReview_(current, fundamental);
  const lenders = unique_(outcomes.map(function(row) { return row.lenderName; }).filter(Boolean));
  const rankings = lenders.map(function(lender) {
    return scorePowerLender_(lender, current, outcomes, fundamental, aiReview);
  }).sort(function(a, b) { return b.compositeScore - a.compositeScore; });

  const decision = buildPowerDecision_(current, fundamental, aiReview, rankings);
  const assessmentId = Utilities.getUuid();

  rankings.forEach(function(result) {
    appendRow_('Hybrid Assessments', [
      assessmentId,VFC_POWER_CONFIG.MODEL_VERSION,companyName,period,result.lenderName,
      result.compositeScore,result.observedScore,fundamental.score,result.aiRiskScore,
      result.observedFit,result.confidence,result.historicalCases,result.similarCases,
      result.similarApprovals,result.similarDeclines,result.observedApprovalRate,
      result.lowApprovedAmount,result.highApprovedAmount,result.medianApprovedAmount,
      result.suggestedAmountLow,result.suggestedAmountHigh,result.reasoning,
      cleanCell_(result.conditions),cleanCell_(result.risks),new Date()
    ]);
  });

  appendRow_('Risk Scorecards', [
    assessmentId,companyName,period,fundamental.score,fundamental.grade,
    fundamental.cashFlowScore,fundamental.nsfScore,fundamental.balanceScore,
    fundamental.debtLoadScore,fundamental.coverageScore,fundamental.dataQualityScore,
    cleanCell_(fundamental.strengths),cleanCell_(fundamental.risks),
    cleanCell_(aiReview.missing_information),new Date()
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
    lenderRankings:rankings,
    underwritingSummary:decision,
    disclaimer:'Decision-support analysis using VFC historical outcomes and general cash-flow underwriting principles. It is not an approval, an official lender policy, or a substitute for lender review.'
  };
}

function ensurePowerEngineSheets_() {
  ensureSheetSchema_('Hybrid Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Lender Name','Composite Score',
    'Observed Score','Fundamental Score','AI Risk Score','Observed Fit','Confidence',
    'Historical Cases','Similar Cases','Similar Approvals','Similar Declines','Observed Approval Rate',
    'Low Approved Amount','High Approved Amount','Median Approved Amount','Suggested Amount Low',
    'Suggested Amount High','Reasoning','Conditions','Risks','Created At'
  ]);
  ensureSheetSchema_('Risk Scorecards', [
    'Assessment ID','Company Name','Period','Fundamental Score','Risk Grade','Cash Flow Score',
    'NSF Score','Balance Score','Debt Load Score','Coverage Score','Data Quality Score',
    'Strengths','Risks','Missing Information','Created At'
  ]);
}

function buildPowerFeatures_(companyName, period) {
  const base = buildFeaturesForCase_(companyName, period);
  if (!base) return null;

  const rows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period));
  });

  const openingBalances = rows.map(function(r) { return toNumber_(r.openingBalance); }).filter(isFiniteNumber_);
  const closingBalances = rows.map(function(r) { return toNumber_(r.closingBalance); }).filter(isFiniteNumber_);
  const monthlyDeposits = rows.map(function(r) { return toNumber_(r.totalDeposits); }).filter(function(n) { return n > 0; });
  const monthlyWithdrawals = rows.map(function(r) { return toNumber_(r.totalWithdrawals); }).filter(function(n) { return n > 0; });

  const avgDeposit = average_(monthlyDeposits);
  const depositStdDev = standardDeviation_(monthlyDeposits);
  const depositVolatility = avgDeposit > 0 ? depositStdDev / avgDeposit : 1;
  const depositTrend = calculateTrend_(monthlyDeposits);
  const averageClosingBalance = average_(closingBalances);
  const averageOpeningBalance = average_(openingBalances);
  const nsfPerMonth = base.nsfCount / Math.max(base.monthsCovered, 1);

  const text = rows.map(function(r) {
    return [r.summary, r.risks, r.missingInfo, r.possibleMcaOrLoanPayments].join(' ');
  }).join(' ').toLowerCase();

  return Object.assign({}, base, {
    averageOpeningBalance:round2_(averageOpeningBalance),
    averageClosingBalance:round2_(averageClosingBalance),
    depositVolatility:round2_(depositVolatility),
    depositTrend:round2_(depositTrend),
    nsfPerMonth:round2_(nsfPerMonth),
    overdraftFlag:/overdraft|od fee|over limit|insufficient funds/.test(text) ? 1 : 0,
    returnedPaymentFlag:/returned payment|returned item|reversal|chargeback/.test(text) ? 1 : 0,
    suspectedStacking:/stack|multiple mca|multiple loan|several daily|several weekly/.test(text) ? 1 : 0,
    missingInfoFlag:rows.some(function(r) { return String(r.missingInfo || '').trim().length > 3; }) ? 1 : 0,
    monthlyDeposits:monthlyDeposits,
    monthlyWithdrawals:monthlyWithdrawals
  });
}

function calculateFundamentalScore_(f) {
  const strengths = [];
  const risks = [];
  let cashFlowScore = 50;
  if (f.depositWithdrawalRatio >= 1.15) { cashFlowScore = 90; strengths.push('Deposits materially exceed withdrawals.'); }
  else if (f.depositWithdrawalRatio >= 1.02) { cashFlowScore = 76; strengths.push('Deposits modestly exceed withdrawals.'); }
  else if (f.depositWithdrawalRatio >= 0.92) cashFlowScore = 58;
  else if (f.depositWithdrawalRatio >= 0.80) { cashFlowScore = 38; risks.push('Withdrawals are high relative to deposits.'); }
  else { cashFlowScore = 20; risks.push('Cash outflows materially exceed deposits.'); }
  if (f.depositTrend >= 0.08) { cashFlowScore += 6; strengths.push('Deposits show an improving trend.'); }
  if (f.depositTrend <= -0.08) { cashFlowScore -= 10; risks.push('Deposits show a declining trend.'); }
  if (f.depositVolatility <= 0.18) { cashFlowScore += 4; strengths.push('Deposit activity is relatively stable.'); }
  if (f.depositVolatility >= 0.45) { cashFlowScore -= 8; risks.push('Deposit activity is highly volatile.'); }
  cashFlowScore = clamp_(Math.round(cashFlowScore), 0, 100);

  let nsfScore = 100;
  if (f.nsfPerMonth > 0 && f.nsfPerMonth <= 0.5) nsfScore = 82;
  else if (f.nsfPerMonth <= 1) nsfScore = 68;
  else if (f.nsfPerMonth <= 2) nsfScore = 45;
  else if (f.nsfPerMonth > 2) nsfScore = 20;
  if (f.nsfPerMonth > 0) risks.push('NSF activity detected at approximately ' + round2_(f.nsfPerMonth) + ' per month.');
  else strengths.push('No NSF activity was extracted from the uploaded period.');

  let balanceScore = 78;
  if (f.negativeBalanceFlag) { balanceScore -= 32; risks.push('Negative balances were detected.'); }
  if (f.overdraftFlag) { balanceScore -= 15; risks.push('Overdraft usage or overdraft-related activity was detected.'); }
  if (f.returnedPaymentFlag) { balanceScore -= 12; risks.push('Returned-payment or reversal activity was detected.'); }
  if (f.averageClosingBalance > 0 && f.averageMonthlyDeposits > 0) {
    const liquidityDays = f.averageClosingBalance / (f.averageMonthlyDeposits / 30);
    if (liquidityDays >= 7) { balanceScore += 10; strengths.push('Closing balances provide a reasonable operating cushion.'); }
    else if (liquidityDays < 2) { balanceScore -= 10; risks.push('Average closing balance provides a thin operating cushion.'); }
  }
  balanceScore = clamp_(Math.round(balanceScore), 0, 100);

  let debtLoadScore = 88;
  if (f.mcaPaymentFlag) { debtLoadScore -= 25; risks.push('Existing MCA or loan payments were identified.'); }
  if (f.suspectedStacking) { debtLoadScore -= 28; risks.push('Possible multiple concurrent financing obligations were identified.'); }
  debtLoadScore = clamp_(debtLoadScore, 0, 100);

  let coverageScore = 35;
  if (f.monthsCovered >= 6) coverageScore = 100;
  else if (f.monthsCovered >= 4) coverageScore = 82;
  else if (f.monthsCovered >= 3) coverageScore = 68;
  else if (f.monthsCovered >= 2) coverageScore = 50;
  if (f.monthsCovered < 3) risks.push('Limited statement history reduces reliability.');
  else strengths.push(f.monthsCovered + ' months of statement coverage were analyzed.');

  let dataQualityScore = 100;
  if (f.missingInfoFlag) dataQualityScore -= 20;
  if (!f.averageMonthlyDeposits) dataQualityScore -= 35;
  if (!f.totalWithdrawals) dataQualityScore -= 20;
  if (f.statementCount < 2) dataQualityScore -= 15;
  dataQualityScore = clamp_(dataQualityScore, 0, 100);
  if (dataQualityScore < 75) risks.push('Some extracted information is incomplete or requires manual confirmation.');

  const score = Math.round(cashFlowScore*0.30 + nsfScore*0.18 + balanceScore*0.17 + debtLoadScore*0.17 + coverageScore*0.10 + dataQualityScore*0.08);
  let grade = 'High Risk';
  if (score >= 82) grade = 'Strong';
  else if (score >= 70) grade = 'Acceptable';
  else if (score >= 58) grade = 'Caution';
  else if (score >= 45) grade = 'Elevated Risk';

  return { score:score,grade:grade,cashFlowScore:cashFlowScore,nsfScore:nsfScore,balanceScore:balanceScore,debtLoadScore:debtLoadScore,coverageScore:coverageScore,dataQualityScore:dataQualityScore,strengths:unique_(strengths),risks:unique_(risks) };
}

function scorePowerLender_(lenderName, current, outcomes, fundamental, aiReview) {
  const records = outcomes.filter(function(row) { return sameText_(row.lenderName, lenderName); }).map(function(row) {
    const features = buildPowerFeatures_(row.companyName, row.period);
    const ageWeight = recencyWeight_(row.createdAt);
    return { companyName:row.companyName,period:row.period,decision:normalizeDecision_(row.decision),approvedAmount:toNumber_(row.approvedAmount),declineReason:row.declineReason || '',features:features,ageWeight:ageWeight,similarity:features && features.statementCount ? powerSimilarity_(current, features) : 0 };
  }).filter(function(row) { return row.features && row.features.statementCount; });

  records.sort(function(a,b) { return (b.similarity*b.ageWeight) - (a.similarity*a.ageWeight); });
  const similar = records.slice(0, VFC_POWER_CONFIG.MAX_SIMILAR_CASES);
  const weightedTotal = similar.reduce(function(sum,row) { return sum + row.similarity*row.ageWeight; },0);
  const weightedApprovals = similar.reduce(function(sum,row) {
    const positive = row.decision === 'Approved' ? 1 : row.decision === 'Conditional' ? 0.65 : 0;
    return sum + positive*row.similarity*row.ageWeight;
  },0);
  const approvalRate = weightedTotal ? weightedApprovals/weightedTotal : 0;
  const averageSimilarity = similar.length ? similar.reduce(function(sum,row){return sum+row.similarity;},0)/similar.length : 0;
  const approvals = similar.filter(function(row){return row.decision === 'Approved' || row.decision === 'Conditional';});
  const declines = similar.filter(function(row){return row.decision === 'Declined';});
  const sampleFactor = clamp_(records.length/15,0.25,1);
  const observedRaw = approvalRate*72 + averageSimilarity*28;
  const observedScore = Math.round(50 + (observedRaw-50)*sampleFactor);
  const aiRiskScore = clamp_(toNumber_(aiReview.risk_score || 50),0,100);
  const dataGovernor = fundamental.dataQualityScore/100;
  let composite = observedScore*VFC_POWER_CONFIG.HISTORICAL_WEIGHT + fundamental.score*VFC_POWER_CONFIG.FUNDAMENTAL_WEIGHT + aiRiskScore*VFC_POWER_CONFIG.AI_WEIGHT;
  composite = Math.round(50 + (composite-50)*dataGovernor);

  const amounts = approvals.map(function(row){return row.approvedAmount;}).filter(function(n){return n>0;}).sort(function(a,b){return a-b;});
  const declineReasons = topTextReasons_(declines.map(function(row){return row.declineReason;}));
  const suggested = calculateSuggestedRange_(current, amounts, composite);
  let fit = 'Weak fit';
  if (records.length < 3) fit = 'Insufficient history';
  else if (composite >= 78) fit = 'Strong fit';
  else if (composite >= 65) fit = 'Good fit';
  else if (composite >= 52) fit = 'Caution';
  let confidence = 'Low';
  if (records.length >= 15 && similar.length >= 9 && fundamental.dataQualityScore >= 80) confidence = 'High';
  else if (records.length >= 6 && similar.length >= 4 && fundamental.dataQualityScore >= 65) confidence = 'Moderate';

  return {
    lenderName:lenderName,compositeScore:composite,observedScore:observedScore,aiRiskScore:aiRiskScore,
    observedFit:fit,confidence:confidence,historicalCases:records.length,similarCases:similar.length,
    similarApprovals:approvals.length,similarDeclines:declines.length,
    observedApprovalRate:similar.length ? Math.round(approvalRate*100)+'%' : 'N/A',
    lowApprovedAmount:amounts.length ? amounts[0] : '',highApprovedAmount:amounts.length ? amounts[amounts.length-1] : '',
    medianApprovedAmount:amounts.length ? median_(amounts) : '',suggestedAmountLow:suggested.low,suggestedAmountHigh:suggested.high,
    reasoning:similar.length ? approvals.length+' of '+similar.length+' closest VFC cases were approved or conditional. Historical fit was blended with a '+fundamental.grade.toLowerCase()+' cash-flow risk grade.' : 'No comparable historical cases were available; the score relies primarily on general cash-flow analysis.',
    conditions:unique_((aiReview.recommended_conditions || []).concat(fundamental.dataQualityScore < 75 ? ['Manually verify extracted figures before submission.'] : [])),
    risks:unique_(declineReasons.concat(fundamental.risks).concat(aiReview.key_risks || [])).slice(0,8),
    similarCaseDetails:similar.slice(0,5).map(function(row){return {companyName:row.companyName,period:row.period,decision:row.decision,approvedAmount:row.approvedAmount || '',similarity:Math.round(row.similarity*100)+'%'};})
  };
}

function powerSimilarity_(a,b) {
  const parts = [
    [numericSimilarity_(a.averageMonthlyDeposits,b.averageMonthlyDeposits),0.29],
    [numericSimilarity_(a.depositWithdrawalRatio,b.depositWithdrawalRatio,2),0.13],
    [numericSimilarity_(a.nsfPerMonth,b.nsfPerMonth,2),0.14],
    [numericSimilarity_(a.depositVolatility,b.depositVolatility,1),0.10],
    [numericSimilarity_(a.depositTrend,b.depositTrend,0.5),0.08],
    [a.negativeBalanceFlag === b.negativeBalanceFlag ? 1 : 0,0.08],
    [a.mcaPaymentFlag === b.mcaPaymentFlag ? 1 : 0,0.08],
    [a.suspectedStacking === b.suspectedStacking ? 1 : 0,0.05],
    [numericSimilarity_(a.monthsCovered,b.monthsCovered,6),0.05]
  ];
  return clamp_(parts.reduce(function(sum,p){return sum+p[0]*p[1];},0),0,1);
}

function createExpertReview_(features,fundamental) {
  const fallback = {risk_score:fundamental.score,risk_grade:fundamental.grade,executive_summary:'General cash-flow analysis completed.',key_strengths:fundamental.strengths,key_risks:fundamental.risks,missing_information:[],recommended_conditions:[]};
  try {
    const prompt = [
      'You are a senior Canadian small-business cash-flow underwriter supporting VFC.',
      'Return JSON only with: risk_score (0-100 where higher is stronger), risk_grade, executive_summary, key_strengths, key_risks, missing_information, recommended_conditions.',
      'Use general prudent underwriting principles and the supplied extracted data.',
      'Do not invent official criteria for Journey Capital, Merchant Growth, iCapital Financing, Canacap Funding, or any other lender.',
      'Do not promise approval. Do not infer credit score, ownership, time in business, industry, tax status, or existing balances unless supplied.',
      'Treat missing data as missing rather than negative. Keep arrays short and practical.',
      'Extracted features: '+JSON.stringify(features),
      'Deterministic scorecard: '+JSON.stringify(fundamental)
    ].join('\n');
    const review = callOpenAIJson_(prompt);
    review.risk_score = clamp_(toNumber_(review.risk_score || fundamental.score),0,100);
    review.key_strengths = arraySafe_(review.key_strengths);
    review.key_risks = arraySafe_(review.key_risks);
    review.missing_information = arraySafe_(review.missing_information);
    review.recommended_conditions = arraySafe_(review.recommended_conditions);
    return review;
  } catch (e) { return fallback; }
}

function buildPowerDecision_(features,fundamental,aiReview,rankings) {
  const top = rankings[0] || {};
  const second = rankings[1] || {};
  let recommendation = 'Manual review required';
  if (top.compositeScore >= 78 && top.confidence !== 'Low') recommendation = 'Strong submission candidate';
  else if (top.compositeScore >= 65) recommendation = 'Submit with conditions';
  else if (top.compositeScore >= 52) recommendation = 'Caution — strengthen file before submission';
  else recommendation = 'High risk — manual exception review';
  return {
    summary:recommendation,strongest_lender:top.lenderName || '',
    explanation:(aiReview.executive_summary || '') + (top.lenderName ? ' Best observed lender match: '+top.lenderName+' at '+top.compositeScore+'/100.' : ''),
    fundamental_score:fundamental.score,risk_grade:fundamental.grade,
    score_gap:top.compositeScore && second.compositeScore ? top.compositeScore-second.compositeScore : 0,
    key_strengths:fundamental.strengths,key_risks:unique_(fundamental.risks.concat(aiReview.key_risks || [])).slice(0,8),
    missing_information:aiReview.missing_information || [],recommended_conditions:aiReview.recommended_conditions || []
  };
}

function calculateSuggestedRange_(features,historicalAmounts,compositeScore) {
  if (!historicalAmounts.length || !features.averageMonthlyDeposits) return {low:'',high:''};
  const historicalMedian = median_(historicalAmounts);
  const depositLow = features.averageMonthlyDeposits*0.45;
  const depositHigh = features.averageMonthlyDeposits*0.85;
  const qualityFactor = clamp_(compositeScore/75,0.55,1.15);
  const low = Math.max(0,Math.min(historicalMedian*0.65,depositLow)*qualityFactor);
  const high = Math.max(low,Math.min(historicalMedian*1.20,depositHigh)*qualityFactor);
  return {low:roundToNearest_(low,500),high:roundToNearest_(high,500)};
}

function recencyWeight_(dateValue) {
  const d = parseDateSafe_(dateValue);
  if (!d) return 0.85;
  const months = Math.max(0,(new Date().getTime()-d.getTime())/(1000*60*60*24*30.4));
  return clamp_(Math.exp(-months/30),0.55,1);
}

function topTextReasons_(reasons) {
  const counts = {};
  reasons.filter(Boolean).forEach(function(reason) {
    String(reason).split(/[\n;,|]+/).forEach(function(piece) {
      const clean = piece.trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      counts[key] = counts[key] || {text:clean,count:0};
      counts[key].count++;
    });
  });
  return Object.keys(counts).map(function(k){return counts[k];}).sort(function(a,b){return b.count-a.count;}).slice(0,4).map(function(x){return x.text;});
}

function calculateTrend_(values) {
  if (!values || values.length < 2) return 0;
  const avg = average_(values);
  return avg ? (values[values.length-1]-values[0])/avg : 0;
}
function standardDeviation_(values) {
  if (!values || values.length < 2) return 0;
  const avg = average_(values);
  return Math.sqrt(values.reduce(function(sum,n){return sum+Math.pow(n-avg,2);},0)/values.length);
}
function average_(values) {
  const nums = (values || []).filter(isFiniteNumber_);
  return nums.length ? nums.reduce(function(a,b){return a+b;},0)/nums.length : 0;
}
function isFiniteNumber_(n) { return typeof n === 'number' && isFinite(n); }
function arraySafe_(value) { return Array.isArray(value) ? value : value ? [String(value)] : []; }
function roundToNearest_(value,nearest) { return Math.round(toNumber_(value)/nearest)*nearest; }
