const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-HISTORICAL-MAX-4.3-PATTERN-LEARNING',
  HISTORICAL_WEIGHT: 0.70,
  CURRENT_BANKING_WEIGHT: 0.20,
  AI_WEIGHT: 0.10,
  PATTERN_BLEND: 0.70,
  BASE_BLEND: 0.30,
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
  const baseRecalibration = calculateHistoricalMaximum_(originalAmount, historicalAnchor, features, fundamental, ai, top);
  const pattern = getLearnedPatternRecommendation_(features);
  const finalResult = blendPatternRecommendation_(baseRecalibration, pattern, originalAmount, features, fundamental);

  base.lendingCapacity.originalRecommendedAmount = originalAmount;
  base.lendingCapacity.recommendedAmount = finalResult.maximumLoanAmount;
  base.lendingCapacity.stretchAmount = finalResult.maximumLoanAmount;
  base.lendingCapacity.historicalRecalibration = baseRecalibration;
  base.lendingCapacity.patternLearning = pattern;

  if (base.underwritingSummary) {
    base.underwritingSummary.recommended_amount = finalResult.maximumLoanAmount;
    base.underwritingSummary.stretch_amount = finalResult.maximumLoanAmount;
    base.underwritingSummary.explanation = (base.underwritingSummary.explanation || '') +
      ' Pattern-learning recalibration produced a maximum recommended loan of ' + finalResult.maximumLoanAmount + '.';
  }

  base.institutionalAssessment = {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    maximumLoanAmount: finalResult.maximumLoanAmount,
    originalModelAmount: originalAmount,
    historicalExpectedAmount: baseRecalibration.historicalExpectedAmount,
    historicalExpectedLow: baseRecalibration.historicalExpectedLow,
    historicalExpectedHigh: baseRecalibration.historicalExpectedHigh,
    currentBankingAmount: baseRecalibration.currentBankingAmount,
    learnedPatternAmount: pattern.predictedAmount || 0,
    patternActive: !!pattern.active,
    patternConfidence: pattern.confidence || 'Insufficient history',
    patternConfidenceScore: pattern.confidenceScore || 0,
    comparablePatternCases: pattern.comparableCases || 0,
    patternAverageSimilarity: pattern.averageSimilarity || 0,
    patternBacktest: pattern.model && pattern.model.backtest ? pattern.model.backtest : {},
    closestPatternCases: pattern.closestCases || [],
    amountConfidence: finalResult.confidence,
    amountConfidenceScore: finalResult.confidenceScore,
    businessHealthScore: toNumber_(fundamental.score),
    riskGrade: fundamental.grade || '',
    averageMonthlyDeposits: toNumber_(features.averageMonthlyDeposits),
    historicalAnchor: historicalAnchor,
    strongestLender: top.lenderName || '',
    lenderFitScore: toNumber_(top.compositeScore),
    closestHistoricalApprovals: historicalCases,
    calculationNotes: finalResult.calculationNotes,
    strengths: fundamental.strengths || [],
    risks: fundamental.risks || [],
    decision: finalResult.maximumLoanAmount > 0 ? 'Maximum recommended loan' : 'No automated loan amount recommended',
    methodologyNote: 'The maximum loan combines verified historical lender outcomes, learned banking-pattern similarity, current business-bank-statement health and AI review. The pattern model automatically retrains when the number of historical outcomes changes and is used only when minimum sample and back-test requirements are met.'
  };

  base.modelVersion = VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION;
  base.disclaimer = 'VFC internal decision support only. The maximum loan is estimated from uploaded bank statements and recorded historical lender outcomes. It is not a lender approval or guarantee.';
  saveOriginalMaximumAssessment_(base);
  return base;
}

function blendPatternRecommendation_(baseResult, pattern, originalAmount, features, fundamental) {
  let amount = baseResult.maximumLoanAmount;
  const notes = (baseResult.calculationNotes || []).slice();
  let confidenceScore = baseResult.confidenceScore || 0;

  if (pattern && pattern.active && pattern.predictedAmount > 0) {
    const patternReliability = clamp_(toNumber_(pattern.confidenceScore) / 100, 0.35, 0.90);
    const patternWeight = VFC_INSTITUTIONAL_CONFIG.PATTERN_BLEND * patternReliability;
    const baseWeight = 1 - patternWeight;
    amount = baseResult.maximumLoanAmount * baseWeight + pattern.predictedAmount * patternWeight;

    const materialRisk = baseResult.materialRiskFactor < 0.90 || toNumber_(fundamental.score) < 45;
    if (!materialRisk) amount = Math.max(amount, originalAmount);

    notes.push('Learned pattern amount: ' + roundToNearest_(pattern.predictedAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING));
    notes.push('Pattern comparable cases: ' + toNumber_(pattern.comparableCases));
    notes.push('Pattern confidence: ' + (pattern.confidence || '') + ' (' + toNumber_(pattern.confidenceScore) + '/100)');
    if (pattern.model && pattern.model.backtest) {
      notes.push('Pattern back-test median error: ' + toNumber_(pattern.model.backtest.medianPercentError) + '%');
    }
    confidenceScore = Math.round(confidenceScore * 0.55 + toNumber_(pattern.confidenceScore) * 0.45);
  } else {
    notes.push('Pattern model not active yet; using historical recalibration only.');
  }

  const deposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const reasonableCap = deposits > 0 ? deposits * (toNumber_(fundamental.score) >= 70 ? 1.40 : toNumber_(fundamental.score) >= 58 ? 1.15 : 0.90) : amount;
  if (reasonableCap > 0) amount = Math.min(amount, Math.max(reasonableCap, baseResult.historicalExpectedAmount * 1.05));
  amount = roundToNearest_(Math.max(0, amount), VFC_INSTITUTIONAL_CONFIG.ROUNDING);
  if (toNumber_(fundamental.score) < 40 || !deposits) amount = 0;

  return {
    maximumLoanAmount: amount,
    confidenceScore: clamp_(confidenceScore, 0, 100),
    confidence: confidenceScore >= 80 ? 'High' : confidenceScore >= 60 ? 'Moderate' : 'Low',
    calculationNotes: notes
  };
}

function calculateHistoricalMaximum_(originalAmount, historicalAnchor, features, fundamental, ai, top) {
  const deposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const fundamentalScore = toNumber_(fundamental.score);
  const aiScore = toNumber_(ai.risk_score || fundamentalScore);
  const lenderFit = toNumber_(top.compositeScore);
  const historicalExpected = historicalAnchor > 0 ? historicalAnchor : originalAmount;
  const currentBankingAmount = deposits * (fundamentalScore >= 82 ? 1.05 : fundamentalScore >= 70 ? 0.95 : fundamentalScore >= 58 ? 0.80 : fundamentalScore >= 45 ? 0.62 : 0.40);
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
  if (noMaterialDeterioration && historicalExpected > 0) blended = Math.max(blended, historicalExpected * 0.92);
  if (noMaterialDeterioration) blended = Math.max(blended, originalAmount);

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
  return (rankings || []).filter(function(r) { return toNumber_(r.medianApprovedAmount) > 0; }).slice(0, 5).map(function(r) {
    return {
      lenderName:r.lenderName || '', similarityScore:toNumber_(r.compositeScore),
      similarApprovals:toNumber_(r.similarApprovals), similarCases:toNumber_(r.similarCases),
      approvalRate:r.observedApprovalRate || '', lowApprovedAmount:toNumber_(r.lowApprovedAmount),
      medianApprovedAmount:toNumber_(r.medianApprovedAmount), highApprovedAmount:toNumber_(r.highApprovedAmount)
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
    i.historicalExpectedAmount,i.currentBankingAmount,i.learnedPatternAmount,i.patternActive,
    i.patternConfidence,i.patternConfidenceScore,i.comparablePatternCases,i.businessHealthScore,
    i.riskGrade,i.averageMonthlyDeposits,i.historicalAnchor,i.amountConfidence,i.amountConfidenceScore,
    i.strongestLender,i.lenderFitScore,cleanCell_(i.calculationNotes),new Date()
  ]);
}
