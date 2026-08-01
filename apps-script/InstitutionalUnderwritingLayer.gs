const VFC_INSTITUTIONAL_CONFIG = {
  MODEL_VERSION: 'VFC-STABLE-MAX-6.0-FINAL',
  HISTORICAL_WEIGHT: 0.70,
  CURRENT_BANKING_WEIGHT: 0.20,
  DETERMINISTIC_RISK_WEIGHT: 0.10,
  ROUNDING: 500
};

/**
 * Final production underwriting entry point.
 *
 * Safeguards:
 * 1. Production sizing is deterministic. OpenAI output does not change the amount.
 * 2. Pattern learning and accuracy analytics do not affect the amount.
 * 3. For the exact same company and statement period, a previously verified
 *    approval or proven VFC 4.1/4.2 result is a regression floor.
 * 4. No assessment-history write occurs before the result is returned.
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
    return !(sameText_(row.companyName, companyName) && stablePeriodMatches_(row.period, period));
  });
  if (!outcomes.length) {
    throw new Error('No historical lender outcomes are available. Add approvals and declines in Training Data first.');
  }

  const fundamental = calculateFundamentalScore_(current);

  // Deterministic production review. This prevents the amount changing because
  // an OpenAI response used a slightly different risk score on a later run.
  const deterministicReview = buildDeterministicProductionReview_(fundamental);

  const lenders = unique_(outcomes.map(function(row) {
    return row.lenderName;
  }).filter(Boolean));

  const rankings = lenders.map(function(lender) {
    return scorePowerLender_(lender, current, outcomes, fundamental, deterministicReview);
  }).sort(function(a, b) {
    return b.compositeScore - a.compositeScore;
  });

  const originalCapacity = calculateExactLendingCapacity_(
    current,
    fundamental,
    deterministicReview,
    rankings
  );
  const top = rankings[0] || {};

  const stableCalculation = calculateStableHistoricalMaximum_(
    Math.max(0, toNumber_(originalCapacity.recommendedAmount)),
    Math.max(0, toNumber_(originalCapacity.historicalAnchor)),
    current,
    fundamental,
    deterministicReview,
    top
  );

  const benchmark = getVerifiedRegressionBenchmark_(companyName, period);
  let maximumLoanAmount = stableCalculation.maximumLoanAmount;
  let regressionGuardApplied = false;

  if (benchmark.amount > maximumLoanAmount) {
    maximumLoanAmount = benchmark.amount;
    regressionGuardApplied = true;
  }

  maximumLoanAmount = roundToNearest_(
    Math.max(0, maximumLoanAmount),
    VFC_INSTITUTIONAL_CONFIG.ROUNDING
  );

  const capacity = Object.assign({}, originalCapacity, {
    originalRecommendedAmount: toNumber_(originalCapacity.recommendedAmount),
    recommendedAmount: maximumLoanAmount,
    stretchAmount: maximumLoanAmount,
    historicalRecalibration: stableCalculation,
    verifiedRegressionBenchmark: benchmark.amount,
    regressionGuardApplied: regressionGuardApplied,
    regressionBenchmarkSource: benchmark.source
  });

  const decision = buildPowerDecision_(current, fundamental, deterministicReview, rankings, capacity);
  decision.recommended_amount = maximumLoanAmount;
  decision.stretch_amount = maximumLoanAmount;
  decision.explanation = regressionGuardApplied
    ? 'The deterministic underwriting result was protected by the last verified result for this exact company and statement period.'
    : 'The maximum recommended loan was calculated using deterministic historical and banking analysis.';

  const assessmentId = Utilities.getUuid();
  const confidenceScore = Math.max(
    toNumber_(stableCalculation.confidenceScore),
    toNumber_(originalCapacity.confidenceScore)
  );

  const response = {
    ok: true,
    assessmentId: assessmentId,
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    activeProductionModel: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    currentFeatures: current,
    fundamentalScorecard: fundamental,
    expertReview: deterministicReview,
    lendingCapacity: capacity,
    lenderRankings: rankings,
    underwritingSummary: decision,
    institutionalAssessment: {
      modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
      maximumLoanAmount: maximumLoanAmount,
      originalModelAmount: toNumber_(originalCapacity.recommendedAmount),
      historicalExpectedAmount: stableCalculation.historicalExpectedAmount,
      currentBankingAmount: stableCalculation.currentBankingAmount,
      verifiedRegressionBenchmark: benchmark.amount,
      regressionGuardApplied: regressionGuardApplied,
      regressionBenchmarkSource: benchmark.source,
      amountConfidence: confidenceLabel_(confidenceScore),
      amountConfidenceScore: confidenceScore,
      businessHealthScore: toNumber_(fundamental.score),
      riskGrade: fundamental.grade || '',
      averageMonthlyDeposits: toNumber_(current.averageMonthlyDeposits),
      historicalAnchor: toNumber_(originalCapacity.historicalAnchor),
      cashFlowCapacity: toNumber_(originalCapacity.cashFlowCapacity),
      revenueCapacity: toNumber_(originalCapacity.revenueCapacity),
      strongestLender: top.lenderName || '',
      lenderFitScore: toNumber_(top.compositeScore),
      calculationNotes: stableCalculation.calculationNotes.concat(
        benchmark.amount > 0
          ? ['Verified regression benchmark: ' + benchmark.amount + ' from ' + benchmark.source + '.']
          : ['No prior verified benchmark was found for this exact company and period.'],
        regressionGuardApplied
          ? ['Regression safeguard applied: the result was not allowed to fall below the verified benchmark.']
          : ['Regression safeguard was not required.']
      ),
      strengths: Array.isArray(fundamental.strengths) ? fundamental.strengths : [],
      risks: Array.isArray(fundamental.risks) ? fundamental.risks : [],
      decision: maximumLoanAmount > 0
        ? 'Maximum recommended loan'
        : 'No automated loan amount recommended',
      methodologyNote:
        'Production model ' + VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION +
        ' uses deterministic historical and banking calculations. OpenAI wording, pattern learning and newly added training files cannot reduce a previously verified result for the exact same company and statement period.'
    },
    disclaimer:
      'VFC internal decision support only. The recommendation is based on uploaded bank statements and recorded historical outcomes and is not a lender approval or guarantee.'
  };

  return JSON.parse(JSON.stringify(response));
}

function buildDeterministicProductionReview_(fundamental) {
  return {
    risk_score: toNumber_(fundamental.score),
    risk_grade: fundamental.grade || '',
    executive_summary: 'Deterministic banking and historical analysis completed.',
    key_strengths: Array.isArray(fundamental.strengths) ? fundamental.strengths : [],
    key_risks: Array.isArray(fundamental.risks) ? fundamental.risks : [],
    missing_information: [],
    recommended_conditions: []
  };
}

function calculateStableHistoricalMaximum_(originalAmount, historicalAnchor, features, fundamental, review, top) {
  const deposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const fundamentalScore = toNumber_(fundamental.score);
  const riskScore = toNumber_(review.risk_score || fundamentalScore);
  const lenderFit = toNumber_(top.compositeScore);
  const historicalExpected = historicalAnchor > 0 ? historicalAnchor : originalAmount;

  const currentBankingAmount = deposits * (
    fundamentalScore >= 82 ? 1.05 :
    fundamentalScore >= 70 ? 0.95 :
    fundamentalScore >= 58 ? 0.80 :
    fundamentalScore >= 45 ? 0.62 : 0.40
  );
  const deterministicRiskAmount = historicalExpected * clamp_(riskScore / 75, 0.80, 1.10);

  let blended =
    historicalExpected * VFC_INSTITUTIONAL_CONFIG.HISTORICAL_WEIGHT +
    currentBankingAmount * VFC_INSTITUTIONAL_CONFIG.CURRENT_BANKING_WEIGHT +
    deterministicRiskAmount * VFC_INSTITUTIONAL_CONFIG.DETERMINISTIC_RISK_WEIGHT;

  let materialRiskFactor = 1;
  const materialRisks = [];
  if (toNumber_(features.nsfPerMonth) > 2) {
    materialRiskFactor -= 0.10;
    materialRisks.push('more than two NSF events per month');
  }
  if (features.suspectedStacking) {
    materialRiskFactor -= 0.12;
    materialRisks.push('possible stacking');
  }
  if (features.negativeBalanceFlag && features.overdraftFlag) {
    materialRiskFactor -= 0.08;
    materialRisks.push('negative-balance and overdraft conduct');
  }
  if (toNumber_(features.depositTrend) < -0.20) {
    materialRiskFactor -= 0.10;
    materialRisks.push('material deposit decline');
  }
  if (toNumber_(features.depositVolatility) > 0.65) {
    materialRiskFactor -= 0.07;
    materialRisks.push('extreme deposit volatility');
  }
  if (toNumber_(fundamental.dataQualityScore) < 50) {
    materialRiskFactor -= 0.08;
    materialRisks.push('low data quality');
  }
  materialRiskFactor = clamp_(materialRiskFactor, 0.65, 1.05);
  blended *= materialRiskFactor;

  const noMaterialDeterioration = materialRiskFactor >= 0.98 && fundamentalScore >= 50;
  if (noMaterialDeterioration && historicalExpected > 0) {
    blended = Math.max(blended, historicalExpected * 0.92);
  }
  if (noMaterialDeterioration) {
    blended = Math.max(blended, originalAmount);
  }

  const marketCap = deposits > 0
    ? deposits * (fundamentalScore >= 70 ? 1.25 : fundamentalScore >= 58 ? 1.05 : 0.85)
    : blended;
  if (marketCap > 0) {
    blended = Math.min(blended, Math.max(marketCap, historicalExpected * 0.92));
  }

  let maximumLoanAmount = roundToNearest_(
    Math.max(0, blended),
    VFC_INSTITUTIONAL_CONFIG.ROUNDING
  );
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
    currentBankingAmount: roundToNearest_(currentBankingAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
    materialRiskFactor: round2_(materialRiskFactor),
    materialRisks: materialRisks,
    confidenceScore: confidenceScore,
    calculationNotes: [
      'Original engine amount: ' + roundToNearest_(originalAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Historical expected amount: ' + roundToNearest_(historicalExpected, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Current banking amount: ' + roundToNearest_(currentBankingAmount, VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      'Deterministic weighting: 70% historical / 20% current banking / 10% risk score',
      'Material current-risk factor: ' + Math.round(materialRiskFactor * 100) + '%',
      'Top lender fit: ' + lenderFit + '/100',
      materialRisks.length
        ? 'Material risk adjustments: ' + materialRisks.join(', ')
        : 'No material deterioration adjustment applied.'
    ]
  };
}

/**
 * Finds the strongest proven benchmark for the exact same company and period.
 * Priority:
 * 1. Actual approved/conditional lender outcome.
 * 2. A saved VFC-HISTORICAL-MAX-4.1 or 4.2 assessment.
 * 3. A prediction outcome created by one of those proven versions.
 */
function getVerifiedRegressionBenchmark_(companyName, period) {
  const actualRows = stableReadSheet_('Prediction Outcomes').filter(function(row) {
    return sameText_(row.companyName, companyName) &&
      stablePeriodMatches_(row.period, period) &&
      /approved|conditional/i.test(String(row.actualDecision || '')) &&
      toNumber_(row.actualApprovedAmount) > 0;
  });

  if (actualRows.length) {
    return {
      amount: roundToNearest_(Math.max.apply(null, actualRows.map(function(row) {
        return toNumber_(row.actualApprovedAmount);
      })), VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      source: 'verified actual lender outcome'
    };
  }

  const provenVersion = /VFC-HISTORICAL-MAX-4\.(1|2)/i;
  const assessmentRows = stableReadSheet_('Institutional Assessments').filter(function(row) {
    return sameText_(row.companyName, companyName) &&
      stablePeriodMatches_(row.period, period) &&
      provenVersion.test(String(row.modelVersion || '')) &&
      toNumber_(row.maximumLoanAmount) > 0;
  });

  if (assessmentRows.length) {
    return {
      amount: roundToNearest_(Math.max.apply(null, assessmentRows.map(function(row) {
        return toNumber_(row.maximumLoanAmount);
      })), VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      source: 'previous proven VFC 4.1/4.2 assessment'
    };
  }

  const predictionRows = stableReadSheet_('Prediction Outcomes').filter(function(row) {
    return sameText_(row.companyName, companyName) &&
      stablePeriodMatches_(row.period, period) &&
      provenVersion.test(String(row.modelVersion || '')) &&
      toNumber_(row.predictedAmount) > 0;
  });

  if (predictionRows.length) {
    return {
      amount: roundToNearest_(Math.max.apply(null, predictionRows.map(function(row) {
        return toNumber_(row.predictedAmount);
      })), VFC_INSTITUTIONAL_CONFIG.ROUNDING),
      source: 'previous proven VFC prediction'
    };
  }

  return { amount: 0, source: 'none' };
}

function stableReadSheet_(sheetName) {
  try {
    return getSheetObjects_(sheetName) || [];
  } catch (error) {
    return [];
  }
}

function stablePeriodMatches_(left, right) {
  if (sameText_(left, right)) return true;
  return stablePeriodKey_(left) === stablePeriodKey_(right);
}

function stablePeriodKey_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function confidenceLabel_(scoreValue) {
  const score = toNumber_(scoreValue);
  return score >= 80 ? 'High' : score >= 60 ? 'Moderate' : 'Low';
}

function getProductionModelStatus() {
  return {
    modelVersion: VFC_INSTITUTIONAL_CONFIG.MODEL_VERSION,
    deterministicProductionSizing: true,
    openAIChangesLiveAmount: false,
    patternLearningChangesLiveAmount: false,
    verifiedRegressionFloorActive: true,
    resultReturnedBeforeAuditLogging: true
  };
}
