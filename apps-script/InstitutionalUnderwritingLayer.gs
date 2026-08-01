const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-ORIGINAL-MAX-5.2-RETURN-FIRST'
};

/**
 * Display-safe underwriting entry point.
 *
 * This calculates the original VFC recommendation directly from the uploaded
 * summaries and historical outcomes. It deliberately does not write to Hybrid
 * Assessments, Risk Scorecards, Institutional Assessments or AI Pattern Models
 * before returning the result to the browser.
 */
function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const companyName = request.companyName;
  const period = resolveLatestAssessmentPeriod_(companyName, request.period);

  setupVFC();

  const current = buildPowerFeatures_(companyName, period);
  if (!current || !current.statementCount) {
    throw new Error('No bank-statement summaries were found for this company and period.');
  }

  const outcomes = collectHistoricalOutcomes_().filter(function(row) {
    return !(sameText_(row.companyName, companyName) && sameText_(row.period, period));
  });
  if (!outcomes.length) {
    throw new Error('No historical lender outcomes are available. Add approvals and declines in Training Data first.');
  }

  const fundamental = calculateFundamentalScore_(current);
  const aiReview = createExpertReview_(current, fundamental);
  const lenders = unique_(outcomes.map(function(row) {
    return row.lenderName;
  }).filter(Boolean));

  const rankings = lenders.map(function(lender) {
    return scorePowerLender_(lender, current, outcomes, fundamental, aiReview);
  }).sort(function(a, b) {
    return b.compositeScore - a.compositeScore;
  });

  const capacity = calculateExactLendingCapacity_(current, fundamental, aiReview, rankings);
  const decision = buildPowerDecision_(current, fundamental, aiReview, rankings, capacity);
  const assessmentId = Utilities.getUuid();
  const top = rankings[0] || {};

  const maximumLoanAmount = firstAssessmentAmount_(
    capacity.recommendedAmount,
    decision.recommended_amount,
    capacity.stretchAmount
  );

  capacity.recommendedAmount = maximumLoanAmount;
  capacity.stretchAmount = maximumLoanAmount;

  const response = {
    ok: true,
    assessmentId: assessmentId,
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    activeProductionModel: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    currentFeatures: current,
    fundamentalScorecard: fundamental,
    expertReview: aiReview,
    lendingCapacity: capacity,
    lenderRankings: rankings,
    underwritingSummary: decision,
    institutionalAssessment: {
      modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
      maximumLoanAmount: maximumLoanAmount,
      originalModelAmount: maximumLoanAmount,
      amountConfidence: capacity.confidence || confidenceLabel_(capacity.confidenceScore),
      amountConfidenceScore: toNumber_(capacity.confidenceScore),
      businessHealthScore: toNumber_(fundamental.score),
      riskGrade: fundamental.grade || '',
      averageMonthlyDeposits: toNumber_(current.averageMonthlyDeposits),
      historicalAnchor: toNumber_(capacity.historicalAnchor),
      cashFlowCapacity: toNumber_(capacity.cashFlowCapacity),
      revenueCapacity: toNumber_(capacity.revenueCapacity),
      strongestLender: top.lenderName || '',
      lenderFitScore: toNumber_(top.compositeScore),
      calculationNotes: Array.isArray(capacity.calculationNotes) ? capacity.calculationNotes : [],
      strengths: Array.isArray(fundamental.strengths) ? fundamental.strengths : [],
      risks: Array.isArray(fundamental.risks) ? fundamental.risks : [],
      decision: maximumLoanAmount > 0 ? 'Maximum recommended loan' : 'No automated loan amount recommended',
      methodologyNote: 'The displayed maximum is calculated directly by the original VFC hybrid underwriting logic. The result is returned before any assessment-history logging, pattern learning or secondary recalibration.'
    },
    disclaimer: 'VFC internal decision support only. This recommendation is not a lender approval or guarantee.'
  };

  return JSON.parse(JSON.stringify(response));
}

function firstAssessmentAmount_() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i];
    if (value === null || value === undefined || value === '') continue;
    const amount = toNumber_(value);
    if (isFinite(amount) && amount >= 0) return amount;
  }
  return 0;
}

function confidenceLabel_(scoreValue) {
  const score = toNumber_(scoreValue);
  return score >= 80 ? 'High' : score >= 60 ? 'Moderate' : 'Low';
}

function getProductionModelStatus() {
  return {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    calculationSource: 'Original VFC hybrid underwriting functions',
    resultReturnedBeforeAuditLogging: true,
    assessmentHistoryWriteActive: false,
    secondaryRecalibrationActive: false,
    patternLearningAffectsLiveAmount: false
  };
}
