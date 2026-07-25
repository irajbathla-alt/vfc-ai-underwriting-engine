const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-HISTORICAL-MAX-4.2',
  HISTORICAL_WEIGHT: 0.70,
  CURRENT_BANKING_WEIGHT: 0.20,
  AI_WEIGHT: 0.10,
  ROUNDING: 500
};

function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const base = generatePowerAssessmentSafe(companyOrRequest, requestedPeriod);
  const capacity = base.lendingCapacity || {};
  const fundamental = base.fundamentalScorecard || {};
  const features = base.currentFeatures || {};
  const rankings = base.lenderRankings || [];
  const ai = base.expertReview || {};
  const top = rankings[0] || {};

  const originalAmount = Math.max(0, toNumber_(capacity.recommendedAmount));
  const historicalAnchor = Math.max(0, toNumber_(capacity.historicalAnchor));
  const historicalCases = buildHistoricalApprovalEvidence_(rankings);
  const recalibrated = calculateHistoricalMaximum_(
    originalAmount,
    historicalAnchor,
    features,
    fundamental,
    ai,
    top
  );

  base.lendingCapacity.originalRecommendedAmount = originalAmount;
  base.lendingCapacity.recommendedAmount = recalibrated.maximumLoanAmount;
  base.lendingCapacity.stretchAmount = recalibrated.maximumLoanAmount;
  base.lendingCapacity.historicalRecalibration = recalibrated;

  if (base.underwritingSummary) {
    base.underwritingSummary.recommended_amount = recalibrated.maximumLoanAmount;
    base.underwritingSummary.stretch_amount = recalibrated.maximumLoanAmount;
    base.underwritingSummary.explanation = (base.underwritingSummary.explanation || '') +
      ' Historical recalibration produced a maximum recommended loan of ' + recalibrated.maximumLoanAmount + '.';
  }

  base.institutionalAssessment = {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    maximumLoanAmount: recalibrated.maximumLoanAmount,
    originalModelAmount: originalAmount,
    historicalExpectedAmount: recalibrated.historicalExpectedAmount,
    historicalExpectedLow: recalibrated.historicalExpectedLow,
    historicalExpectedHigh: recalibrated.historicalExpectedHigh,
    currentBankingAmount: recalibrated.currentBankingAmount,
    historicalWeight: 70,
    currentBankingWeight: 20,
    aiWeight: 10,
    amountConfidence: recalibrated.confidence,
    amountConfidenceScore: recalibrated.confidenceScore,
    businessHealthScore: toNumber_(fundamental.score),
    riskGrade: fundamental.grade || '',
    averageMonthlyDeposits: toNumber_(features.averageMonthlyDeposits),
    historicalAnchor: historicalAnchor,
    cashFlowCapacity: toNumber_(capacity.cashFlowCapacity),
    revenueCapacity: toNumber_(capacity.revenueCapacity),
    strongestLender: top.lenderName || '',
    lenderFitScore: toNumber_(top.compositeScore),
    closestHistoricalApprovals: historicalCases,
    calculationNotes: recalibrated.calculationNotes,
    strengths: fundamental.strengths || [],
    risks: fundamental.risks || [],
    decision: recalibrated.maximumLoanAmount > 0 ? 'Maximum historically supported loan recommendation' : 'No automated loan amount recommended',
    methodologyNote: 'Historical approvals drive 70% of the amount, current banking risk drives 20%, and AI review drives 10%. The recommendation represents the maximum loan that reasonably fits the business profile and available historical evidence. No repayment-term assumption or term-based sizing adjustment is applied.'
  };

  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. This maximum loan recommendation is based on uploaded bank statements and recorded historical lender outcomes. It is not a lender approval or guarantee.';
  saveOriginalMaximumAssessment_(base);
  return base;
}

function calculateHistoricalMaximum_(originalAmount, historicalAnchor, features, fundamental, ai, top) {
  const deposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const fundamentalScore = toNumber_(fundamental.score);
  const aiScore = toNumber_(ai.risk_score || fundamentalScore);
  const lenderFit = toNumber_(top.compositeScore);

  const historicalExpected = historicalAnchor > 0 ? historicalAnchor : originalAmount;
  const currentBankingAmount = deposits * (
    fundamentalScore >= 82 ? 1.05 :
    fundamentalScore >= 70 ? 0.95 :
    fundamentalScore >= 58 ? 0.80 :
    fundamentalScore >= 45 ? 0.62 : 0.40
  );
  const aiAmount = historicalExpected * clamp_(aiScore / 75, 0.80, 1.10);

  let blended = historicalExpected * VFC_INSTITUTIONAL_CONFIG.HISTORICAL_WEIGHT +
    currentBankingAmount * VFC_INSTITUTIONAL_CONFIG.CURRENT_BANKING_WEIGHT +
    aiAmount * VFC_INSTITUTIONAL_CONFIG.AI_WEIGHT;

  let materialRiskFactor = 1;
  const materialRisks = [];
  if (toNumber_(features.nsfPerMonth) > 2) { materialRiskFactor -= 0.10; materialRisks.push('more than two NSF events per month'); }
  if (features.suspectedStacking) { materialRiskFactor -= 0.12; materialRisks.push('possible stacking'); }
  if (features.negativeBalanceFlag && features.overdraftFlag) { materialRiskFactor -= 0.08; materialRisks.push('repeated negative-balance or overdraft conduct'); }
  if (toNumber_(features.depositTrend) < -0.20) { materialRiskFactor -= 0.10; materialRisks.push('material deposit decline'); }
  if (toNumber_(features.depositVolatility) > 0.65) { materialRiskFactor -= 0.07; materialRisks.push('extreme deposit volatility'); }
  if (toNumber_(fundamental.dataQualityScore) < 50) { materialRiskFactor -= 0.08; materialRisks.push('low data quality'); }
  materialRiskFactor = clamp_(materialRiskFactor, 0.65, 1.05);
  blended *= materialRiskFactor;

  const noMaterialDeterioration = materialRiskFactor >= 0.98 && fundamentalScore >= 50;
  if (noMaterialDeterioration && historicalExpected > 0) {
    blended = Math.max(blended, historicalExpected * 0.92);
  }
  if (noMaterialDeterioration) {
    blended = Math.max(blended, originalAmount);
  }

  const marketCap = deposits > 0 ? deposits * (fundamentalScore >= 70 ? 1.25 : fundamentalScore >= 58 ? 1.05 : 0.85) : blended;
  if (marketCap > 0) blended = Math.min(blended, Math.max(marketCap, historicalExpected * 0.92));

  let maximumLoanAmount = roundToNearest_(Math.max(0, blended), VFC_INSTITUTIONAL_CONFIG.ROUNDING);
  if (fundamentalScore < 40 || !deposits) maximumLoanAmount = 0;

  const confidenceScore = clamp_(Math.round(
    Math.min(100, toNumber_(top.similarCases) / 8 * 100) * 0.35 +
    Math.min(100, toNumber_(top.similarApprovals) / 6 * 100) * 0.30 +
    toNumber_(fundamental.dataQualityScore) * 0.20 +
    Math.min(100, toNumber_(features.monthsCovered) / 6 * 100) * 0.15
  ), 0, 100);

  return {
    maximumLoanAmount: maximumLoanAmount,
    historicalExpectedAmount: roundToNearest_(historicalExpected, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    historicalExpectedLow: roundToNearest_(historicalExpected * 0.90, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    historicalExpectedHigh: roundToNearest_(historicalExpected * 1.10, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    currentBankingAmount: roundToNearest_(currentBankingAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    materialRiskFactor: round2_(materialRiskFactor),
    materialRisks: materialRisks,
    confidenceScore: confidenceScore,
    confidence: confidenceScore >= 80 ? 'High' : confidenceScore >= 60 ? 'Moderate' : 'Low',
    calculationNotes: [
      'Original model amount: ' + roundToNearest_(originalAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Historical expected amount: ' + roundToNearest_(historicalExpected, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Current banking amount: ' + roundToNearest_(currentBankingAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Historical / banking / AI weighting: 70% / 20% / 10%',
      'Material current-risk factor: ' + Math.round(materialRiskFactor * 100) + '%',
      'Top lender fit: ' + lenderFit + '/100',
      materialRisks.length ? 'Material risk adjustments: ' + materialRisks.join(', ') : 'No material deterioration adjustment applied.'
    ]
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
    'Assessment ID','Model Version','Company Name','Period','Maximum Loan Amount',
    'Original Model Amount','Historical Expected Amount','Current Banking Amount','Business Health Score',
    'Risk Grade','Average Monthly Deposits','Historical Anchor','Cash Flow Capacity','Revenue Capacity',
    'Amount Confidence','Amount Confidence Score','Strongest Lender','Lender Fit Score','Calculation Notes','Created At'
  ]);
  appendRow_('Institutional Assessments', [
    base.assessmentId,i.modelVersion,base.companyName,base.period,i.maximumLoanAmount,
    i.originalModelAmount,i.historicalExpectedAmount,i.currentBankingAmount,i.businessHealthScore,
    i.riskGrade,i.averageMonthlyDeposits,i.historicalAnchor,i.cashFlowCapacity,i.revenueCapacity,
    i.amountConfidence,i.amountConfidenceScore,i.strongestLender,i.lenderFitScore,cleanCell_(i.calculationNotes),new Date()
  ]);
}