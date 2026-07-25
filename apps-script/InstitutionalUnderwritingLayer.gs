const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-INSTITUTIONAL-3.0-PHASE-1',
  ASSUMED_FACTOR_RATE: 1.25,
  ASSUMED_TERM_MONTHS: 12,
  MIN_PAYMENT_COVERAGE: 1.15,
  TARGET_PAYMENT_COVERAGE: 1.35
};

/**
 * Institutional web-app entry point.
 * Enriches the existing hybrid assessment without changing the proven base engine.
 */
function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  const institutional = buildInstitutionalAssessment_(base);
  saveInstitutionalAssessment_(base, institutional);
  base.institutionalAssessment = institutional;
  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. Approval probability, repayment stability, fraud risk and lending amounts are estimates based on available data, assumptions and historical observations; they are not guarantees or official lender decisions.';
  return base;
}

function buildInstitutionalAssessment_(base) {
  const f = base.currentFeatures || {};
  const fundamental = base.fundamentalScorecard || {};
  const capacity = base.lendingCapacity || {};
  const rankings = base.lenderRankings || [];
  const ai = base.expertReview || {};
  const top = rankings[0] || {};

  const hardStops = evaluateInstitutionalHardStops_(f, fundamental);
  const payment = calculatePaymentCapacity_(f, capacity);
  const repayment = calculateRepaymentStability_(f, fundamental, payment);
  const approval = calculateApprovalProbability_(top, fundamental, capacity, hardStops);
  const fraud = calculateFraudRiskProxy_(f, fundamental);
  const reasons = buildInstitutionalReasonCodes_(f, fundamental, payment, repayment, hardStops);
  const confidence = calculateInstitutionalConfidence_(f, fundamental, top);

  let recommendedAmount = toNumber_(capacity.recommendedAmount);
  let stretchAmount = toNumber_(capacity.stretchAmount);
  let decision = 'Proceed with conditions';

  if (hardStops.blocking.length) {
    recommendedAmount = 0;
    stretchAmount = 0;
    decision = 'Manual review required';
  } else if (repayment.score < 45 || payment.coverageRatio < 1.0) {
    recommendedAmount = roundToNearest_(recommendedAmount * 0.60, VFC_POWER_CONFIG.ROUNDING);
    stretchAmount = recommendedAmount;
    decision = 'High risk — reduce exposure or decline';
  } else if (repayment.score < 60 || payment.coverageRatio < VFC_INSTITUTIONAL_CONFIG.MIN_PAYMENT_COVERAGE) {
    recommendedAmount = roundToNearest_(recommendedAmount * 0.80, VFC_POWER_CONFIG.ROUNDING);
    stretchAmount = recommendedAmount;
    decision = 'Caution — reduced exposure recommended';
  } else if (repayment.score >= 80 && approval.probability >= 75) {
    decision = 'Strong submission candidate';
  }

  return {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    businessHealth: {
      score: toNumber_(fundamental.score),
      grade: fundamental.grade || 'Not rated'
    },
    approvalProbability: approval,
    repaymentStability: repayment,
    fraudRisk: fraud,
    paymentCapacity: payment,
    lendingRecommendation: {
      recommendedAmount: recommendedAmount,
      stretchAmount: stretchAmount,
      originalEngineAmount: toNumber_(capacity.recommendedAmount),
      adjustmentApplied: recommendedAmount - toNumber_(capacity.recommendedAmount),
      decision: decision
    },
    confidence: confidence,
    hardStops: hardStops,
    positiveReasonCodes: reasons.positive,
    negativeReasonCodes: reasons.negative,
    requiredConditions: unique_([].concat(hardStops.conditions, ai.recommended_conditions || [], repayment.conditions || [])).slice(0, 10),
    underwriterRecommendation: buildInstitutionalRecommendation_(decision, top, recommendedAmount, stretchAmount, repayment, payment, hardStops),
    methodologyNote: 'Repayment Stability is currently a banking-behaviour proxy because funded repayment-performance records are not yet available. It should be recalibrated when 30/60/90-day, renewal, payoff and default outcomes are recorded.'
  };
}

function calculatePaymentCapacity_(f, capacity) {
  const deposits = Math.max(0, toNumber_(f.averageMonthlyDeposits));
  const withdrawals = Math.max(0, toNumber_(f.averageMonthlyWithdrawals || (f.totalWithdrawals && f.monthsCovered ? f.totalWithdrawals / f.monthsCovered : 0)));
  const ratio = toNumber_(f.depositWithdrawalRatio);

  // Conservative proxy until categorized operating expenses and exact debt payments are available.
  const impliedMargin = clamp_(ratio - 0.84, 0.04, 0.24);
  const depositBasedSurplus = deposits * impliedMargin;
  const observedNetMovement = withdrawals > 0 ? Math.max(0, deposits - withdrawals) : 0;
  const estimatedFreeCashFlow = round2_(depositBasedSurplus * 0.75 + observedNetMovement * 0.25);

  const proposedAmount = Math.max(0, toNumber_(capacity.recommendedAmount));
  const estimatedMonthlyPayment = proposedAmount > 0
    ? round2_((proposedAmount * VFC_INSTITUTIONAL_CONFIG.ASSUMED_FACTOR_RATE) / VFC_INSTITUTIONAL_CONFIG.ASSUMED_TERM_MONTHS)
    : 0;
  const coverageRatio = estimatedMonthlyPayment > 0 ? round2_(estimatedFreeCashFlow / estimatedMonthlyPayment) : 0;
  const maxSupportablePayment = round2_(estimatedFreeCashFlow / VFC_INSTITUTIONAL_CONFIG.TARGET_PAYMENT_COVERAGE);
  const paymentBasedAmount = roundToNearest_((maxSupportablePayment * VFC_INSTITUTIONAL_CONFIG.ASSUMED_TERM_MONTHS) / VFC_INSTITUTIONAL_CONFIG.ASSUMED_FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING);

  return {
    averageMonthlyDeposits: round2_(deposits),
    averageMonthlyWithdrawals: round2_(withdrawals),
    estimatedMonthlyFreeCashFlow: estimatedFreeCashFlow,
    estimatedMonthlyPayment: estimatedMonthlyPayment,
    paymentCoverageRatio: coverageRatio,
    coverageRatio: coverageRatio,
    maximumSupportableMonthlyPayment: maxSupportablePayment,
    paymentBasedMaximumAmount: Math.max(0, paymentBasedAmount),
    assumedFactorRate: VFC_INSTITUTIONAL_CONFIG.ASSUMED_FACTOR_RATE,
    assumedTermMonths: VFC_INSTITUTIONAL_CONFIG.ASSUMED_TERM_MONTHS,
    assessment: coverageRatio >= 1.50 ? 'Strong' : coverageRatio >= 1.30 ? 'Acceptable' : coverageRatio >= 1.15 ? 'Caution' : 'Weak'
  };
}

function calculateRepaymentStability_(f, fundamental, payment) {
  const stability = clamp_(100 - toNumber_(f.depositVolatility) * 100, 0, 100);
  const trend = clamp_(55 + toNumber_(f.depositTrend) * 180, 0, 100);
  const behaviour = Math.round(
    toNumber_(fundamental.nsfScore) * 0.45 +
    toNumber_(fundamental.balanceScore) * 0.35 +
    toNumber_(fundamental.debtLoadScore) * 0.20
  );
  const paymentScore = payment.coverageRatio >= 1.75 ? 100 : payment.coverageRatio >= 1.50 ? 90 : payment.coverageRatio >= 1.30 ? 78 : payment.coverageRatio >= 1.15 ? 62 : payment.coverageRatio >= 1.0 ? 45 : 25;
  const historyScore = Math.min(100, Math.max(25, toNumber_(f.monthsCovered) / 6 * 100));

  let score = Math.round(
    stability * 0.24 +
    trend * 0.12 +
    paymentScore * 0.28 +
    behaviour * 0.26 +
    historyScore * 0.10
  );
  if (f.mcaPaymentFlag) score -= 7;
  if (f.suspectedStacking) score -= 12;
  if (f.negativeBalanceFlag) score -= 8;
  score = clamp_(score, 0, 100);

  const outlook = score >= 85 ? 'Very Strong' : score >= 75 ? 'Strong' : score >= 62 ? 'Acceptable' : score >= 50 ? 'Caution' : 'Weak';
  const conditions = [];
  if (payment.coverageRatio < 1.30) conditions.push('Confirm exact existing debt payments and reduce the proposed payment if necessary.');
  if (f.mcaPaymentFlag) conditions.push('Obtain current statements or payout letters for existing financing.');
  if (f.monthsCovered < 6) conditions.push('Obtain additional bank-statement history before relying on the repayment estimate.');

  return {
    score: score,
    outlook: outlook,
    proxyProbability: score,
    label: 'Banking-behaviour repayment proxy',
    components: {
      cashFlowStability: Math.round(stability),
      depositTrend: Math.round(trend),
      paymentCapacity: paymentScore,
      bankingBehaviour: behaviour,
      statementHistory: Math.round(historyScore)
    },
    conditions: conditions
  };
}

function calculateApprovalProbability_(top, fundamental, capacity, hardStops) {
  if (hardStops.blocking.length) return { probability: 0, band: 'Manual review', topLender: top.lenderName || '' };
  const topScore = toNumber_(top.compositeScore || 50);
  const data = toNumber_(fundamental.dataQualityScore || 50);
  const amountConfidence = toNumber_(capacity.confidenceScore || 50);
  const probability = clamp_(Math.round(topScore * 0.60 + data * 0.20 + amountConfidence * 0.20), 5, 95);
  return {
    probability: probability,
    band: probability >= 80 ? 'High' : probability >= 65 ? 'Moderate-High' : probability >= 50 ? 'Moderate' : probability >= 35 ? 'Low-Moderate' : 'Low',
    topLender: top.lenderName || '',
    observedApprovalRate: top.observedApprovalRate || 'N/A'
  };
}

function calculateFraudRiskProxy_(f, fundamental) {
  let score = 5;
  const flags = [];
  if (f.missingInfoFlag) { score += 12; flags.push('Extracted information is incomplete.'); }
  if (toNumber_(fundamental.dataQualityScore) < 60) { score += 18; flags.push('Low extraction or document-data confidence.'); }
  if (!f.averageMonthlyDeposits || !f.statementCount) { score += 25; flags.push('Critical banking fields are missing.'); }
  if (f.returnedPaymentFlag) { score += 5; flags.push('Returned or reversed transactions require review.'); }
  score = clamp_(score, 0, 100);
  return {
    score: score,
    grade: score <= 15 ? 'Low' : score <= 35 ? 'Moderate' : score <= 60 ? 'Elevated' : 'High',
    flags: flags,
    limitation: 'This is a document-data anomaly proxy, not forensic document authentication.'
  };
}

function evaluateInstitutionalHardStops_(f, fundamental) {
  const blocking = [];
  const warnings = [];
  const conditions = [];
  if (!f.statementCount || !f.averageMonthlyDeposits) blocking.push('Insufficient usable banking data.');
  if (toNumber_(fundamental.dataQualityScore) < 35) blocking.push('Critical data quality is too low for automated sizing.');
  if (f.monthsCovered < 2) blocking.push('Less than two months of usable statement history.');
  if (f.suspectedStacking) warnings.push('Possible multiple concurrent financing obligations.');
  if (f.nsfPerMonth > 2) warnings.push('Severe recurring NSF activity.');
  if (f.negativeBalanceFlag) warnings.push('Negative balances detected.');
  if (f.missingInfoFlag) conditions.push('Manually verify all material extracted figures.');
  return { blocking: unique_(blocking), warnings: unique_(warnings), conditions: unique_(conditions) };
}

function buildInstitutionalReasonCodes_(f, fundamental, payment, repayment, hardStops) {
  const positive = [], negative = [];
  if (f.depositVolatility <= 0.20) positive.push('P01 Stable monthly deposits');
  if (f.depositTrend >= 0.05) positive.push('P02 Positive deposit trend');
  if (f.nsfPerMonth === 0) positive.push('P03 No extracted NSF activity');
  if (!f.negativeBalanceFlag) positive.push('P04 No extracted negative-balance flag');
  if (payment.coverageRatio >= 1.30) positive.push('P05 Acceptable proposed-payment coverage');
  if (f.monthsCovered >= 6) positive.push('P06 Six or more months analyzed');

  if (f.depositTrend <= -0.08) negative.push('N01 Declining deposit trend');
  if (f.depositVolatility >= 0.45) negative.push('N02 High revenue volatility');
  if (f.nsfPerMonth > 0) negative.push('N03 NSF activity detected');
  if (f.negativeBalanceFlag) negative.push('N04 Negative balances detected');
  if (f.mcaPaymentFlag) negative.push('N05 Existing financing payments detected');
  if (f.suspectedStacking) negative.push('N06 Possible stacking');
  if (payment.coverageRatio < 1.15) negative.push('N07 Weak proposed-payment coverage');
  if (fundamental.dataQualityScore < 70) negative.push('N08 Data requires manual verification');
  hardStops.blocking.forEach(function(x) { negative.push('HARD STOP: ' + x); });
  return { positive: unique_(positive), negative: unique_(negative) };
}

function calculateInstitutionalConfidence_(f, fundamental, top) {
  const statementScore = Math.min(100, toNumber_(f.monthsCovered) / 6 * 100);
  const sampleScore = Math.min(100, toNumber_(top.similarCases) / 8 * 100);
  const score = Math.round(toNumber_(fundamental.dataQualityScore) * 0.50 + statementScore * 0.30 + sampleScore * 0.20);
  return {
    score: score,
    grade: score >= 85 ? 'High' : score >= 65 ? 'Moderate' : 'Low',
    basis: [
      f.monthsCovered + ' months of statements',
      toNumber_(top.similarCases) + ' comparable historical cases',
      toNumber_(fundamental.dataQualityScore) + '/100 data quality'
    ]
  };
}

function buildInstitutionalRecommendation_(decision, top, amount, stretch, repayment, payment, hardStops) {
  if (hardStops.blocking.length) return 'Do not issue an automated lending recommendation. Resolve the hard-stop items and complete manual underwriting.';
  let text = decision + '. ';
  if (top.lenderName) text += 'First lender review: ' + top.lenderName + '. ';
  text += 'VFC internal recommended amount: ' + amount + '.';
  if (stretch > amount) text += ' Stretch exposure up to ' + stretch + ' only after confirming external credit, existing obligations and repayment capacity.';
  text += ' Repayment stability is ' + repayment.outlook + ' with estimated proposed-payment coverage of ' + payment.coverageRatio + 'x.';
  return text;
}

function saveInstitutionalAssessment_(base, i) {
  ensureSheetSchema_('Institutional Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Business Health','Approval Probability',
    'Repayment Stability','Repayment Outlook','Fraud Risk','Recommended Amount','Stretch Amount',
    'Estimated Free Cash Flow','Estimated Payment','Payment Coverage','Payment-Based Maximum',
    'Confidence','Decision','Positive Reason Codes','Negative Reason Codes','Hard Stops',
    'Required Conditions','Underwriter Recommendation','Created At'
  ]);
  appendRow_('Institutional Assessments', [
    base.assessmentId,VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,base.companyName,base.period,
    i.businessHealth.score,i.approvalProbability.probability,i.repaymentStability.score,
    i.repaymentStability.outlook,i.fraudRisk.score,i.lendingRecommendation.recommendedAmount,
    i.lendingRecommendation.stretchAmount,i.paymentCapacity.estimatedMonthlyFreeCashFlow,
    i.paymentCapacity.estimatedMonthlyPayment,i.paymentCapacity.coverageRatio,
    i.paymentCapacity.paymentBasedMaximumAmount,i.confidence.score,i.lendingRecommendation.decision,
    cleanCell_(i.positiveReasonCodes),cleanCell_(i.negativeReasonCodes),
    cleanCell_(i.hardStops.blocking),cleanCell_(i.requiredConditions),
    i.underwriterRecommendation,new Date()
  ]);
}
