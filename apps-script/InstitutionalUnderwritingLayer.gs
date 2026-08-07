const VFC_SIMPLE_CONFIG = {
  MODEL_VERSION: 'VFC-SIMPLE-HISTORICAL-7.2-INPUT-QUALITY',
  MAX_COMPARABLE_CASES: 12,
  MAX_APPROVAL_CASES: 8,
  MIN_SIMILARITY: 0.40,
  ROUNDING: 500,
  MIN_AMOUNT: 5000
};

/**
 * Single production underwriting path.
 *
 * Flow:
 * uploaded statements -> validated banking features -> closest historical
 * training outcomes -> maximum recommended loan.
 *
 * There is no OpenAI amount adjustment, pattern model, regression floor,
 * term-based sizing, shadow calculation, or accuracy-layer adjustment.
 */
function generateInstitutionalAssessmentSafe(companyOrRequest, requestedPeriod) {
  const request = normalizeAssessmentRequest_(companyOrRequest, requestedPeriod);
  const companyName = request.companyName;
  const period = resolveLatestAssessmentPeriod_(companyName, request.period);

  let debtSignalRefresh = null;
  if (typeof refreshDebtSignalsForPeriodSafe === 'function') {
    debtSignalRefresh = refreshDebtSignalsForPeriodSafe({
      companyName: companyName,
      period: period
    });
  }

  const current = typeof getValidatedBankingFeatures_ === 'function'
    ? getValidatedBankingFeatures_(companyName, period)
    : buildPowerFeatures_(companyName, period);
  if (!current || !current.statementCount) {
    throw new Error('No bank-statement summaries were found for this company and period.');
  }

  const outcomes = collectHistoricalOutcomes_().filter(function(row) {
    return !(sameText_(row.companyName, companyName) && simplePeriodMatches_(row.period, period));
  });

  if (!outcomes.length) {
    throw new Error('No historical lender outcomes are available. Add approved and declined training files first.');
  }

  const fundamental = calculateFundamentalScore_(current);
  const comparables = simpleBuildComparableCases_(current, outcomes);
  const closestCases = comparables.slice(0, VFC_SIMPLE_CONFIG.MAX_COMPARABLE_CASES);
  const closestApprovals = closestCases.filter(function(row) {
    return row.isPositive && row.approvedAmount > 0;
  }).slice(0, VFC_SIMPLE_CONFIG.MAX_APPROVAL_CASES);

  const historicalAmount = simpleHistoricalAmount_(closestApprovals);
  const bankingAmount = simpleBankingAmount_(current, fundamental);
  const approvalRate = simpleApprovalRate_(closestCases);
  const risk = simpleRiskAdjustment_(current, fundamental);

  let historicalWeight = 0;
  if (closestApprovals.length >= 5) historicalWeight = 0.85;
  else if (closestApprovals.length >= 3) historicalWeight = 0.78;
  else if (closestApprovals.length > 0) historicalWeight = 0.65;

  let maximumLoanAmount = historicalAmount > 0
    ? historicalAmount * historicalWeight + bankingAmount * (1 - historicalWeight)
    : bankingAmount * 0.75;

  let approvalAdjustment = 1;
  if (closestCases.length >= 3) {
    if (approvalRate < 0.35) approvalAdjustment = 0.80;
    else if (approvalRate < 0.50) approvalAdjustment = 0.88;
    else if (approvalRate < 0.65) approvalAdjustment = 0.95;
  }

  maximumLoanAmount *= approvalAdjustment;
  maximumLoanAmount *= risk.factor;

  if (
    historicalAmount > 0 &&
    closestApprovals.length >= 3 &&
    approvalRate >= 0.50 &&
    risk.factor >= 0.95
  ) {
    maximumLoanAmount = Math.max(maximumLoanAmount, historicalAmount * 0.90);
  }

  const deposits = Math.max(0, toNumber_(current.averageMonthlyDeposits));
  const score = toNumber_(fundamental.score);
  const marketCap = deposits * (score >= 75 ? 1.25 : score >= 60 ? 1.05 : 0.85);
  if (marketCap > 0) {
    maximumLoanAmount = Math.min(
      maximumLoanAmount,
      Math.max(marketCap, historicalAmount * 1.05)
    );
  }

  maximumLoanAmount = roundToNearest_(
    Math.max(0, maximumLoanAmount),
    VFC_SIMPLE_CONFIG.ROUNDING
  );

  if (score < 40 || !deposits) maximumLoanAmount = 0;
  if (
    maximumLoanAmount > 0 &&
    maximumLoanAmount < VFC_SIMPLE_CONFIG.MIN_AMOUNT &&
    score >= 45
  ) {
    maximumLoanAmount = VFC_SIMPLE_CONFIG.MIN_AMOUNT;
  }

  const confidenceScore = simpleConfidenceScore_(
    closestApprovals,
    closestCases,
    fundamental,
    current
  );
  const confidence = simpleConfidenceLabel_(confidenceScore);
  const rankings = simpleBuildLenderRankings_(comparables);
  const assessmentId = Utilities.getUuid();

  const closestHistoricalApprovals = closestApprovals.slice(0, 5).map(function(row) {
    return {
      companyName: row.companyName,
      lenderName: row.lenderName,
      decision: row.decision,
      similarityScore: Math.round(row.similarity * 100),
      actualApprovedAmount: row.approvedAmount,
      depositAdjustedAmount: roundToNearest_(row.adjustedAmount, VFC_SIMPLE_CONFIG.ROUNDING)
    };
  });

  const calculationNotes = [
    'Closest training cases reviewed: ' + closestCases.length,
    'Closest approved or conditional cases used: ' + closestApprovals.length,
    'Historical comparable amount: ' + roundToNearest_(historicalAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    'Current banking amount: ' + roundToNearest_(bankingAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    'Observed approval rate among closest cases: ' + Math.round(approvalRate * 100) + '%',
    'Current banking-risk factor: ' + Math.round(risk.factor * 100) + '%',
    'Validated months reviewed: ' + toNumber_(current.monthsCovered),
    'Validated average monthly deposits: ' + roundToNearest_(deposits, 1),
    'Detected recurring financing debt service: ' + roundToNearest_(toNumber_(current.existingMonthlyDebtService), 1),
    risk.reasons.length
      ? 'Banking-risk adjustments: ' + risk.reasons.join(', ')
      : 'No material banking-risk reduction applied.'
  ];

  const inputWarnings = current.inputQualityAudit && Array.isArray(current.inputQualityAudit.warnings)
    ? current.inputQualityAudit.warnings
    : [];
  inputWarnings.forEach(function(note) {
    calculationNotes.push('Input quality: ' + note);
  });

  const lendingCapacity = {
    recommendedAmount: maximumLoanAmount,
    stretchAmount: maximumLoanAmount,
    confidence: confidence,
    confidenceScore: confidenceScore,
    historicalAnchor: roundToNearest_(historicalAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    cashFlowCapacity: roundToNearest_(bankingAmount, VFC_SIMPLE_CONFIG.ROUNDING),
    revenueCapacity: roundToNearest_(marketCap, VFC_SIMPLE_CONFIG.ROUNDING),
    calculationNotes: calculationNotes
  };

  const underwritingSummary = {
    summary: maximumLoanAmount > 0 ? 'Maximum recommended loan' : 'Manual review required',
    recommended_amount: maximumLoanAmount,
    stretch_amount: maximumLoanAmount,
    strongest_lender: rankings.length ? rankings[0].lenderName : '',
    explanation:
      'The recommendation is based on the closest historical lender outcomes in the Training Data and the current bank-statement profile.',
    fundamental_score: score,
    risk_grade: fundamental.grade || '',
    key_strengths: fundamental.strengths || [],
    key_risks: fundamental.risks || []
  };

  return JSON.parse(JSON.stringify({
    ok: true,
    assessmentId: assessmentId,
    modelVersion: VFC_SIMPLE_CONFIG.MODEL_VERSION,
    activeProductionModel: VFC_SIMPLE_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    currentFeatures: current,
    fundamentalScorecard: fundamental,
    lendingCapacity: lendingCapacity,
    lenderRankings: rankings,
    underwritingSummary: underwritingSummary,
    institutionalAssessment: {
      modelVersion: VFC_SIMPLE_CONFIG.MODEL_VERSION,
      maximumLoanAmount: maximumLoanAmount,
      amountConfidence: confidence,
      amountConfidenceScore: confidenceScore,
      businessHealthScore: score,
      riskGrade: fundamental.grade || '',
      averageMonthlyDeposits: deposits,
      estimatedOperatingMonthlyDeposits: toNumber_(current.estimatedOperatingMonthlyDeposits),
      existingMonthlyDebtService: toNumber_(current.existingMonthlyDebtService),
      otherRecurringMonthlyObligations: toNumber_(current.otherRecurringMonthlyObligations),
      debtServiceToDepositsRatio: toNumber_(current.debtServiceToDepositsRatio),
      detectedFinancingCredits: toNumber_(current.detectedFinancingCredits),
      activeDebtObligations: current.debtProfile && Array.isArray(current.debtProfile.activeDebtObligations)
        ? current.debtProfile.activeDebtObligations
        : [],
      otherRecurringObligations: current.debtProfile && Array.isArray(current.debtProfile.otherRecurringObligations)
        ? current.debtProfile.otherRecurringObligations
        : [],
      inputQualityWarnings: inputWarnings,
      debtSignalRefreshStatus: debtSignalRefresh || {},
      historicalExpectedAmount: roundToNearest_(historicalAmount, VFC_SIMPLE_CONFIG.ROUNDING),
      currentBankingAmount: roundToNearest_(bankingAmount, VFC_SIMPLE_CONFIG.ROUNDING),
      comparableCases: closestCases.length,
      comparableApprovals: closestApprovals.length,
      observedApprovalRate: Math.round(approvalRate * 100),
      strongestLender: rankings.length ? rankings[0].lenderName : '',
      closestHistoricalApprovals: closestHistoricalApprovals,
      calculationNotes: calculationNotes,
      strengths: fundamental.strengths || [],
      risks: fundamental.risks || [],
      decision: maximumLoanAmount > 0
        ? 'Maximum recommended loan'
        : 'No automated loan amount recommended',
      methodologyNote:
        'One simple model is active: closest historical training outcomes are adjusted to validated current business deposits and checked against current banking conduct. Recurring debt/PAD amounts are extracted for visibility and OpenAI review but no new debt-service multiplier has been added to Our Max.'
    },
    disclaimer:
      'VFC internal decision support only. This recommendation is based on uploaded bank statements and recorded historical lender outcomes and is not a lender approval or guarantee.'
  }));
}

function simpleBuildComparableCases_(current, outcomes) {
  const currentDeposits = Math.max(0, toNumber_(current.averageMonthlyDeposits));
  const cases = [];

  (outcomes || []).forEach(function(outcome) {
    const decision = simpleDecision_(outcome.decision);
    if (!decision || !outcome.companyName) return;

    let features;
    try {
      features = typeof getValidatedBankingFeatures_ === 'function'
        ? getValidatedBankingFeatures_(outcome.companyName, outcome.period)
        : buildPowerFeatures_(outcome.companyName, outcome.period);
    } catch (error) {
      return;
    }

    if (!features || !features.statementCount || !toNumber_(features.averageMonthlyDeposits)) return;

    const similarity = powerSimilarity_(current, features);
    if (similarity < VFC_SIMPLE_CONFIG.MIN_SIMILARITY) return;

    const approvedAmount = Math.max(0, toNumber_(outcome.approvedAmount));
    const historicalDeposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
    const depositRatio = historicalDeposits > 0
      ? clamp_(currentDeposits / historicalDeposits, 0.60, 1.45)
      : 1;
    const isPositive = decision === 'Approved' || decision === 'Conditional';

    cases.push({
      companyName: outcome.companyName || '',
      period: outcome.period || '',
      lenderName: outcome.lenderName || 'Unknown lender',
      decision: decision,
      declineReason: outcome.declineReason || '',
      approvedAmount: approvedAmount,
      adjustedAmount: isPositive && approvedAmount > 0
        ? approvedAmount * depositRatio
        : 0,
      similarity: similarity,
      isPositive: isPositive,
      decisionWeight: decision === 'Conditional' ? 0.85 : 1
    });
  });

  cases.sort(function(a, b) {
    return b.similarity - a.similarity;
  });
  return cases;
}

function simpleHistoricalAmount_(approvals) {
  if (!approvals || !approvals.length) return 0;

  let weightedTotal = 0;
  let totalWeight = 0;
  const weightedRows = [];

  approvals.forEach(function(row) {
    const weight = Math.pow(Math.max(0.05, row.similarity), 2) * row.decisionWeight;
    weightedTotal += row.adjustedAmount * weight;
    totalWeight += weight;
    weightedRows.push({ value: row.adjustedAmount, weight: weight });
  });

  const weightedAverage = totalWeight ? weightedTotal / totalWeight : 0;
  const weightedMedian = simpleWeightedMedian_(weightedRows);
  return weightedAverage * 0.65 + weightedMedian * 0.35;
}

function simpleWeightedMedian_(rows) {
  if (!rows || !rows.length) return 0;
  const sorted = rows.slice().sort(function(a, b) { return a.value - b.value; });
  const total = sorted.reduce(function(sum, row) { return sum + row.weight; }, 0);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].weight;
    if (running >= total / 2) return sorted[i].value;
  }
  return sorted[sorted.length - 1].value;
}

function simpleApprovalRate_(cases) {
  if (!cases || !cases.length) return 0;
  let positive = 0;
  let total = 0;
  cases.forEach(function(row) {
    const weight = Math.max(0.05, row.similarity);
    total += weight;
    if (row.decision === 'Approved') positive += weight;
    else if (row.decision === 'Conditional') positive += weight * 0.65;
  });
  return total ? positive / total : 0;
}

function simpleBankingAmount_(features, fundamental) {
  const deposits = Math.max(0, toNumber_(features.averageMonthlyDeposits));
  const score = toNumber_(fundamental.score);
  const multiple = score >= 82 ? 1.05 :
    score >= 70 ? 0.90 :
    score >= 58 ? 0.75 :
    score >= 45 ? 0.55 : 0.35;
  return deposits * multiple;
}

function simpleRiskAdjustment_(features, fundamental) {
  let factor = 1;
  const reasons = [];

  if (toNumber_(features.nsfPerMonth) > 2) {
    factor *= 0.88;
    reasons.push('frequent NSF activity');
  }
  if (features.suspectedStacking) {
    factor *= 0.85;
    reasons.push('possible stacking');
  }
  if (features.negativeBalanceFlag && features.overdraftFlag) {
    factor *= 0.90;
    reasons.push('negative balance and overdraft activity');
  }
  if (toNumber_(features.depositTrend) < -0.20) {
    factor *= 0.90;
    reasons.push('material deposit decline');
  }
  if (toNumber_(features.depositVolatility) > 0.65) {
    factor *= 0.93;
    reasons.push('high deposit volatility');
  }
  if (toNumber_(fundamental.dataQualityScore) < 50) {
    factor *= 0.90;
    reasons.push('low data quality');
  }

  return {
    factor: clamp_(factor, 0.65, 1),
    reasons: reasons
  };
}

function simpleConfidenceScore_(approvals, cases, fundamental, features) {
  const averageSimilarity = approvals.length
    ? approvals.reduce(function(sum, row) { return sum + row.similarity; }, 0) / approvals.length
    : cases.length
      ? cases.reduce(function(sum, row) { return sum + row.similarity; }, 0) / cases.length
      : 0;

  return clamp_(Math.round(
    Math.min(100, approvals.length / 6 * 100) * 0.40 +
    Math.min(100, averageSimilarity * 100) * 0.35 +
    toNumber_(fundamental.dataQualityScore) * 0.15 +
    Math.min(100, toNumber_(features.monthsCovered) / 6 * 100) * 0.10
  ), 0, 100);
}

function simpleBuildLenderRankings_(comparables) {
  const lenderNames = unique_((comparables || []).map(function(row) {
    return row.lenderName;
  }).filter(Boolean));

  return lenderNames.map(function(lenderName) {
    const rows = comparables.filter(function(row) {
      return sameText_(row.lenderName, lenderName);
    }).slice(0, VFC_SIMPLE_CONFIG.MAX_COMPARABLE_CASES);

    const approvals = rows.filter(function(row) {
      return row.isPositive && row.approvedAmount > 0;
    });
    const declines = rows.filter(function(row) {
      return row.decision === 'Declined';
    });
    const approvalRate = simpleApprovalRate_(rows);
    const averageSimilarity = rows.length
      ? rows.reduce(function(sum, row) { return sum + row.similarity; }, 0) / rows.length
      : 0;
    const score = Math.round(averageSimilarity * 60 + approvalRate * 40);
    const amounts = approvals.map(function(row) {
      return row.approvedAmount;
    }).sort(function(a, b) { return a - b; });

    return {
      lenderName: lenderName,
      compositeScore: score,
      observedFit: simpleFitLabel_(score, rows.length),
      confidence: rows.length >= 6 && approvals.length >= 3 ? 'High' : rows.length >= 3 ? 'Moderate' : 'Low',
      historicalCases: rows.length,
      similarCases: rows.length,
      similarApprovals: approvals.length,
      similarDeclines: declines.length,
      observedApprovalRate: rows.length ? Math.round(approvalRate * 100) + '%' : 'N/A',
      lowApprovedAmount: amounts.length ? amounts[0] : '',
      medianApprovedAmount: amounts.length ? median_(amounts) : '',
      highApprovedAmount: amounts.length ? amounts[amounts.length - 1] : '',
      reasoning: approvals.length + ' of ' + rows.length + ' closest training cases were approved or conditional.',
      risks: unique_(declines.map(function(row) { return row.declineReason; }).filter(Boolean)).slice(0, 4),
      conditions: []
    };
  }).sort(function(a, b) {
    return b.compositeScore - a.compositeScore;
  });
}

function simpleDecision_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.indexOf('approv') >= 0) return 'Approved';
  if (text.indexOf('condition') >= 0) return 'Conditional';
  if (text.indexOf('declin') >= 0 || text.indexOf('reject') >= 0) return 'Declined';
  return '';
}

function simpleFitLabel_(score, cases) {
  if (cases < 2) return 'Insufficient history';
  return score >= 80 ? 'Strong fit' :
    score >= 68 ? 'Good fit' :
    score >= 55 ? 'Caution' : 'Weak fit';
}

function simpleConfidenceLabel_(score) {
  return score >= 80 ? 'High' : score >= 60 ? 'Moderate' : 'Low';
}

function simplePeriodMatches_(left, right) {
  if (sameText_(left, right)) return true;
  const clean = function(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  return clean(left) === clean(right);
}

function getProductionModelStatus() {
  return {
    modelVersion: VFC_SIMPLE_CONFIG.MODEL_VERSION,
    activeLayers: 1,
    amountSource: 'Historical Training Data plus validated current banking checks',
    openAIChangesAmount: false,
    patternLearningActive: false,
    regressionFloorActive: false,
    termSizingActive: false,
    shadowModelActive: false,
    recurringDebtExtractionActive: typeof getValidatedBankingFeatures_ === 'function',
    recurringDebtChangesFormula: false,
    legacySheetCleanupActive: false
  };
}
