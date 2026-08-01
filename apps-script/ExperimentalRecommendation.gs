const VFC_EXPERIMENTAL_CONFIG = {
  MODEL_VERSION: 'VFC-EXPERIMENTAL-SHEETS-1.0',
  MAX_CASES_PER_LENDER: 12,
  MAX_AMOUNT_CASES: 8,
  MIN_SIMILARITY: 0.35,
  ROUNDING: 500,
  MAX_AVERAGE_MONTHLY_DEPOSITS: 5000000,
  MAX_TOTAL_DEPOSITS: 100000000,
  MAX_APPROVED_AMOUNT: 5000000
};

/**
 * Separate experimental recommendation.
 *
 * Reads the existing Google Sheets directly:
 * - Training Records
 * - Observed Lender Behaviour
 * - Structured Features
 *
 * This file is read-only. It does not write to a sheet, create a sheet, call
 * OpenAI, or change the production "Our Max" calculation.
 */
function generateExperimentalRecommendationSafe(companyOrRequest, requestedPeriod) {
  const request = vfcExpNormalizeRequest_(companyOrRequest, requestedPeriod);
  const featureRows = vfcExpReadSheetObjects_('Structured Features');
  const current = vfcExpFindCurrentFeature_(featureRows, request.companyName, request.period);

  if (!current) {
    throw new Error(
      'No Structured Features record was found for "' + request.companyName +
      '". Upload the statements first so Structured Features is updated.'
    );
  }

  const currentValidation = vfcExpValidateFeature_(current);
  if (!currentValidation.valid) {
    throw new Error(
      'The current Structured Features record failed the data-quality check: ' +
      currentValidation.reasons.join('; ') + '. Correct the extracted figures before using the experimental model.'
    );
  }

  const outcomeRead = vfcExpReadUniqueOutcomes_();
  if (!outcomeRead.uniqueOutcomes.length) {
    throw new Error('No historical outcomes were found in Training Records or Observed Lender Behaviour.');
  }

  const featureIndex = vfcExpBuildFeatureIndex_(featureRows);
  const built = vfcExpBuildTrainingCases_(
    current,
    outcomeRead.uniqueOutcomes,
    featureIndex,
    request.companyName,
    current.period || request.period
  );

  if (!built.validCases.length) {
    throw new Error('No valid historical cases remained after matching outcomes to Structured Features.');
  }

  const lenderModels = vfcExpBuildLenderModels_(current, built.validCases);
  const eligible = lenderModels.filter(function(model) {
    return model.amountCases > 0;
  });

  const pooledAmount = vfcExpPredictAmount_(
    built.validCases.filter(function(row) {
      return row.isPositive && row.approvedAmount > 0;
    }).slice(0, VFC_EXPERIMENTAL_CONFIG.MAX_AMOUNT_CASES)
  );

  const best = eligible.length ? eligible[0] : lenderModels[0] || null;
  let recommendedAmount = best && best.predictedAmount > 0
    ? best.predictedAmount
    : pooledAmount.amount;

  recommendedAmount = vfcExpRound_(
    Math.max(0, recommendedAmount),
    VFC_EXPERIMENTAL_CONFIG.ROUNDING
  );

  const confidenceScore = vfcExpConfidenceScore_(
    best,
    current,
    built.validCases.length
  );

  const closestCases = built.validCases.slice(0, 10).map(function(row) {
    return {
      companyName: row.companyName,
      period: row.period,
      lenderName: row.lenderName,
      decision: row.decision,
      similarityScore: Math.round(row.similarity * 100),
      approvedAmount: row.approvedAmount || 0,
      depositAdjustedAmount: row.adjustedAmount > 0
        ? vfcExpRound_(row.adjustedAmount, VFC_EXPERIMENTAL_CONFIG.ROUNDING)
        : 0
    };
  });

  return JSON.parse(JSON.stringify({
    ok: true,
    modelVersion: VFC_EXPERIMENTAL_CONFIG.MODEL_VERSION,
    productionModelAffected: false,
    companyName: request.companyName,
    period: current.period || request.period,
    aiExperimentalRecommendation: {
      recommendedAmount: recommendedAmount,
      recommendedLender: best ? best.lenderName : '',
      approvalProbability: best ? best.approvalProbability : 0,
      confidence: vfcExpConfidenceLabel_(confidenceScore),
      confidenceScore: confidenceScore,
      explanation: best
        ? 'The experimental amount is based on approved or conditional historical cases for ' +
          best.lenderName + ', adjusted for the current company’s average monthly deposits. ' +
          'Declines affect approval probability but are not treated as zero-dollar approvals.'
        : 'The experimental amount is based on pooled approved historical cases.'
    },
    currentBankingProfile: {
      averageMonthlyDeposits: vfcExpNumber_(current.averageMonthlyDeposits),
      depositWithdrawalRatio: vfcExpNumber_(current.depositWithdrawalRatio),
      nsfPerMonth: vfcExpNsfPerMonth_(current),
      negativeBalanceFlag: vfcExpFlag_(current.negativeBalanceFlag),
      mcaPaymentFlag: vfcExpFlag_(current.mcaPaymentFlag),
      monthsCovered: vfcExpNumber_(current.monthsCovered),
      statementCount: vfcExpNumber_(current.statementCount)
    },
    trainingDataRead: {
      rawOutcomeRows: outcomeRead.rawCount,
      uniqueOutcomes: outcomeRead.uniqueOutcomes.length,
      validMatchedCases: built.validCases.length,
      ignoredCases: built.ignoredCases.length,
      lendersModelled: lenderModels.length
    },
    lenderModels: lenderModels,
    closestCases: closestCases,
    ignoredCaseSummary: vfcExpIgnoredSummary_(built.ignoredCases),
    note: 'Experimental result only. Keep Our Max as the production underwriting result until this model is validated on unseen actual outcomes.'
  }));
}

/** Reads and summarizes the live training dataset without running an assessment. */
function studyExperimentalTrainingData() {
  const featureRows = vfcExpReadSheetObjects_('Structured Features');
  const featureIndex = vfcExpBuildFeatureIndex_(featureRows);
  const outcomeRead = vfcExpReadUniqueOutcomes_();
  const placeholderCurrent = {
    companyName: '__STUDY__',
    period: '__STUDY__',
    averageMonthlyDeposits: 1,
    totalDeposits: 1,
    totalWithdrawals: 1,
    depositWithdrawalRatio: 1,
    nsfCount: 0,
    negativeBalanceFlag: 0,
    mcaPaymentFlag: 0,
    monthsCovered: 6,
    statementCount: 6
  };

  const built = vfcExpBuildTrainingCases_(
    placeholderCurrent,
    outcomeRead.uniqueOutcomes,
    featureIndex,
    '',
    ''
  );

  const lenderMap = {};
  outcomeRead.uniqueOutcomes.forEach(function(row) {
    const lender = row.lenderName || 'Unknown lender';
    if (!lenderMap[lender]) {
      lenderMap[lender] = {
        lenderName: lender,
        cases: 0,
        approved: 0,
        conditional: 0,
        declined: 0,
        approvedAmounts: []
      };
    }
    const item = lenderMap[lender];
    item.cases++;
    if (row.decision === 'Approved') item.approved++;
    else if (row.decision === 'Conditional') item.conditional++;
    else if (row.decision === 'Declined') item.declined++;
    if (row.approvedAmount > 0) item.approvedAmounts.push(row.approvedAmount);
  });

  const lenders = Object.keys(lenderMap).map(function(key) {
    const item = lenderMap[key];
    const positive = item.approved + item.conditional;
    item.approvalRate = item.cases
      ? Math.round(positive / item.cases * 100)
      : 0;
    item.medianApprovedAmount = item.approvedAmounts.length
      ? vfcExpMedian_(item.approvedAmounts)
      : 0;
    item.minimumApprovedAmount = item.approvedAmounts.length
      ? Math.min.apply(null, item.approvedAmounts)
      : 0;
    item.maximumApprovedAmount = item.approvedAmounts.length
      ? Math.max.apply(null, item.approvedAmounts)
      : 0;
    delete item.approvedAmounts;
    return item;
  }).sort(function(a, b) {
    return b.cases - a.cases;
  });

  const decisions = { approved: 0, conditional: 0, declined: 0 };
  outcomeRead.uniqueOutcomes.forEach(function(row) {
    if (row.decision === 'Approved') decisions.approved++;
    else if (row.decision === 'Conditional') decisions.conditional++;
    else if (row.decision === 'Declined') decisions.declined++;
  });

  return JSON.parse(JSON.stringify({
    ok: true,
    modelVersion: VFC_EXPERIMENTAL_CONFIG.MODEL_VERSION,
    sheetsRead: ['Training Records', 'Observed Lender Behaviour', 'Structured Features'],
    rawOutcomeRows: outcomeRead.rawCount,
    uniqueOutcomes: outcomeRead.uniqueOutcomes.length,
    structuredFeatureRows: featureRows.length,
    decisions: decisions,
    lenders: lenders,
    validMatchedCases: built.validCases.length,
    ignoredCases: built.ignoredCases.length,
    ignoredCaseSummary: vfcExpIgnoredSummary_(built.ignoredCases),
    dataQualityWarnings: built.ignoredCases.slice(0, 20).map(function(row) {
      return {
        companyName: row.companyName,
        period: row.period,
        lenderName: row.lenderName,
        reason: row.reason
      };
    }),
    productionModelAffected: false
  }));
}

function getExperimentalRecommendationStatus() {
  return {
    modelVersion: VFC_EXPERIMENTAL_CONFIG.MODEL_VERSION,
    readsExistingSheetsAutomatically: true,
    writesToSheets: false,
    callsOpenAI: false,
    changesOurMax: false,
    sourceSheets: ['Training Records', 'Observed Lender Behaviour', 'Structured Features']
  };
}

function vfcExpBuildLenderModels_(current, validCases) {
  const groups = {};
  validCases.forEach(function(row) {
    const lender = row.lenderName || 'Unknown lender';
    if (!groups[lender]) groups[lender] = [];
    groups[lender].push(row);
  });

  return Object.keys(groups).map(function(lenderName) {
    const rows = groups[lenderName].slice().sort(function(a, b) {
      return b.similarity - a.similarity;
    }).slice(0, VFC_EXPERIMENTAL_CONFIG.MAX_CASES_PER_LENDER);

    let weightedPositive = 0;
    let totalWeight = 0;
    rows.forEach(function(row) {
      const weight = Math.pow(Math.max(0.05, row.similarity), 2);
      totalWeight += weight;
      if (row.decision === 'Approved') weightedPositive += weight;
      else if (row.decision === 'Conditional') weightedPositive += weight * 0.70;
    });

    const approvalProbability = totalWeight
      ? Math.round(weightedPositive / totalWeight * 100)
      : 0;
    const amountRows = rows.filter(function(row) {
      return row.isPositive && row.approvedAmount > 0;
    }).slice(0, VFC_EXPERIMENTAL_CONFIG.MAX_AMOUNT_CASES);
    const amountPrediction = vfcExpPredictAmount_(amountRows);
    const averageSimilarity = rows.length
      ? rows.reduce(function(sum, row) {
          return sum + row.similarity;
        }, 0) / rows.length
      : 0;
    const modelScore = Math.round(
      approvalProbability * 0.55 +
      averageSimilarity * 100 * 0.30 +
      Math.min(100, rows.length / 8 * 100) * 0.15
    );
    const confidenceScore = vfcExpLenderConfidence_(rows, amountRows, averageSimilarity);

    const approvedAmounts = amountRows.map(function(row) {
      return row.approvedAmount;
    }).sort(function(a, b) {
      return a - b;
    });

    return {
      lenderName: lenderName,
      modelScore: modelScore,
      approvalProbability: approvalProbability,
      predictedAmount: vfcExpRound_(
        amountPrediction.amount,
        VFC_EXPERIMENTAL_CONFIG.ROUNDING
      ),
      confidence: vfcExpConfidenceLabel_(confidenceScore),
      confidenceScore: confidenceScore,
      comparableCases: rows.length,
      amountCases: amountRows.length,
      averageSimilarity: Math.round(averageSimilarity * 100),
      lowApprovedAmount: approvedAmounts.length ? approvedAmounts[0] : 0,
      medianApprovedAmount: approvedAmounts.length ? vfcExpMedian_(approvedAmounts) : 0,
      highApprovedAmount: approvedAmounts.length
        ? approvedAmounts[approvedAmounts.length - 1]
        : 0,
      closestCases: rows.slice(0, 5).map(function(row) {
        return {
          companyName: row.companyName,
          decision: row.decision,
          approvedAmount: row.approvedAmount || 0,
          similarityScore: Math.round(row.similarity * 100)
        };
      })
    };
  }).sort(function(a, b) {
    if ((b.amountCases > 0) !== (a.amountCases > 0)) {
      return b.amountCases > 0 ? 1 : -1;
    }
    return b.modelScore - a.modelScore;
  });
}

function vfcExpBuildTrainingCases_(current, outcomes, featureIndex, excludeCompany, excludePeriod) {
  const validCases = [];
  const ignoredCases = [];
  const currentDeposits = Math.max(0, vfcExpNumber_(current.averageMonthlyDeposits));

  outcomes.forEach(function(outcome) {
    if (
      excludeCompany &&
      vfcExpSame_(outcome.companyName, excludeCompany) &&
      vfcExpPeriodSame_(outcome.period, excludePeriod)
    ) {
      return;
    }

    const key = vfcExpKey_(outcome.companyName, outcome.period);
    const feature = featureIndex[key];
    if (!feature) {
      ignoredCases.push({
        companyName: outcome.companyName,
        period: outcome.period,
        lenderName: outcome.lenderName,
        reason: 'No matching Structured Features row'
      });
      return;
    }

    const validation = vfcExpValidateFeature_(feature);
    if (!validation.valid) {
      ignoredCases.push({
        companyName: outcome.companyName,
        period: outcome.period,
        lenderName: outcome.lenderName,
        reason: validation.reasons.join('; ')
      });
      return;
    }

    if (
      outcome.isPositive &&
      (!outcome.approvedAmount || outcome.approvedAmount > VFC_EXPERIMENTAL_CONFIG.MAX_APPROVED_AMOUNT)
    ) {
      ignoredCases.push({
        companyName: outcome.companyName,
        period: outcome.period,
        lenderName: outcome.lenderName,
        reason: 'Positive outcome has a missing or unreasonable approved amount'
      });
      return;
    }

    const similarity = vfcExpSimilarity_(current, feature);
    if (similarity < VFC_EXPERIMENTAL_CONFIG.MIN_SIMILARITY) return;

    const historicalDeposits = vfcExpNumber_(feature.averageMonthlyDeposits);
    const depositRatio = historicalDeposits > 0 && currentDeposits > 0
      ? vfcExpClamp_(currentDeposits / historicalDeposits, 0.60, 1.50)
      : 1;

    validCases.push({
      companyName: outcome.companyName,
      period: outcome.period,
      lenderName: outcome.lenderName,
      decision: outcome.decision,
      approvedAmount: outcome.approvedAmount,
      declineReason: outcome.declineReason,
      isPositive: outcome.isPositive,
      similarity: similarity,
      adjustedAmount: outcome.isPositive && outcome.approvedAmount > 0
        ? outcome.approvedAmount * depositRatio
        : 0
    });
  });

  validCases.sort(function(a, b) {
    return b.similarity - a.similarity;
  });

  return { validCases: validCases, ignoredCases: ignoredCases };
}

function vfcExpPredictAmount_(rows) {
  if (!rows || !rows.length) return { amount: 0, weightedAverage: 0, weightedMedian: 0 };
  let total = 0;
  let weightTotal = 0;
  const values = [];

  rows.forEach(function(row) {
    const weight = Math.pow(Math.max(0.05, row.similarity), 2) *
      (row.decision === 'Conditional' ? 0.85 : 1);
    total += row.adjustedAmount * weight;
    weightTotal += weight;
    values.push({ value: row.adjustedAmount, weight: weight });
  });

  const weightedAverage = weightTotal ? total / weightTotal : 0;
  const weightedMedian = vfcExpWeightedMedian_(values);
  return {
    amount: weightedMedian * 0.65 + weightedAverage * 0.35,
    weightedAverage: weightedAverage,
    weightedMedian: weightedMedian
  };
}

function vfcExpReadUniqueOutcomes_() {
  const sheetNames = ['Training Records', 'Observed Lender Behaviour'];
  const raw = [];

  sheetNames.forEach(function(sheetName) {
    vfcExpReadSheetObjects_(sheetName).forEach(function(row) {
      const decision = vfcExpDecision_(row.decision || row.finalResult);
      const approvedAmount = Math.max(0, vfcExpNumber_(
        row.approvedAmount || row.fundedAmount
      ));
      if (!row.companyName || !row.lenderName || !decision) return;
      raw.push({
        companyName: String(row.companyName || '').trim(),
        period: String(row.period || row.detectedPeriod || '').trim(),
        lenderName: String(row.lenderName || '').trim(),
        decision: decision,
        approvedAmount: approvedAmount,
        declineReason: String(row.declineReason || '').trim(),
        isPositive: decision === 'Approved' || decision === 'Conditional'
      });
    });
  });

  const seen = {};
  const uniqueOutcomes = raw.filter(function(row) {
    const key = [
      row.companyName,
      row.period,
      row.lenderName,
      row.decision,
      row.approvedAmount,
      row.declineReason
    ].map(function(value) {
      return String(value || '').trim().toLowerCase();
    }).join('|');
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });

  return { rawCount: raw.length, uniqueOutcomes: uniqueOutcomes };
}

function vfcExpBuildFeatureIndex_(featureRows) {
  const index = {};
  featureRows.forEach(function(row) {
    if (!row.companyName) return;
    const key = vfcExpKey_(row.companyName, row.period);
    if (!index[key]) {
      index[key] = row;
      return;
    }
    const oldDate = vfcExpDateValue_(index[key].updatedAt);
    const newDate = vfcExpDateValue_(row.updatedAt);
    if (newDate >= oldDate) index[key] = row;
  });
  return index;
}

function vfcExpFindCurrentFeature_(featureRows, companyName, requestedPeriod) {
  const exact = featureRows.filter(function(row) {
    return vfcExpSame_(row.companyName, companyName) &&
      (!requestedPeriod || vfcExpPeriodSame_(row.period, requestedPeriod));
  });
  if (exact.length) {
    exact.sort(function(a, b) {
      return vfcExpDateValue_(b.updatedAt) - vfcExpDateValue_(a.updatedAt);
    });
    return exact[0];
  }

  const companyRows = featureRows.filter(function(row) {
    return vfcExpSame_(row.companyName, companyName);
  });
  if (!companyRows.length) return null;
  companyRows.sort(function(a, b) {
    return vfcExpDateValue_(b.updatedAt) - vfcExpDateValue_(a.updatedAt);
  });
  return companyRows[0];
}

function vfcExpValidateFeature_(feature) {
  const reasons = [];
  const averageDeposits = vfcExpNumber_(feature.averageMonthlyDeposits);
  const totalDeposits = vfcExpNumber_(feature.totalDeposits);
  const ratio = vfcExpNumber_(feature.depositWithdrawalRatio);
  const months = vfcExpNumber_(feature.monthsCovered);
  const statements = vfcExpNumber_(feature.statementCount);

  if (!(averageDeposits > 0)) reasons.push('average monthly deposits are missing or zero');
  if (averageDeposits > VFC_EXPERIMENTAL_CONFIG.MAX_AVERAGE_MONTHLY_DEPOSITS) {
    reasons.push('average monthly deposits exceed the data-quality limit');
  }
  if (totalDeposits > VFC_EXPERIMENTAL_CONFIG.MAX_TOTAL_DEPOSITS) {
    reasons.push('total deposits exceed the data-quality limit');
  }
  if (!(ratio >= 0 && ratio <= 5)) reasons.push('deposit-withdrawal ratio is outside the valid range');
  if (!(months >= 1 && months <= 36)) reasons.push('months covered is outside the valid range');
  if (!(statements >= 1 && statements <= 48)) reasons.push('statement count is outside the valid range');

  if (averageDeposits > 0 && totalDeposits > 0 && months > 0) {
    const expected = averageDeposits * months;
    const consistency = expected > 0 ? totalDeposits / expected : 1;
    if (consistency < 0.40 || consistency > 2.50) {
      reasons.push('total and average deposits are internally inconsistent');
    }
  }

  return { valid: reasons.length === 0, reasons: reasons };
}

function vfcExpSimilarity_(a, b) {
  return vfcExpClamp_(
    vfcExpNumericSimilarity_(a.averageMonthlyDeposits, b.averageMonthlyDeposits, 1000) * 0.42 +
    vfcExpNumericSimilarity_(a.depositWithdrawalRatio, b.depositWithdrawalRatio, 1) * 0.18 +
    vfcExpNumericSimilarity_(vfcExpNsfPerMonth_(a), vfcExpNsfPerMonth_(b), 1) * 0.14 +
    (vfcExpFlag_(a.negativeBalanceFlag) === vfcExpFlag_(b.negativeBalanceFlag) ? 1 : 0) * 0.10 +
    (vfcExpFlag_(a.mcaPaymentFlag) === vfcExpFlag_(b.mcaPaymentFlag) ? 1 : 0) * 0.10 +
    vfcExpNumericSimilarity_(a.monthsCovered, b.monthsCovered, 6) * 0.06,
    0,
    1
  );
}

function vfcExpConfidenceScore_(best, current, totalCases) {
  if (!best) return 0;
  return vfcExpClamp_(Math.round(
    Math.min(100, best.amountCases / 6 * 100) * 0.35 +
    Math.min(100, best.averageSimilarity) * 0.30 +
    Math.min(100, best.comparableCases / 8 * 100) * 0.20 +
    vfcExpCurrentDataQuality_(current) * 0.15
  ), 0, 100);
}

function vfcExpLenderConfidence_(rows, amountRows, averageSimilarity) {
  return vfcExpClamp_(Math.round(
    Math.min(100, amountRows.length / 6 * 100) * 0.45 +
    Math.min(100, rows.length / 8 * 100) * 0.25 +
    averageSimilarity * 100 * 0.30
  ), 0, 100);
}

function vfcExpCurrentDataQuality_(current) {
  let score = 100;
  if (vfcExpNumber_(current.monthsCovered) < 6) score -= 15;
  if (vfcExpNumber_(current.statementCount) < 4) score -= 15;
  if (!vfcExpNumber_(current.totalWithdrawals)) score -= 15;
  if (!vfcExpNumber_(current.averageMonthlyDeposits)) score -= 40;
  return vfcExpClamp_(score, 0, 100);
}

function vfcExpIgnoredSummary_(ignoredCases) {
  const counts = {};
  (ignoredCases || []).forEach(function(row) {
    const reason = row.reason || 'Unknown reason';
    counts[reason] = (counts[reason] || 0) + 1;
  });
  return Object.keys(counts).map(function(reason) {
    return { reason: reason, cases: counts[reason] };
  }).sort(function(a, b) {
    return b.cases - a.cases;
  });
}

function vfcExpReadSheetObjects_(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(vfcExpNormalizeHeader_);
  return values.slice(1).filter(function(row) {
    return row.some(function(cell) {
      return String(cell === null || cell === undefined ? '' : cell).trim() !== '';
    });
  }).map(function(row) {
    const object = {};
    headers.forEach(function(header, index) {
      object[header] = row[index];
    });
    return object;
  });
}

function vfcExpNormalizeRequest_(companyOrRequest, requestedPeriod) {
  let companyName = '';
  let period = requestedPeriod || '';
  if (companyOrRequest && typeof companyOrRequest === 'object') {
    companyName = companyOrRequest.companyName || companyOrRequest.company || '';
    period = companyOrRequest.period || companyOrRequest.detectedPeriod || period;
  } else {
    companyName = companyOrRequest || '';
  }
  companyName = String(companyName || '').trim();
  period = String(period || '').trim();
  if (!companyName || /^(undefined|null)$/i.test(companyName)) {
    throw new Error('Company name is required.');
  }
  return { companyName: companyName, period: period };
}

function vfcExpDecision_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.indexOf('condition') >= 0) return 'Conditional';
  if (text.indexOf('approv') >= 0) return 'Approved';
  if (text.indexOf('declin') >= 0 || text.indexOf('reject') >= 0) return 'Declined';
  return '';
}

function vfcExpNsfPerMonth_(feature) {
  return vfcExpNumber_(feature.nsfCount) /
    Math.max(1, vfcExpNumber_(feature.monthsCovered));
}

function vfcExpNumericSimilarity_(left, right, floorScale) {
  const a = vfcExpNumber_(left);
  const b = vfcExpNumber_(right);
  const scale = Math.max(Math.abs(a), Math.abs(b), floorScale || 1);
  return vfcExpClamp_(1 - Math.abs(a - b) / scale, 0, 1);
}

function vfcExpWeightedMedian_(rows) {
  if (!rows || !rows.length) return 0;
  const sorted = rows.slice().sort(function(a, b) {
    return a.value - b.value;
  });
  const totalWeight = sorted.reduce(function(sum, row) {
    return sum + row.weight;
  }, 0);
  let running = 0;
  for (let i = 0; i < sorted.length; i++) {
    running += sorted[i].weight;
    if (running >= totalWeight / 2) return sorted[i].value;
  }
  return sorted[sorted.length - 1].value;
}

function vfcExpMedian_(values) {
  if (!values || !values.length) return 0;
  const sorted = values.slice().map(vfcExpNumber_).sort(function(a, b) {
    return a - b;
  });
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function vfcExpNumber_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const cleaned = String(value === null || value === undefined ? '' : value)
    .replace(/[^0-9.\-]/g, '');
  const number = parseFloat(cleaned);
  return isFinite(number) ? number : 0;
}

function vfcExpFlag_(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  return /yes|true|detected|negative|1/i.test(String(value || '')) ? 1 : 0;
}

function vfcExpDateValue_(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  return isNaN(date.getTime()) ? 0 : date.getTime();
}

function vfcExpKey_(companyName, period) {
  return vfcExpCleanKey_(companyName) + '|' + vfcExpCleanKey_(period);
}

function vfcExpSame_(left, right) {
  return String(left || '').trim().toLowerCase() ===
    String(right || '').trim().toLowerCase();
}

function vfcExpPeriodSame_(left, right) {
  return vfcExpCleanKey_(left) === vfcExpCleanKey_(right);
}

function vfcExpCleanKey_(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function vfcExpNormalizeHeader_(header) {
  return String(header || '').trim()
    .replace(/[^a-zA-Z0-9]+(.)/g, function(match, character) {
      return character.toUpperCase();
    })
    .replace(/^[A-Z]/, function(character) {
      return character.toLowerCase();
    });
}

function vfcExpClamp_(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function vfcExpRound_(value, nearest) {
  return Math.round(vfcExpNumber_(value) / nearest) * nearest;
}

function vfcExpConfidenceLabel_(score) {
  return score >= 80 ? 'High' : score >= 60 ? 'Moderate' : 'Low';
}
