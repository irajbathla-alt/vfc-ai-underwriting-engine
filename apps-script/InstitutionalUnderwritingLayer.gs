const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-ORIGINAL-MAX-5.0-LOCKED',
  ROUNDING: 500
};

/**
 * Production underwriting entry point.
 *
 * The live maximum is intentionally locked to the original VFC hybrid engine.
 * No pattern-learning, repayment-term, or secondary recalibration layer is
 * permitted to increase or reduce the production recommendation.
 */
function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  const capacity = base.lendingCapacity || {};
  const fundamental = base.fundamentalScorecard || {};
  const features = base.currentFeatures || {};
  const rankings = base.lenderRankings || [];
  const ai = base.expertReview || {};
  const top = rankings[0] || {};

  // This is the recommendation produced by the original VFC underwriting engine.
  const originalAmount = Math.max(0, toNumber_(capacity.recommendedAmount));
  const originalStretch = Math.max(originalAmount, toNumber_(capacity.stretchAmount));
  const historicalAnchor = Math.max(0, toNumber_(capacity.historicalAnchor));

  // Retained only as an observational comparison. It cannot change the live amount.
  const historicalShadow = calculateHistoricalShadow_(
    originalAmount,
    historicalAnchor,
    features,
    fundamental,
    ai,
    top
  );

  const liveAmount = originalAmount;
  const confidenceScore = Math.max(
    0,
    toNumber_(capacity.confidenceScore || historicalShadow.confidenceScore)
  );
  const confidence = capacity.confidence ||
    (confidenceScore >= 80 ? 'High' : confidenceScore >= 60 ? 'Moderate' : 'Low');

  // Explicitly overwrite every public amount field so no downstream layer can
  // accidentally display a recalibrated or learned amount.
  base.lendingCapacity.originalRecommendedAmount = originalAmount;
  base.lendingCapacity.recommendedAmount = liveAmount;
  base.lendingCapacity.stretchAmount = liveAmount;
  base.lendingCapacity.originalStretchAmount = originalStretch;
  base.lendingCapacity.historicalRecalibrationShadow = historicalShadow;
  delete base.lendingCapacity.patternLearning;
  delete base.lendingCapacity.patternShadowComparison;

  if (base.underwritingSummary) {
    base.underwritingSummary.recommended_amount = liveAmount;
    base.underwritingSummary.stretch_amount = liveAmount;
    base.underwritingSummary.explanation =
      'The maximum recommended loan is produced directly by the original VFC hybrid underwriting engine. ' +
      'No pattern-learning or secondary recalibration adjustment was applied.';
  }

  base.institutionalAssessment = {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    maximumLoanAmount: liveAmount,
    originalModelAmount: originalAmount,
    originalStretchAmount: originalStretch,
    historicalExpectedAmount: historicalShadow.historicalExpectedAmount,
    historicalShadowAmount: historicalShadow.maximumLoanAmount,
    historicalShadowDifference: roundToNearest_(
      historicalShadow.maximumLoanAmount - liveAmount,
      VFC_INSTITUTIONAL_CONFIG.ROUNDING
    ),
    currentBankingAmount: historicalShadow.currentBankingAmount,
    learnedPatternAmount: 0,
    patternActive: false,
    patternShadowMode: false,
    patternConfidence: 'Disabled in production',
    patternConfidenceScore: 0,
    comparablePatternCases: 0,
    amountConfidence: confidence,
    amountConfidenceScore: confidenceScore,
    businessHealthScore: toNumber_(fundamental.score),
    riskGrade: fundamental.grade || '',
    averageMonthlyDeposits: toNumber_(features.averageMonthlyDeposits),
    historicalAnchor: historicalAnchor,
    cashFlowCapacity: toNumber_(capacity.cashFlowCapacity),
    revenueCapacity: toNumber_(capacity.revenueCapacity),
    strongestLender: top.lenderName || '',
    lenderFitScore: toNumber_(top.compositeScore),
    closestHistoricalApprovals: buildHistoricalApprovalEvidence_(rankings),
    calculationNotes: [
      'LIVE production amount: ' + roundToNearest_(liveAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Source: original VFC hybrid underwriting engine.',
      'Original stretch amount retained for audit only: ' + roundToNearest_(originalStretch, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Historical recalibration shadow amount (not used): ' + historicalShadow.maximumLoanAmount,
      'AI pattern learning is disconnected from the live assessment path.'
    ],
    strengths: fundamental.strengths || [],
    risks: fundamental.risks || [],
    decision: liveAmount > 0 ? 'Maximum recommended loan' : 'No automated loan amount recommended',
    methodologyNote:
      'Production model ' + VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION +
      ': the displayed maximum loan comes directly from the original VFC hybrid underwriting engine. ' +
      'No repayment-term sizing, historical recalibration overlay, or AI pattern-learning adjustment is applied.'
  };

  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.activeProductionModel = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer =
    'VFC internal decision support only. The displayed amount is the original-engine maximum recommendation and is not a lender approval or guarantee.';

  saveOriginalMaximumAssessment_(base);
  return base;
}

/**
 * Observational comparison only. Never use its amount as the production result.
 */
function calculateHistoricalShadow_(originalAmount, historicalAnchor, features, fundamental, ai, top) {
  const deposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const fundamentalScore = toNumber_(fundamental.score);
  const aiScore = toNumber_(ai.risk_score || fundamentalScore);
  const historicalExpected = historicalAnchor > 0 ? historicalAnchor : originalAmount;
  const currentBankingAmount = deposits * (
    fundamentalScore >= 82 ? 1.05 :
    fundamentalScore >= 70 ? 0.95 :
    fundamentalScore >= 58 ? 0.80 :
    fundamentalScore >= 45 ? 0.62 : 0.40
  );
  const aiAmount = historicalExpected * clamp_(aiScore / 75, 0.80, 1.10);

  let blended = historicalExpected * 0.70 + currentBankingAmount * 0.20 + aiAmount * 0.10;
  let riskFactor = 1;

  if (toNumber_(features.nsfPerMonth) > 2) riskFactor -= 0.10;
  if (features.suspectedStacking) riskFactor -= 0.12;
  if (features.negativeBalanceFlag && features.overdraftFlag) riskFactor -= 0.08;
  if (toNumber_(features.depositTrend) < -0.20) riskFactor -= 0.10;
  if (toNumber_(features.depositVolatility) > 0.65) riskFactor -= 0.07;
  if (toNumber_(fundamental.dataQualityScore) < 50) riskFactor -= 0.08;

  riskFactor = clamp_(riskFactor, 0.65, 1.05);
  blended *= riskFactor;

  const marketCap = deposits > 0
    ? deposits * (fundamentalScore >= 70 ? 1.25 : fundamentalScore >= 58 ? 1.05 : 0.85)
    : blended;
  if (marketCap > 0) {
    blended = Math.min(blended, Math.max(marketCap, historicalExpected * 0.92));
  }

  let shadowAmount = roundToNearest_(Math.max(0, blended), VFC_INSTITUTIONAL_CONFIG.ROUNDING);
  if (fundamentalScore < 40 || !deposits) shadowAmount = 0;

  const confidenceScore = clamp_(Math.round(
    Math.min(100, toNumber_(top.similarCases) / 8 * 100) * 0.35 +
    Math.min(100, toNumber_(top.similarApprovals) / 6 * 100) * 0.30 +
    toNumber_(fundamental.dataQualityScore) * 0.20 +
    Math.min(100, toNumber_(features.monthsCovered) / 6 * 100) * 0.15
  ), 0, 100);

  return {
    maximumLoanAmount: shadowAmount,
    historicalExpectedAmount: roundToNearest_(historicalExpected, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    currentBankingAmount: roundToNearest_(currentBankingAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    confidenceScore: confidenceScore,
    riskFactor: round2_(riskFactor)
  };
}

function buildHistoricalApprovalEvidence_(rankings) {
  return (rankings || []).filter(function(r) {
    return toNumber_(r.medianApprovedAmount) > 0;
  }).slice(0, 5).map(function(r) {
    return {
      lenderName: r.lenderName || '',
      similarityScore: toNumber_(r.compositeScore),
      similarApprovals: toNumber_(r.similarApprovals),
      similarCases: toNumber_(r.similarCases),
      approvalRate: r.observedApprovalRate || '',
      lowApprovedAmount: toNumber_(r.lowApprovedAmount),
      medianApprovedAmount: toNumber_(r.medianApprovedAmount),
      highApprovedAmount: toNumber_(r.highApprovedAmount)
    };
  });
}

function saveOriginalMaximumAssessment_(base) {
  const i = base.institutionalAssessment || {};
  ensureSheetSchema_('Institutional Assessments', [
    'Assessment ID','Model Version','Company Name','Period','Maximum Loan Amount','Original Model Amount',
    'Historical Expected Amount','Current Banking Amount','Learned Pattern Amount','Pattern Active',
    'Pattern Confidence','Pattern Confidence Score','Comparable Pattern Cases','Business Health Score',
    'Risk Grade','Average Monthly Deposits','Historical Anchor','Amount Confidence','Amount Confidence Score',
    'Strongest Lender','Lender Fit Score','Calculation Notes','Created At'
  ]);
  appendRow_('Institutional Assessments', [
    base.assessmentId,i.modelVersion,base.companyName,base.period,i.maximumLoanAmount,i.originalModelAmount,
    i.historicalExpectedAmount,i.currentBankingAmount,0,false,
    'Disabled in production',0,0,i.businessHealthScore,
    i.riskGrade,i.averageMonthlyDeposits,i.historicalAnchor,i.amountConfidence,i.amountConfidenceScore,
    i.strongestLender,i.lenderFitScore,cleanCell_(i.calculationNotes),new Date()
  ]);
}

function getProductionModelStatus() {
  return {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    liveAmountSource: 'Original VFC hybrid underwriting engine',
    historicalRecalibrationAffectsLiveAmount: false,
    patternLearningAffectsLiveAmount: false,
    repaymentTermSizingActive: false
  };
}
