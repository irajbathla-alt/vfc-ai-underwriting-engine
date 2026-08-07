const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-1.0',
  SIGNAL_PREFIX: 'VFC_DEBT_V1:',
  ACTIVE_LOOKBACK_DAYS: 45,
  CONFIRMED_DEBT_CATEGORIES: ['MCA','TERM_LOAN','COMMERCIAL_LOAN','LOC','LEASE_FINANCE'],
  OTHER_OBLIGATION_CATEGORIES: ['INSURANCE_FINANCE','CREDIT_CARD','OTHER_RECURRING_PAD'],
  FINANCING_CREDIT_CATEGORIES: ['MCA_ADVANCE','LOAN_ADVANCE','COMMERCIAL_LOAN_ADVANCE','LOC_ADVANCE','UNKNOWN_FINANCING_CREDIT']
};

/**
 * Best-effort refresh of debt / PAD signals for one uploaded company-period.
 * Uses the existing PDF files and stores structured debt signals inside the
 * existing "Possible MCA Or Loan Payments" column. No new Sheet is created.
 */
function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const request = vfcBiqNormalizeRequest_(companyOrRequest, requestedPeriod);
    const period = request.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(request.companyName, request.period)
      : request.period);
    return vfcBiqRefreshDebtSignals_(request.companyName, period);
  } catch (error) {
    return {
      ok: false,
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      message: String(error && error.message || error),
      filesAnalyzed: 0,
      filesSkipped: 0,
      errors: [String(error && error.message || error)]
    };
  }
}

/** Manual Apps Script test / backfill for the latest uploaded company-period. */
function refreshLatestDebtSignals() {
  const rows = getSheetObjects_('PDF Summaries');
  if (!rows.length) throw new Error('PDF Summaries has no records.');
  const latest = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({
    companyName: latest.companyName,
    period: latest.detectedPeriod
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    validatesStatementMonths: true,
    deduplicatesStatementSummaries: true,
    extractsRecurringDebtPayments: true,
    extractsRecurringPads: true,
    extractsFinancingCredits: true,
    createsNewSheets: false,
    changesProductionFormula: false
  };
}

/**
 * Returns the existing banking feature object with validated statement-period
 * arithmetic and an attached debt/PAD profile. It does not apply a new loan
 * sizing formula.
 */
function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName, period)
    : (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName, period) : null);
  if (!base) return null;

  const audit = vfcBiqBuildStatementAudit_(companyName, period, base);
  if (!audit.uniqueRows.length) return base;

  const debtProfile = vfcBiqAggregateDebtProfile_(audit.uniqueRows, audit.monthsCovered, audit.latestStatementDate);
  const grossMonthlyDeposits = audit.monthsCovered > 0
    ? audit.totalDeposits / audit.monthsCovered
    : 0;
  const operatingDeposits = Math.max(0, audit.totalDeposits - debtProfile.financingCreditsTotal);
  const operatingMonthlyDeposits = audit.monthsCovered > 0
    ? operatingDeposits / audit.monthsCovered
    : grossMonthlyDeposits;

  const warnings = audit.warnings.slice();
  const oldAverage = vfcBiqNumber_(base.averageMonthlyDeposits);
  if (oldAverage > 0 && grossMonthlyDeposits > 0) {
    const variance = Math.abs(oldAverage - grossMonthlyDeposits) / grossMonthlyDeposits;
    if (variance >= 0.05) {
      warnings.push(
        'Average monthly deposits were recalculated from distinct statement periods: ' +
        vfcBiqRound_(oldAverage, 1) + ' -> ' + vfcBiqRound_(grossMonthlyDeposits, 1) + '.'
      );
    }
  }
  if (debtProfile.financingCreditsTotal > 0) {
    warnings.push('Financing credits were detected and shown separately from estimated operating deposits.');
  }

  const structuredDebtSignalsAvailable = audit.uniqueRows.some(function(row) {
    return !!vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
  });
  const mcaOrLoanDetected = structuredDebtSignalsAvailable
    ? (debtProfile.activeDebtObligations.length > 0 ? 1 : 0)
    : vfcBiqFlag_(base.mcaPaymentFlag);

  return Object.assign({}, base, {
    statementCount: audit.uniqueRows.length,
    monthsCovered: audit.monthsCovered,
    totalDeposits: vfcBiqRound_(audit.totalDeposits, 0.01),
    averageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
    totalWithdrawals: vfcBiqRound_(audit.totalWithdrawals, 0.01),
    depositWithdrawalRatio: vfcBiqRound_(audit.totalWithdrawals > 0 ? audit.totalDeposits / audit.totalWithdrawals : 0, 0.01),
    nsfCount: audit.nsfCount,
    nsfPerMonth: vfcBiqRound_(audit.nsfCount / Math.max(1, audit.monthsCovered), 0.01),
    negativeBalanceFlag: audit.negativeBalanceFlag,
    mcaPaymentFlag: mcaOrLoanDetected,
    monthlyDeposits: audit.monthlyDepositRates,
    monthlyWithdrawals: audit.monthlyWithdrawalRates,
    depositVolatility: vfcBiqRound_(vfcBiqCoefficientOfVariation_(audit.monthlyDepositRates), 0.01),
    depositTrend: vfcBiqRound_(vfcBiqTrend_(audit.monthlyDepositRates), 0.01),
    estimatedOperatingTotalDeposits: vfcBiqRound_(operatingDeposits, 0.01),
    estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
    detectedFinancingCredits: vfcBiqRound_(debtProfile.financingCreditsTotal, 0.01),
    existingMonthlyDebtService: vfcBiqRound_(debtProfile.confirmedMonthlyDebtService, 0.01),
    otherRecurringMonthlyObligations: vfcBiqRound_(debtProfile.otherRecurringMonthlyObligations, 0.01),
    debtServiceToDepositsRatio: grossMonthlyDeposits > 0
      ? vfcBiqRound_(debtProfile.confirmedMonthlyDebtService / grossMonthlyDeposits, 0.0001)
      : 0,
    debtProfile: debtProfile,
    inputQualityAudit: {
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      rawSummaryRows: audit.rawRowCount,
      distinctStatementRows: audit.uniqueRows.length,
      duplicateRowsRemoved: audit.duplicateRowsRemoved,
      validatedMonthsCovered: audit.monthsCovered,
      originalMonthsCovered: vfcBiqNumber_(base.monthsCovered),
      grossAverageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
      estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
      structuredDebtSignalsAvailable: structuredDebtSignalsAvailable,
      warnings: warnings
    }
  });
}

function vfcBiqRefreshDebtSignals_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PDF Summaries');
  if (!sheet) throw new Error('Missing PDF Summaries sheet.');

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) throw new Error('PDF Summaries has no statement rows.');
  const headers = values[0].map(function(value) { return normalizeHeader_(value); });
  const companyIndex = headers.indexOf('companyName');
  const periodIndex = headers.indexOf('detectedPeriod');
  const uploadIdIndex = headers.indexOf('uploadId');
  const fileNameIndex = headers.indexOf('fileName');
  const signalIndex = headers.indexOf('possibleMcaOrLoanPayments');
  if (companyIndex < 0 || periodIndex < 0 || uploadIdIndex < 0 || signalIndex < 0) {
    throw new Error('PDF Summaries is missing required columns for debt-signal extraction.');
  }

  const uploads = getSheetObjects_('Uploads');
  const uploadById = {};
  uploads.forEach(function(row) {
    if (row.uploadId) uploadById[String(row.uploadId)] = row;
  });

  let filesAnalyzed = 0;
  let filesSkipped = 0;
  const errors = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!sameText_(row[companyIndex], companyName) || !sameText_(row[periodIndex], period)) continue;

    const existing = String(row[signalIndex] || '').trim();
    if (vfcBiqParseSignalCell_(existing)) {
      filesSkipped++;
      continue;
    }

    const uploadId = String(row[uploadIdIndex] || '').trim();
    const upload = uploadById[uploadId] || null;
    const fileId = upload && upload.fileId ? String(upload.fileId) : '';
    const fileName = String(row[fileNameIndex] || (upload && upload.fileName) || 'statement.pdf');
    if (!fileId) {
      errors.push(fileName + ': upload file ID not found.');
      continue;
    }

    try {
      const text = extractTextFromPdf_(fileId);
      const signals = vfcBiqExtractDebtSignals_(text, fileName);
      const payload = {
        version: 1,
        analyzedAt: new Date().toISOString(),
        fileName: fileName,
        debtPayments: signals.debtPayments,
        financingCredits: signals.financingCredits
      };
      sheet.getRange(i + 1, signalIndex + 1).setValue(
        VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload)
      );
      filesAnalyzed++;
    } catch (error) {
      errors.push(fileName + ': ' + String(error && error.message || error));
    }
  }

  const features = getValidatedBankingFeatures_(companyName, period);
  return {
    ok: errors.length === 0,
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    filesAnalyzed: filesAnalyzed,
    filesSkipped: filesSkipped,
    errors: errors,
    debtProfile: features && features.debtProfile ? features.debtProfile : {},
    inputQualityAudit: features && features.inputQualityAudit ? features.inputQualityAudit : {}
  };
}

function vfcBiqExtractDebtSignals_(text, fileName) {
  const safeText = vfcBiqRedactAccountNumbers_(String(text || '')).substring(0, 60000);
  const prompt = [
    'You are extracting existing financing obligations from one business bank statement.',
    'Return JSON only with two arrays: debt_payments and financing_credits.',
    'For debt_payments return every transaction that is explicitly a loan payment, MCA/merchant advance payment, commercial loan payment, line-of-credit payment, lease-finance payment, insurance-finance payment, credit-card payment, tax/government PAD, or other recurring PAD where the financing purpose is unclear.',
    'Each debt_payments item must contain: date, description, counterparty, amount, category, confidence.',
    'Allowed payment categories: MCA, TERM_LOAN, COMMERCIAL_LOAN, LOC, LEASE_FINANCE, INSURANCE_FINANCE, CREDIT_CARD, TAX_GOVERNMENT, OTHER_RECURRING_PAD, UNKNOWN.',
    'For financing_credits return credits that clearly look like proceeds from an MCA, loan, commercial finance facility, or line of credit.',
    'Each financing_credits item must contain: date, description, counterparty, amount, category, confidence.',
    'Allowed financing credit categories: MCA_ADVANCE, LOAN_ADVANCE, COMMERCIAL_LOAN_ADVANCE, LOC_ADVANCE, UNKNOWN_FINANCING_CREDIT.',
    'Confidence must be High, Moderate, or Low.',
    'Use the transaction date and exact amount shown. Do not infer an outstanding balance or payoff amount.',
    'Do not classify normal sales/card settlements, cash deposits, ordinary customer e-transfers, supplier payments, payroll, or ordinary expenses as financing.',
    'Classify CRA/CCRA tax PADs as TAX_GOVERNMENT, not debt.',
    'A generic PAD may be OTHER_RECURRING_PAD when the statement does not prove it is financing.',
    'If there are no qualifying items return empty arrays.',
    'File: ' + fileName,
    'Statement text:',
    safeText
  ].join('\n');

  const result = callOpenAIJson_(prompt) || {};
  return {
    debtPayments: vfcBiqSanitizeSignals_(result.debt_payments, false),
    financingCredits: vfcBiqSanitizeSignals_(result.financing_credits, true)
  };
}

function vfcBiqSanitizeSignals_(items, isCredit) {
  if (!Array.isArray(items)) return [];
  const allowed = isCredit
    ? VFC_BANKING_INPUT_CONFIG.FINANCING_CREDIT_CATEGORIES
    : VFC_BANKING_INPUT_CONFIG.CONFIRMED_DEBT_CATEGORIES.concat(
        VFC_BANKING_INPUT_CONFIG.OTHER_OBLIGATION_CATEGORIES,
        ['TAX_GOVERNMENT','UNKNOWN']
      );

  return items.map(function(item) {
    item = item || {};
    const amount = Math.max(0, vfcBiqNumber_(item.amount));
    const category = String(item.category || 'UNKNOWN').trim().toUpperCase();
    const confidence = /high/i.test(item.confidence) ? 'High' : /moderate|medium/i.test(item.confidence) ? 'Moderate' : 'Low';
    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '').trim().substring(0, 180),
      counterparty: String(item.counterparty || '').trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      category: allowed.indexOf(category) >= 0 ? category : (isCredit ? 'UNKNOWN_FINANCING_CREDIT' : 'UNKNOWN'),
      confidence: confidence
    };
  }).filter(function(item) {
    return item.amount > 0 && (item.description || item.counterparty);
  });
}

function vfcBiqBuildStatementAudit_(companyName, period, base) {
  const rawRows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period));
  });
  const seen = {};
  const uniqueRows = [];

  rawRows.forEach(function(row) {
    const start = vfcBiqIsoDate_(row.statementStartDate);
    const end = vfcBiqIsoDate_(row.statementEndDate);
    const deposits = vfcBiqNumber_(row.totalDeposits);
    const withdrawals = vfcBiqNumber_(row.totalWithdrawals);
    const fileName = String(row.fileName || '').trim().toLowerCase();
    const key = start && end
      ? [start, end, deposits.toFixed(2), withdrawals.toFixed(2)].join('|')
      : [fileName, deposits.toFixed(2), withdrawals.toFixed(2)].join('|');
    if (seen[key]) return;
    seen[key] = true;
    uniqueRows.push(row);
  });

  uniqueRows.sort(function(a, b) {
    const aDate = vfcBiqDate_(a.statementEndDate) || vfcBiqDate_(a.statementStartDate);
    const bDate = vfcBiqDate_(b.statementEndDate) || vfcBiqDate_(b.statementStartDate);
    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;
    return aDate.getTime() - bDate.getTime();
  });

  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let nsfCount = 0;
  let negativeBalanceFlag = 0;
  const statementRates = [];
  const starts = [];
  const ends = [];
  const monthKeys = {};

  uniqueRows.forEach(function(row, index) {
    const start = vfcBiqDate_(row.statementStartDate);
    const end = vfcBiqDate_(row.statementEndDate);
    if (start) starts.push(start);
    if (end) ends.push(end);
    const deposits = Math.max(0, vfcBiqNumber_(row.totalDeposits));
    const withdrawals = Math.max(0, vfcBiqNumber_(row.totalWithdrawals));
    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    nsfCount += Math.max(0, vfcBiqNumber_(row.nsfCount));
    if (vfcBiqFlag_(row.negativeBalanceDetected)) negativeBalanceFlag = 1;

    const durationMonths = start && end
      ? Math.max(1, ((end.getTime() - start.getTime()) / 86400000 + 1) / 30.4375)
      : 1;
    statementRates.push({
      date: end || start || new Date(2000, 0, index + 1),
      deposits: deposits / durationMonths,
      withdrawals: withdrawals / durationMonths
    });

    const monthDate = end || start;
    if (monthDate) {
      const key = monthDate.getUTCFullYear() + '-' + ('0' + (monthDate.getUTCMonth() + 1)).slice(-2);
      monthKeys[key] = true;
    }
  });

  const earliest = starts.length ? new Date(Math.min.apply(null, starts.map(function(d) { return d.getTime(); }))) : null;
  const latest = ends.length ? new Date(Math.max.apply(null, ends.map(function(d) { return d.getTime(); }))) : null;
  const spanMonths = earliest && latest
    ? Math.max(1, Math.round((((latest.getTime() - earliest.getTime()) / 86400000) + 1) / 30.4375))
    : 0;
  const distinctStatementMonths = Object.keys(monthKeys).length;
  const fallbackMonths = Math.max(1, vfcBiqNumber_(base && base.monthsCovered) || uniqueRows.length || 1);
  const monthsCovered = Math.max(1, spanMonths, distinctStatementMonths || 0, spanMonths || distinctStatementMonths ? 0 : fallbackMonths);

  statementRates.sort(function(a, b) { return a.date.getTime() - b.date.getTime(); });
  const monthlyDepositRates = statementRates.map(function(row) { return vfcBiqRound_(row.deposits, 0.01); });
  const monthlyWithdrawalRates = statementRates.map(function(row) { return vfcBiqRound_(row.withdrawals, 0.01); });
  const warnings = [];
  const duplicateRowsRemoved = rawRows.length - uniqueRows.length;
  if (duplicateRowsRemoved > 0) warnings.push(duplicateRowsRemoved + ' duplicate statement summary row(s) were excluded.');
  if (vfcBiqNumber_(base && base.monthsCovered) && vfcBiqNumber_(base.monthsCovered) !== monthsCovered) {
    warnings.push('Months covered corrected from ' + vfcBiqNumber_(base.monthsCovered) + ' to ' + monthsCovered + ' using statement dates.');
  }

  return {
    rawRowCount: rawRows.length,
    uniqueRows: uniqueRows,
    duplicateRowsRemoved: duplicateRowsRemoved,
    monthsCovered: monthsCovered,
    totalDeposits: totalDeposits,
    totalWithdrawals: totalWithdrawals,
    nsfCount: nsfCount,
    negativeBalanceFlag: negativeBalanceFlag,
    monthlyDepositRates: monthlyDepositRates,
    monthlyWithdrawalRates: monthlyWithdrawalRates,
    latestStatementDate: latest,
    warnings: warnings
  };
}

function vfcBiqAggregateDebtProfile_(rows, monthsCovered, latestStatementDate) {
  let payments = [];
  let credits = [];
  (rows || []).forEach(function(row) {
    const payload = vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
    if (!payload) return;
    payments = payments.concat(payload.debtPayments || []);
    credits = credits.concat(payload.financingCredits || []);
  });

  payments = vfcBiqDedupeSignals_(payments);
  credits = vfcBiqDedupeSignals_(credits);

  const groups = {};
  payments.forEach(function(payment) {
    const key = [payment.category, vfcBiqNormalizeCounterparty_(payment.counterparty || payment.description)].join('|');
    if (!groups[key]) groups[key] = [];
    groups[key].push(payment);
  });

  const obligations = Object.keys(groups).map(function(key) {
    const items = groups[key].slice().sort(function(a, b) {
      return (vfcBiqDate_(a.date) || new Date(0)).getTime() - (vfcBiqDate_(b.date) || new Date(0)).getTime();
    });
    const dates = items.map(function(item) { return vfcBiqDate_(item.date); }).filter(Boolean);
    const amounts = items.map(function(item) { return vfcBiqNumber_(item.amount); }).filter(function(n) { return n > 0; });
    const medianAmount = vfcBiqMedian_(amounts);
    const frequency = vfcBiqInferFrequency_(dates, items.length, monthsCovered);
    const monthlyEquivalent = vfcBiqMonthlyEquivalent_(medianAmount, frequency, items.length, monthsCovered);
    const lastDate = dates.length ? dates[dates.length - 1] : null;
    const active = vfcBiqIsActive_(lastDate, latestStatementDate, frequency);
    const confidence = vfcBiqGroupConfidence_(items);
    const category = items[0] ? items[0].category : 'UNKNOWN';
    return {
      counterparty: items[0] ? (items[0].counterparty || items[0].description) : '',
      description: items[0] ? items[0].description : '',
      category: category,
      paymentAmount: vfcBiqRound_(medianAmount, 0.01),
      frequency: frequency,
      monthlyEquivalent: vfcBiqRound_(monthlyEquivalent, 0.01),
      occurrences: items.length,
      firstSeen: dates.length ? Utilities.formatDate(dates[0], 'UTC', 'yyyy-MM-dd') : '',
      lastSeen: lastDate ? Utilities.formatDate(lastDate, 'UTC', 'yyyy-MM-dd') : '',
      active: active,
      confidence: confidence
    };
  }).filter(function(item) {
    return item.paymentAmount > 0;
  });

  obligations.sort(function(a, b) {
    return b.monthlyEquivalent - a.monthlyEquivalent;
  });

  const activeDebt = obligations.filter(function(item) {
    return item.active &&
      VFC_BANKING_INPUT_CONFIG.CONFIRMED_DEBT_CATEGORIES.indexOf(item.category) >= 0 &&
      item.frequency !== 'Observed once' &&
      item.confidence !== 'Low';
  });
  const otherRecurring = obligations.filter(function(item) {
    return item.active &&
      VFC_BANKING_INPUT_CONFIG.OTHER_OBLIGATION_CATEGORIES.indexOf(item.category) >= 0 &&
      item.frequency !== 'Observed once';
  });
  const taxPads = obligations.filter(function(item) {
    return item.active && item.category === 'TAX_GOVERNMENT';
  });

  const confirmedMonthlyDebtService = activeDebt.reduce(function(sum, item) {
    return sum + item.monthlyEquivalent;
  }, 0);
  const otherRecurringMonthlyObligations = otherRecurring.reduce(function(sum, item) {
    return sum + item.monthlyEquivalent;
  }, 0);

  const financingCredits = credits.filter(function(item) {
    return item.confidence !== 'Low' && VFC_BANKING_INPUT_CONFIG.FINANCING_CREDIT_CATEGORIES.indexOf(item.category) >= 0;
  });
  const financingCreditsTotal = financingCredits.reduce(function(sum, item) {
    return sum + vfcBiqNumber_(item.amount);
  }, 0);

  return {
    confirmedMonthlyDebtService: vfcBiqRound_(confirmedMonthlyDebtService, 0.01),
    otherRecurringMonthlyObligations: vfcBiqRound_(otherRecurringMonthlyObligations, 0.01),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxPads,
    allDetectedObligations: obligations,
    financingCredits: financingCredits,
    financingCreditsTotal: vfcBiqRound_(financingCreditsTotal, 0.01),
    note: 'Monthly equivalents are inferred from observed payment frequency. Outstanding balances are not inferred from bank statements.'
  };
}

function vfcBiqParseSignalCell_(value) {
  const text = String(value || '').trim();
  if (text.indexOf(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX) !== 0) return null;
  try {
    const parsed = JSON.parse(text.substring(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      debtPayments: Array.isArray(parsed.debtPayments) ? parsed.debtPayments : [],
      financingCredits: Array.isArray(parsed.financingCredits) ? parsed.financingCredits : []
    };
  } catch (error) {
    return null;
  }
}

function vfcBiqDedupeSignals_(items) {
  const seen = {};
  return (items || []).filter(function(item) {
    const key = [
      vfcBiqIsoDate_(item.date),
      vfcBiqRound_(vfcBiqNumber_(item.amount), 0.01),
      String(item.category || ''),
      vfcBiqNormalizeCounterparty_(item.counterparty || item.description)
    ].join('|').toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function vfcBiqInferFrequency_(dates, occurrences, monthsCovered) {
  if (dates && dates.length >= 2) {
    const intervals = [];
    for (let i = 1; i < dates.length; i++) {
      const days = Math.abs((dates[i].getTime() - dates[i - 1].getTime()) / 86400000);
      if (days > 0) intervals.push(days);
    }
    const medianDays = vfcBiqMedian_(intervals);
    if (medianDays > 0 && medianDays <= 3.5) return 'Business daily';
    if (medianDays <= 10) return 'Weekly';
    if (medianDays <= 20) return 'Biweekly';
    if (medianDays <= 40) return 'Monthly';
    if (medianDays <= 75) return 'Every 2 months';
    return 'Irregular';
  }
  const perMonth = occurrences / Math.max(1, monthsCovered || 1);
  if (perMonth >= 3) return 'Weekly';
  if (perMonth >= 1.5) return 'Biweekly';
  if (perMonth >= 0.65) return 'Monthly';
  return 'Observed once';
}

function vfcBiqMonthlyEquivalent_(amount, frequency, occurrences, monthsCovered) {
  amount = Math.max(0, vfcBiqNumber_(amount));
  if (!amount) return 0;
  if (frequency === 'Business daily') return amount * 21.7;
  if (frequency === 'Weekly') return amount * 4.33;
  if (frequency === 'Biweekly') return amount * 2.17;
  if (frequency === 'Monthly') return amount;
  if (frequency === 'Every 2 months') return amount * 0.5;
  if (frequency === 'Irregular') return amount * occurrences / Math.max(1, monthsCovered || 1);
  return 0;
}

function vfcBiqIsActive_(lastDate, latestStatementDate, frequency) {
  if (!lastDate || !latestStatementDate) return frequency !== 'Observed once';
  const days = (latestStatementDate.getTime() - lastDate.getTime()) / 86400000;
  const allowed = frequency === 'Every 2 months' ? 80 : VFC_BANKING_INPUT_CONFIG.ACTIVE_LOOKBACK_DAYS;
  return days >= -3 && days <= allowed;
}

function vfcBiqGroupConfidence_(items) {
  let score = 0;
  (items || []).forEach(function(item) {
    score += item.confidence === 'High' ? 2 : item.confidence === 'Moderate' ? 1 : 0;
  });
  if (!items || !items.length) return 'Low';
  const avg = score / items.length;
  return avg >= 1.5 ? 'High' : avg >= 0.75 ? 'Moderate' : 'Low';
}

function vfcBiqNormalizeCounterparty_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(payment|payments|loan|business|pad|investment|commercial|loans|eft|deftpy?mt)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
}

function vfcBiqRedactAccountNumbers_(text) {
  return String(text || '')
    .replace(/(account\s*(?:number|no\.?)[^\n:]*[:\s]+)[0-9\s\-]{5,}/ig, '$1[REDACTED]')
    .replace(/\b\d{5}\s+\d{3}[\-\s]\d{3}[\-\s]\d\b/g, '[REDACTED_ACCOUNT]');
}

function vfcBiqNormalizeRequest_(companyOrRequest, requestedPeriod) {
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
  if (!companyName) throw new Error('Company name is required.');
  return { companyName: companyName, period: period };
}

function vfcBiqDate_(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function vfcBiqIsoDate_(value) {
  const date = vfcBiqDate_(value);
  return date ? Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd') : '';
}

function vfcBiqNumber_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const number = parseFloat(String(value || '').replace(/[^0-9.\-]/g, ''));
  return isFinite(number) ? number : 0;
}

function vfcBiqFlag_(value) {
  return /^(1|true|yes|detected)$/i.test(String(value || '').trim()) ? 1 : 0;
}

function vfcBiqRound_(value, step) {
  const number = vfcBiqNumber_(value);
  const increment = vfcBiqNumber_(step) || 1;
  return Math.round(number / increment) * increment;
}

function vfcBiqMedian_(values) {
  const numbers = (values || []).map(vfcBiqNumber_).filter(function(value) { return value > 0; }).sort(function(a, b) { return a - b; });
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function vfcBiqCoefficientOfVariation_(values) {
  const numbers = (values || []).map(vfcBiqNumber_).filter(function(value) { return value >= 0; });
  if (!numbers.length) return 1;
  const avg = numbers.reduce(function(sum, value) { return sum + value; }, 0) / numbers.length;
  if (!avg) return 1;
  const variance = numbers.reduce(function(sum, value) {
    return sum + Math.pow(value - avg, 2);
  }, 0) / numbers.length;
  return Math.sqrt(variance) / avg;
}

function vfcBiqTrend_(values) {
  const numbers = (values || []).map(vfcBiqNumber_);
  if (numbers.length < 2) return 0;
  const firstHalf = numbers.slice(0, Math.max(1, Math.floor(numbers.length / 2)));
  const secondHalf = numbers.slice(Math.max(1, Math.floor(numbers.length / 2)));
  const firstAvg = firstHalf.reduce(function(sum, n) { return sum + n; }, 0) / firstHalf.length;
  const secondAvg = secondHalf.length
    ? secondHalf.reduce(function(sum, n) { return sum + n; }, 0) / secondHalf.length
    : firstAvg;
  return firstAvg > 0 ? (secondAvg - firstAvg) / firstAvg : 0;
}
