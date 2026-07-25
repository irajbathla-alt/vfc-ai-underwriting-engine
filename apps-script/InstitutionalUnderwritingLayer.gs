const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-INSTITUTIONAL-3.3-CALIBRATED-OFFER',
  FACTOR_RATE: 1.25,
  TARGET_COVERAGE: 1.35,
  STRETCH_COVERAGE: 1.20,
  STRESS_DECLINE: 0.10,
  BASE_DEPOSIT_PAYMENT_SHARE: 0.12,
  MIN_DEPOSIT_PAYMENT_SHARE: 0.07,
  MAX_DEPOSIT_PAYMENT_SHARE: 0.15,
  TERMS: [6, 9, 12]
};

function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  const institutional = buildInstitutionalAssessment_(base);
  saveInstitutionalAssessment_(base, institutional);
  base.institutionalAssessment = institutional;
  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. The Proposed Funding Offer is calibrated to the existing proven underwriting recommendation and independently tested against business-bank-statement deposit capacity. Existing lender analysis remains separate and unchanged.';
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
  const scenarios = calculateDebtServiceScenarios_(cashFlow, capacity, hardStops);
  const businessHealth = calculateBusinessHealth_(f, fundamental, cashFlow);
  const confidence = calculateInstitutionalConfidence_(f, fundamental, top);
  const reasons = buildDebtServiceReasonCodes_(f, fundamental, cashFlow, scenarios, hardStops);

  const primary = scenarios.byTerm['12'] || scenarios.byTerm['9'] || scenarios.byTerm['6'];
  const recommendation = hardStops.blocking.length
    ? 'Manual review required'
    : primary.coverageAtRecommended >= VFC_INSTITUTIONAL_CONFIG.TARGET_COVERAGE
      ? 'Strong proposed funding offer'
      : primary.coverageAtRecommended >= VFC_INSTITUTIONAL_CONFIG.STRETCH_COVERAGE
        ? 'Proposed offer available with conditions'
        : 'Caution — reduce proposed exposure';

  const proposedFundingOffer = {
    label: 'Proposed Funding Offer',
    recommendedAmount: primary.recommendedAmount,
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
    underwriterRecommendation: buildDebtServiceRecommendation_(recommendation, primary, cashFlow, businessHealth, hardStops),
    methodologyNote: 'The prior proven proposal remains the 12-month calibration anchor. Six- and nine-month offers are term-adjusted, and every offer is tested against a risk-adjusted percentage of verified monthly deposits. Total repayment includes principal plus the 1.25 factor-rate financing cost.'
  };
}

function calculateDebtServiceCashFlow_(f, fundamental) {
  const deposits = Math.max(0, toNumber_(f.averageMonthlyDeposits));
  const withdrawals = Math.max(0, toNumber_(f.averageMonthlyWithdrawals || (f.totalWithdrawals && f.monthsCovered ? f.totalWithdrawals / f.monthsCovered : 0)));
  const monthlyDeposits = (f.monthlyDeposits || []).filter(function(n) { return toNumber_(n) > 0; }).map(toNumber_);
  const recentDeposits = average_(monthlyDeposits.slice(-3)) || deposits;
  const weakestDeposits = monthlyDeposits.length ? Math.min.apply(null, monthlyDeposits) : deposits;

  let paymentShare = VFC_INSTITUTIONAL_CONFIG.BASE_DEPOSIT_PAYMENT_SHARE;
  if (toNumber_(f.depositVolatility) <= 0.20) paymentShare += 0.01;
  if (toNumber_(f.depositTrend) >= 0.05) paymentShare += 0.01;
  if (toNumber_(f.nsfPerMonth) > 0) paymentShare -= Math.min(0.025, toNumber_(f.nsfPerMonth) * 0.0075);
  if (f.negativeBalanceFlag) paymentShare -= 0.015;
  if (f.mcaPaymentFlag) paymentShare -= 0.015;
  if (f.suspectedStacking) paymentShare -= 0.025;
  if (toNumber_(fundamental.dataQualityScore) < 60) paymentShare -= 0.01;
  paymentShare = clamp_(paymentShare, VFC_INSTITUTIONAL_CONFIG.MIN_DEPOSIT_PAYMENT_SHARE, VFC_INSTITUTIONAL_CONFIG.MAX_DEPOSIT_PAYMENT_SHARE);

  const averagePaymentCapacity = deposits * paymentShare;
  const recentPaymentCapacity = recentDeposits * paymentShare;
  const weakestPaymentCapacity = weakestDeposits * paymentShare;
  const conservativePaymentCapacity = round2_(Math.min(averagePaymentCapacity, recentPaymentCapacity, weakestPaymentCapacity));
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

function calculateDebtServiceScenarios_(cashFlow, capacity, hardStops) {
  const originalEngineAmount = Math.max(0, toNumber_(capacity.recommendedAmount));
  const targetPayment = hardStops.blocking.length ? 0 : cashFlow.conservativeFreeCashFlow / VFC_INSTITUTIONAL_CONFIG.TARGET_COVERAGE;
  const stretchPayment = hardStops.blocking.length ? 0 : cashFlow.conservativeFreeCashFlow / VFC_INSTITUTIONAL_CONFIG.STRETCH_COVERAGE;
  const stressPayment = hardStops.blocking.length ? 0 : cashFlow.stressedFreeCashFlow / VFC_INSTITUTIONAL_CONFIG.TARGET_COVERAGE;
  const depositBased12MonthAmount = roundToNearest_((targetPayment * 12) / VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING);
  const calibrated12MonthAmount = hardStops.blocking.length ? 0 : Math.max(originalEngineAmount, depositBased12MonthAmount);
  const byTerm = {};

  VFC_INSTITUTIONAL_CONFIG.TERMS.forEach(function(term) {
    const termRatio = term / 12;
    const recommendedAmount = Math.max(0, roundToNearest_(calibrated12MonthAmount * termRatio, VFC_POWER_CONFIG.ROUNDING));
    const depositSupportableAmount = Math.max(0, roundToNearest_((targetPayment * term) / VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING));
    const stretchAmount = Math.max(recommendedAmount, roundToNearest_((stretchPayment * term) / VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING));
    const stressAmount = Math.max(0, roundToNearest_((stressPayment * term) / VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE, VFC_POWER_CONFIG.ROUNDING));
    const totalRepayment = round2_(recommendedAmount * VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE);
    const financingCost = round2_(totalRepayment - recommendedAmount);
    const estimatedMonthlyPayment = recommendedAmount > 0 ? round2_(totalRepayment / term) : 0;
    const coverage = estimatedMonthlyPayment > 0 ? round2_(cashFlow.conservativeFreeCashFlow / estimatedMonthlyPayment) : 0;
    const stressCoverage = estimatedMonthlyPayment > 0 ? round2_(cashFlow.stressedFreeCashFlow / estimatedMonthlyPayment) : 0;

    byTerm[String(term)] = {
      termMonths: term,
      factorRate: VFC_INSTITUTIONAL_CONFIG.FACTOR_RATE,
      recommendedAmount: recommendedAmount,
      baseSupportableAmount: depositSupportableAmount,
      priorEngineAnchor: roundToNearest_(originalEngineAmount * termRatio, VFC_POWER_CONFIG.ROUNDING),
      stretchAmount: stretchAmount,
      stressTestedAmount: stressAmount,
      totalRepayment: totalRepayment,
      financingCost: financingCost,
      estimatedMonthlyPayment: estimatedMonthlyPayment,
      estimatedWeeklyPayment: round2_(estimatedMonthlyPayment * 12 / 52),
      estimatedBusinessDailyPayment: round2_(estimatedMonthlyPayment * 12 / 260),
      coverageAtRecommended: coverage,
      stressCoverageAtRecommended: stressCoverage,
      decision: coverage >= 1.35 && stressCoverage >= 1.15 ? 'Supportable' : coverage >= 1.20 ? 'Caution' : 'Review amount'
    };
  });

  const capacityScore = clamp_(Math.round((cashFlow.depositPaymentShare / VFC_INSTITUTIONAL_CONFIG.MAX_DEPOSIT_PAYMENT_SHARE) * 70 + Math.min(100, cashFlow.monthsAnalyzed / 6 * 100) * 0.30), 0, 100);
  const conditions = [];
  if (cashFlow.monthsAnalyzed < 6) conditions.push('Obtain six complete months of business bank statements for final sizing.');
  if (byTerm['12'].coverageAtRecommended < 1.20) conditions.push('The prior engine anchor exceeds the current risk-adjusted deposit payment test; review existing obligations before funding.');

  return {
    maximumSupportableMonthlyPayment: round2_(targetPayment),
    stretchMonthlyPayment: round2_(stretchPayment),
    stressTestedMonthlyPayment: round2_(stressPayment),
    priorEngine12MonthAnchor: originalEngineAmount,
    depositBased12MonthAmount: depositBased12MonthAmount,
    calibrated12MonthAmount: calibrated12MonthAmount,
    capacityScore: capacityScore,
    capacityGrade: capacityScore >= 80 ? 'Strong' : capacityScore >= 65 ? 'Acceptable' : capacityScore >= 50 ? 'Caution' : 'Weak',
    byTerm: byTerm,
    conditions: conditions
  };
}

function calculateBusinessHealth_(f, fundamental, cashFlow) {
  const depositStrength = clamp_(Math.round(toNumber_(fundamental.cashFlowScore)), 0, 100);
  const capacityRatio = cashFlow.averageMonthlyDeposits > 0 ? cashFlow.conservativeFreeCashFlow / cashFlow.averageMonthlyDeposits : 0;
  const capacityScore = capacityRatio >= 0.13 ? 95 : capacityRatio >= 0.11 ? 82 : capacityRatio >= 0.09 ? 68 : capacityRatio >= 0.07 ? 50 : 30;
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
  if (cashFlow.conservativeFreeCashFlow > 0) positive.push('DS01 Positive deposit-based payment capacity');
  if (scenarios.priorEngine12MonthAnchor > 0) positive.push('DS02 Prior proven proposal used as calibration anchor');
  if (f.depositTrend <= -0.08) negative.push('BH06 Declining deposit trend');
  if (f.depositVolatility >= 0.45) negative.push('BH07 High deposit volatility');
  if (f.nsfPerMonth > 0) negative.push('BK04 NSF activity detected');
  if (f.negativeBalanceFlag) negative.push('BK05 Negative balances detected');
  if (f.mcaPaymentFlag) negative.push('DB03 Existing financing payments detected');
  if (f.suspectedStacking) negative.push('DB05 Possible stacking');
  if (scenarios.byTerm['12'].coverageAtRecommended < 1.20) negative.push('DS06 Proposed payment requires manual review');
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

function buildDebtServiceRecommendation_(decision, primary, cashFlow, businessHealth, hardStops) {
  if (hardStops.blocking.length) return 'Do not issue an automated Proposed Funding Offer. Resolve the hard-stop items and complete manual underwriting.';
  return decision + '. Business Health: ' + businessHealth.score + '/100. Risk-adjusted deposit payment capacity: ' + cashFlow.conservativeFreeCashFlow + ' per month (' + cashFlow.depositPaymentShare + '% of deposits). Proposed ' + primary.termMonths + '-month principal: ' + primary.recommendedAmount + ', total repayment: ' + primary.totalRepayment + ', and payment coverage: ' + primary.coverageAtRecommended + 'x.';
}

function saveInstitutionalAssessment_(base, i) {
  ensureSheetSchema_('Institutional Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Business Health','Debt Service Score',
    'Conservative Free Cash Flow','Maximum Monthly Payment','6 Month Proposed Amount','9 Month Proposed Amount','12 Month Proposed Amount',
    '6 Month Total Repayment','9 Month Total Repayment','12 Month Total Repayment',
    '6 Month Stress Amount','9 Month Stress Amount','12 Month Stress Amount','Selected Proposed Amount',
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
    i.proposedFundingOffer.recommendedAmount,i.proposedFundingOffer.selectedTermMonths,i.proposedFundingOffer.totalRepayment,
    i.proposedFundingOffer.estimatedMonthlyPayment,i.proposedFundingOffer.coverageRatio,
    i.confidence.score,i.proposedFundingOffer.decision,cleanCell_(i.positiveReasonCodes),
    cleanCell_(i.negativeReasonCodes),cleanCell_(i.hardStops.blocking),cleanCell_(i.requiredConditions),
    i.underwriterRecommendation,new Date()
  ]);
}