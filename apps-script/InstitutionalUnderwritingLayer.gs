const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-INSTITUTIONAL-3.4-HISTORICAL-COMFORT-OFFER',
  FACTOR_RATE: 1.26,
  TARGET_COVERAGE: 1.20,
  STRETCH_COVERAGE: 1.05,
  STRESS_DECLINE: 0.10,
  BASE_DEPOSIT_PAYMENT_SHARE: 0.15,
  MIN_DEPOSIT_PAYMENT_SHARE: 0.10,
  MAX_DEPOSIT_PAYMENT_SHARE: 0.20,
  TERM_ANCHOR_RATIOS: { '6': 0.55, '9': 0.78, '12': 1.00 },
  TERMS: [6, 9, 12]
};

function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  const institutional = buildInstitutionalAssessment_(base);
  saveInstitutionalAssessment_(base, institutional);
  base.institutionalAssessment = institutional;
  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. The Proposed Funding Offer preserves the proven historical underwriting recommendation and uses VFC repayment intelligence to produce comfortable 6, 9 and 12 month options. Existing lender analysis remains separate and unchanged.';
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
  const cashFlow = calculateDebtServiceCashFlow_(f, fundamental);
  const businessHealth = calculateBusinessHealth_(f, fundamental, cashFlow);
  const scenarios = calculateDebtServiceScenarios_(cashFlow, capacity, hardStops, businessHealth);
  const confidence = calculateInstitutionalConfidence_(f, fundamental, top);
  const reasons = buildDebtServiceReasonCodes_(f, fundamental, cashFlow, scenarios, hardStops);

  const primary = scenarios.byTerm['12'] || scenarios.byTerm['9'] || scenarios.byTerm['6'];
  const recommendation = hardStops.blocking.length
    ? 'Manual review required'
    : primary.coverageAtRecommended >= VFC_INSTITUTIONAL_CONFIG.TARGET_COVERAGE
      ? 'Strong proposed funding offer'
      : primary.coverageAtRecommended >= VFC_INSTITUTIONAL_CONFIG.STRETCH_COVERAGE
        ? 'Proposed offer available with conditions'
        : 'Historically supported — payment review recommended';

  const proposedFundingOffer = {
    label: 'Proposed Funding Offer',
    recommendedAmount: primary.recommendedAmount,
    potentialLendingAmount: scenarios.priorEngine12MonthAnchor,
    stretchAmount: primary.stretchAmount,
    selectedTermMonths: primary.termMonths,
    totalRepayment: primary.totalRepayment,
    financingCost: primary.financingCost,
    estimatedMonthlyPayment: primary.estimatedMonthlyPayment,
    coverageRatio: primary.coverageAtRecommended,
    decision: recommendation,
    pricingAssumption: {
      factorRate: VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE,
      targetCoverage: VFC_INSTITUTIONAL_CONFIG.TARGET_COVERAGE,
      stretchCoverage: VFC_INSTITUTIONAL_CONFIG.STRETCH_COVERAGE
    }
  };

  return {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    businessHealth: businessHealth,
    debtServiceCapacity: {
      score: scenarios.capacityScore,
      grade: scenarios.capacityGrade,
      maximumSupportableMonthlyPayment: scenarios.maximumSupportableMonthlyPayment,
      targetCoverage: VFC_INSTITUTIONAL_CONFIG.TARGET_COVERAGE,
      stretchCoverage: VFC_INSTITUTIONAL_CONFIG.STRETCH_COVERAGE
    },
    cashFlowAnalysis: cashFlow,
    termScenarios: scenarios,
    proposedFundingOffer: proposedFundingOffer,
    lendingRecommendation: proposedFundingOffer,
    approvalProbability: {
      probability: top.compositeScore || 0,
      band: top.observedFit || 'Insufficient history',
      topLender: top.lenderName || '',
      note: 'Historical lender-fit indicator only. Existing lender analysis is unchanged and remains separate from the VFC Proposed Funding Offer.'
    },
    confidence: confidence,
    hardStops: hardStops,
    positiveReasonCodes: reasons.positive,
    negativeReasonCodes: reasons.negative,
    requiredConditions: unique_([].concat(hardStops.conditions, ai.recommended_conditions || [], scenarios.conditions || [])).slice(0, 10),
    underwriterRecommendation: buildDebtServiceRecommendation_(recommendation, primary, cashFlow, businessHealth, hardStops, scenarios),
    methodologyNote: 'The original proven underwriting proposal remains the 12-month potential lending amount. VFC then sizes comfortable 6-, 9- and 12-month offers using business health, deposit stability, banking conduct and repayment capacity. Total repayment uses an average 1.26 payback factor.'
  };
}

function calculateDebtServiceCashFlow_(f, fundamental) {
  const deposits = Math.max(0, toNumber_(f.averageMonthlyDeposits));
  const withdrawals = Math.max(0, toNumber_(f.averageMonthlyWithdrawals || (f.totalWithdrawals && f.monthsCovered ? f.totalWithdrawals / f.monthsCovered : 0)));
  const monthlyDeposits = (f.monthlyDeposits || []).filter(function(n) { return toNumber_(n) > 0; }).map(toNumber_);
  const recentDeposits = average_(monthlyDeposits.slice(-3)) || deposits;
  const weakestDeposits = monthlyDeposits.length ? Math.min.apply(null, monthlyDeposits) : deposits;

  let paymentShare = VFC_INSTITUTIONAL_CONFIG.BASE_DEPOSIT_PAYMENT_SHARE;
  if (toNumber_(fundamental.score) >= 82) paymentShare += 0.025;
  else if (toNumber_(fundamental.score) >= 70) paymentShare += 0.015;
  if (toNumber_(f.depositVolatility) <= 0.20) paymentShare += 0.01;
  if (toNumber_(f.depositTrend) >= 0.05) paymentShare += 0.01;
  if (toNumber_(f.nsfPerMonth) > 0) paymentShare -= Math.min(0.025, toNumber_(f.nsfPerMonth) * 0.006);
  if (f.negativeBalanceFlag) paymentShare -= 0.0125;
  if (f.mcaPaymentFlag) paymentShare -= 0.0125;
  if (f.suspectedStacking) paymentShare -= 0.025;
  if (toNumber_(fundamental.dataQualityScore) < 60) paymentShare -= 0.01;
  paymentShare = clamp_(paymentShare, VFC_INSTITUTIONAL_CONFIG.MIN_DEPOSIT_PAYMENT_SHARE, VFC_INSTITUTIONAL_CONFIG.MAX_DEPOSIT_PAYMENT_SHARE);

  const averagePaymentCapacity = deposits * paymentShare;
  const recentPaymentCapacity = recentDeposits * paymentShare;
  const weakestPaymentCapacity = weakestDeposits * paymentShare;
  const stableDepositBase = Math.min(deposits || 0, recentDeposits || deposits || 0);
  const conservativePaymentCapacity = round2_(Math.min(averagePaymentCapacity, recentPaymentCapacity, Math.max(weakestPaymentCapacity, stableDepositBase * paymentShare * 0.80)));
  const stressedPaymentCapacity = round2_(conservativePaymentCapacity * (1 - VFC_INSTITUTIONAL_CONFIG.STRESS_DECLINE));

  return {
    averageMonthlyDeposits: round2_(deposits),
    averageMonthlyWithdrawals: round2_(withdrawals),
    averageFreeCashFlow: round2_(averagePaymentCapacity),
    recentThreeMonthFreeCashFlow: round2_(recentPaymentCapacity),
    weakestMonthFreeCashFlow: round2_(weakestPaymentCapacity),
    conservativeFreeCashFlow: conservativePaymentCapacity,
    stressedFreeCashFlow: stressedPaymentCapacity,
    depositPaymentShare: round2_(paymentShare * 100),
    stressDeclinePercent: Math.round(VFC_INSTITUTIONAL_CONFIG.STRESS_DECLINE * 100),
    monthsAnalyzed: toNumber_(f.monthsCovered)
  };
}

function calculateDebtServiceScenarios_(cashFlow, capacity, hardStops, businessHealth) {
  const originalEngineAmount = Math.max(0, toNumber_(capacity.recommendedAmount));
  const originalStretchAmount = Math.max(originalEngineAmount, toNumber_(capacity.stretchAmount));
  const comfortablePayment = hardStops.blocking.length ? 0 : cashFlow.conservativeFreeCashFlow;
  const stressedPayment = hardStops.blocking.length ? 0 : cashFlow.stressedFreeCashFlow;
  const healthAdjustment = businessHealth.score >= 82 ? 1.05 : businessHealth.score >= 70 ? 1.00 : businessHealth.score >= 58 ? 0.92 : 0.82;
  const byTerm = {};

  VFC_INSTITUTIONAL_CONFIG.TERMS.forEach(function(term) {
    const anchorRatio = VFC_INSTITUTIONAL_CONFIG.TERM_ANCHOR_RATIOS[String(term)] || (term / 12);
    const historicalTermAnchor = roundToNearest_(originalEngineAmount * anchorRatio * healthAdjustment, VFC_POWER_CONFIG.ROUNDING);
    const comfortableCapacity = roundToNearest_((comfortablePayment * term) / VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING);
    const stressedCapacity = roundToNearest_((stressedPayment * term) / VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING);

    let recommendedAmount;
    if (term === 12) {
      recommendedAmount = originalEngineAmount;
    } else {
      const lowerGuardrail = originalEngineAmount * (term === 9 ? 0.65 : 0.42);
      recommendedAmount = Math.min(originalEngineAmount, Math.max(historicalTermAnchor, Math.min(comfortableCapacity, originalEngineAmount)));
      recommendedAmount = Math.max(lowerGuardrail, recommendedAmount);
    }
    recommendedAmount = hardStops.blocking.length ? 0 : roundToNearest_(recommendedAmount, VFC_POWER_CONFIG.ROUNDING);

    const totalRepayment = round2_(recommendedAmount * VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE);
    const financingCost = round2_(totalRepayment - recommendedAmount);
    const estimatedMonthlyPayment = recommendedAmount > 0 ? round2_(totalRepayment / term) : 0;
    const coverage = estimatedMonthlyPayment > 0 ? round2_(comfortablePayment / estimatedMonthlyPayment) : 0;
    const stressCoverage = estimatedMonthlyPayment > 0 ? round2_(stressedPayment / estimatedMonthlyPayment) : 0;
    const paymentShareOfDeposits = cashFlow.averageMonthlyDeposits > 0 ? round2_(estimatedMonthlyPayment / cashFlow.averageMonthlyDeposits * 100) : 0;

    byTerm[String(term)] = {
      termMonths: term,
      factorRate: VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE,
      recommendedAmount: Math.max(0, recommendedAmount),
      baseSupportableAmount: Math.max(0, comfortableCapacity),
      priorEngineAnchor: Math.max(0, historicalTermAnchor),
      potentialLendingAmount: originalEngineAmount,
      stretchAmount: term === 12 ? originalStretchAmount : Math.max(recommendedAmount, roundToNearest_(originalStretchAmount * anchorRatio, VFC_POWER_CONFIG.ROUNDING)),
      stressTestedAmount: Math.max(0, stressedCapacity),
      totalRepayment: totalRepayment,
      financingCost: financingCost,
      estimatedMonthlyPayment: estimatedMonthlyPayment,
      estimatedWeeklyPayment: round2_(estimatedMonthlyPayment * 12 / 52),
      estimatedBusinessDailyPayment: round2_(estimatedMonthlyPayment * 12 / 260),
      coverageAtRecommended: coverage,
      stressCoverageAtRecommended: stressCoverage,
      paymentShareOfDeposits: paymentShareOfDeposits,
      decision: coverage >= 1.20 && stressCoverage >= 1.05 ? 'Comfortably supportable' : coverage >= 1.05 ? 'Supportable with monitoring' : term === 12 ? 'Historically supported — review payment load' : 'Use longer term'
    };
  });

  const capacityScore = clamp_(Math.round((cashFlow.depositPaymentShare / VFC_INSTITUTIONAL_CONFIG.MAX_DEPOSIT_PAYMENT_SHARE) * 65 + Math.min(100, cashFlow.monthsAnalyzed / 6 * 100) * 0.20 + businessHealth.score * 0.15), 0, 100);
  const conditions = [];
  if (cashFlow.monthsAnalyzed < 6) conditions.push('Obtain six complete months of business bank statements for final confirmation.');
  if (byTerm['12'].coverageAtRecommended < 1.05) conditions.push('The historically supported amount should be reviewed against current obligations before funding.');

  return {
    maximumSupportableMonthlyPayment: round2_(comfortablePayment),
    stretchMonthlyPayment: round2_(comfortablePayment / VFC_INSTITUTIONAL_CONFIG.STRETCH_COVERAGE),
    stressTestedMonthlyPayment: round2_(stressedPayment),
    priorEngine12MonthAnchor: originalEngineAmount,
    originalStretchAmount: originalStretchAmount,
    capacityScore: capacityScore,
    capacityGrade: capacityScore >= 80 ? 'Strong' : capacityScore >= 65 ? 'Acceptable' : capacityScore >= 50 ? 'Caution' : 'Weak',
    byTerm: byTerm,
    conditions: conditions
  };
}

function calculateBusinessHealth_(f, fundamental, cashFlow) {
  const depositStrength = clamp_(Math.round(toNumber_(fundamental.cashFlowScore)), 0, 100);
  const capacityRatio = cashFlow.averageMonthlyDeposits > 0 ? cashFlow.conservativeFreeCashFlow / cashFlow.averageMonthlyDeposits : 0;
  const capacityScore = capacityRatio >= 0.18 ? 95 : capacityRatio >= 0.15 ? 85 : capacityRatio >= 0.12 ? 72 : capacityRatio >= 0.10 ? 58 : 40;
  const stabilityScore = clamp_(Math.round(100 - toNumber_(f.depositVolatility) * 100), 0, 100);
  const balanceScore = clamp_(toNumber_(fundamental.balanceScore), 0, 100);
  const conductScore = clamp_(Math.round(toNumber_(fundamental.nsfScore) * 0.60 + toNumber_(fundamental.debtLoadScore) * 0.40), 0, 100);
  const score = Math.round(depositStrength * 0.25 + capacityScore * 0.25 + stabilityScore * 0.15 + balanceScore * 0.15 + conductScore * 0.20);
  return {
    score: score,
    grade: score >= 82 ? 'Strong' : score >= 70 ? 'Acceptable' : score >= 58 ? 'Caution' : score >= 45 ? 'Elevated Risk' : 'Weak',
    components: {
      depositStrength: depositStrength,
      cashFlowSurplus: capacityScore,
      depositStability: stabilityScore,
      liquidity: balanceScore,
      bankingConductAndDebt: conductScore
    }
  };
}

function evaluateInstitutionalHardStops_(f, fundamental) {
  const blocking = [], warnings = [], conditions = [];
  if (!f.statementCount || !f.averageMonthlyDeposits) blocking.push('Insufficient usable banking data.');
  if (toNumber_(fundamental.dataQualityScore) < 35) blocking.push('Critical data quality is too low for automated sizing.');
  if (f.monthsCovered < 2) blocking.push('Less than two months of usable statement history.');
  if (f.suspectedStacking) warnings.push('Possible multiple concurrent financing obligations.');
  if (f.nsfPerMonth > 2) warnings.push('Severe recurring NSF activity.');
  if (f.negativeBalanceFlag) warnings.push('Negative balances detected.');
  if (f.missingInfoFlag) conditions.push('Manually verify all material extracted figures.');
  return { blocking: unique_(blocking), warnings: unique_(warnings), conditions: unique_(conditions) };
}

function buildDebtServiceReasonCodes_(f, fundamental, cashFlow, scenarios, hardStops) {
  const positive = [], negative = [];
  if (f.depositVolatility <= 0.20) positive.push('BH01 Stable monthly deposits');
  if (f.depositTrend >= 0.05) positive.push('BH02 Positive deposit trend');
  if (f.nsfPerMonth === 0) positive.push('BK01 No extracted NSF activity');
  if (!f.negativeBalanceFlag) positive.push('BK02 No extracted negative-balance flag');
  if (cashFlow.conservativeFreeCashFlow > 0) positive.push('DS01 Positive repayment capacity');
  if (scenarios.priorEngine12MonthAnchor > 0) positive.push('DS02 Proven historical proposal preserved');
  if (f.depositTrend <= -0.08) negative.push('BH06 Declining deposit trend');
  if (f.depositVolatility >= 0.45) negative.push('BH07 High deposit volatility');
  if (f.nsfPerMonth > 0) negative.push('BK04 NSF activity detected');
  if (f.negativeBalanceFlag) negative.push('BK05 Negative balances detected');
  if (f.mcaPaymentFlag) negative.push('DB03 Existing financing payments detected');
  if (f.suspectedStacking) negative.push('DB05 Possible stacking');
  if (scenarios.byTerm['12'].coverageAtRecommended < 1.05) negative.push('DS06 Proposed payment requires obligation review');
  if (fundamental.dataQualityScore < 70) negative.push('DQ02 Material figures require manual verification');
  hardStops.blocking.forEach(function(x) { negative.push('HARD STOP: ' + x); });
  return { positive: unique_(positive), negative: unique_(negative) };
}

function calculateInstitutionalConfidence_(f, fundamental, top) {
  const statementScore = Math.min(100, toNumber_(f.monthsCovered) / 6 * 100);
  const sampleScore = Math.min(100, toNumber_(top.similarCases) / 8 * 100);
  const score = Math.round(toNumber_(fundamental.dataQualityScore) * 0.55 + statementScore * 0.35 + sampleScore * 0.10);
  return {
    score: score,
    grade: score >= 85 ? 'High' : score >= 65 ? 'Moderate' : 'Low',
    basis: [f.monthsCovered + ' months of statements', toNumber_(fundamental.dataQualityScore) + '/100 data quality', toNumber_(top.similarCases) + ' comparable historical cases']
  };
}

function buildDebtServiceRecommendation_(decision, primary, cashFlow, businessHealth, hardStops, scenarios) {
  if (hardStops.blocking.length) return 'Do not issue an automated Proposed Funding Offer. Resolve the hard-stop items and complete manual underwriting.';
  return decision + '. Proven historical potential: ' + scenarios.priorEngine12MonthAnchor + '. Business Health: ' + businessHealth.score + '/100. Comfortable monthly repayment capacity: ' + cashFlow.conservativeFreeCashFlow + ' (' + cashFlow.depositPaymentShare + '% of deposits). Proposed ' + primary.termMonths + '-month principal: ' + primary.recommendedAmount + ', total repayment: ' + primary.totalRepayment + ', and payment coverage: ' + primary.coverageAtRecommended + 'x.';
}

function saveInstitutionalAssessment_(base, i) {
  ensureSheetSchema_('Institutional Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Business Health','Debt Service Score',
    'Comfortable Payment Capacity','Maximum Monthly Payment','6 Month Proposed Amount','9 Month Proposed Amount','12 Month Proposed Amount',
    '6 Month Total Repayment','9 Month Total Repayment','12 Month Total Repayment',
    '6 Month Stress Amount','9 Month Stress Amount','12 Month Stress Amount','Historical Potential Amount','Selected Proposed Amount',
    'Selected Term','Selected Total Repayment','Selected Payment','Selected Coverage','Confidence','Decision','Positive Reason Codes',
    'Negative Reason Codes','Hard Stops','Required Conditions','Underwriter Recommendation','Created At'
  ]);
  appendRow_('Institutional Assessments', [
    base.assessmentId,VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,base.companyName,base.period,
    i.businessHealth.score,i.debtServiceCapacity.score,i.cashFlowAnalysis.conservativeFreeCashFlow,
    i.debtServiceCapacity.maximumSupportableMonthlyPayment,
    i.termScenarios.byTerm['6'].recommendedAmount,i.termScenarios.byTerm['9'].recommendedAmount,i.termScenarios.byTerm['12'].recommendedAmount,
    i.termScenarios.byTerm['6'].totalRepayment,i.termScenarios.byTerm['9'].totalRepayment,i.termScenarios.byTerm['12'].totalRepayment,
    i.termScenarios.byTerm['6'].stressTestedAmount,i.termScenarios.byTerm['9'].stressTestedAmount,i.termScenarios.byTerm['12'].stressTestedAmount,
    i.termScenarios.priorEngine12MonthAnchor,i.proposedFundingOffer.recommendedAmount,i.proposedFundingOffer.selectedTermMonths,i.proposedFundingOffer.totalRepayment,
    i.proposedFundingOffer.estimatedMonthlyPayment,i.proposedFundingOffer.coverageRatio,
    i.confidence.score,i.proposedFundingOffer.decision,cleanCell_(i.positiveReasonCodes),
    cleanCell_(i.negativeReasonCodes),cleanCell_(i.hardStops.blocking),cleanCell_(i.requiredConditions),
    i.underwriterRecommendation,new Date()
  ]);
}