const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-ORIGINAL-MAX-5.1-DISPLAY-SAFE'
};

/**
 * Public assessment entry point used by the web app.
 *
 * Important: this function performs no secondary model training, no shadow
 * calculation and no additional Sheet write before returning the result.
 * The original VFC engine calculates the recommendation and the response is
 * immediately converted to a client-safe plain object for display.
 */
function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  if (!base || typeof base !== 'object') {
    throw new Error('The original underwriting engine returned an empty result.');
  }

  const capacity = base.lendingCapacity || {};
  const fundamental = base.fundamentalScorecard || {};
  const features = base.currentFeatures || {};
  const rankings = Array.isArray(base.lenderRankings) ? base.lenderRankings : [];
  const summary = base.underwritingSummary || {};
  const top = rankings[0] || {};

  const maximumLoanAmount = firstAssessmentAmount_(
    capacity.recommendedAmount,
    summary.recommended_amount,
    capacity.stretchAmount
  );

  if (!base.lendingCapacity) base.lendingCapacity = {};
  base.lendingCapacity.recommendedAmount = maximumLoanAmount;
  base.lendingCapacity.stretchAmount = maximumLoanAmount;

  base.institutionalAssessment = {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    maximumLoanAmount: maximumLoanAmount,
    originalModelAmount: maximumLoanAmount,
    amountConfidence: capacity.confidence || confidenceLabel_(capacity.confidenceScore),
    amountConfidenceScore: toNumber_(capacity.confidenceScore),
    businessHealthScore: toNumber_(fundamental.score),
    riskGrade: fundamental.grade || '',
    averageMonthlyDeposits: toNumber_(features.averageMonthlyDeposits),
    historicalAnchor: toNumber_(capacity.historicalAnchor),
    cashFlowCapacity: toNumber_(capacity.cashFlowCapacity),
    revenueCapacity: toNumber_(capacity.revenueCapacity),
    strongestLender: top.lenderName || '',
    lenderFitScore: toNumber_(top.compositeScore),
    calculationNotes: Array.isArray(capacity.calculationNotes) ? capacity.calculationNotes : [],
    strengths: Array.isArray(fundamental.strengths) ? fundamental.strengths : [],
    risks: Array.isArray(fundamental.risks) ? fundamental.risks : [],
    decision: maximumLoanAmount > 0 ? 'Maximum recommended loan' : 'No automated loan amount recommended',
    methodologyNote: 'The displayed amount comes directly from the original VFC hybrid underwriting engine. No term sizing, pattern learning or secondary recalibration changes this result.'
  };

  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.activeProductionModel = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. This recommendation is not a lender approval or guarantee.';

  // google.script.run only receives a plain JSON-safe object. This removes
  // undefined values and any non-serializable values that could block display.
  return JSON.parse(JSON.stringify(base));
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
    liveAmountSource: 'Original VFC hybrid underwriting engine',
    secondaryRecalibrationActive: false,
    patternLearningAffectsLiveAmount: false,
    additionalAssessmentSheetWriteBeforeDisplay: false
  };
}
