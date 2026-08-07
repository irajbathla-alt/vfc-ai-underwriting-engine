const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-1.1-SIMPLE',
  SIGNAL_PREFIX: 'VFC_DEBT_V1:',
  ACTIVE_LOOKBACK_DAYS: 45
};

/**
 * Simple banking-input layer.
 *
 * - validates statement months / duplicate statements
 * - detects explicit loan, MCA and recurring PAD transactions
 * - detects obvious financing credits
 * - stores the structured result in the existing PDF Summaries column
 * - creates no new Sheets
 * - does not change the Our Max formula
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
    debtExtractionUsesOpenAI: false,
    createsNewSheets: false,
    changesProductionFormula: false
  };
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName, period)
    : (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName, period) : null);
  if (!base) return null;

  const audit = vfcBiqBuildStatementAudit_(companyName, period, base);
  if (!audit.uniqueRows.length) return base;

  const debtProfile = vfcBiqAggregateDebtProfile_(audit.uniqueRows, audit.monthsCovered, audit.latestStatementDate);
  const grossMonthlyDeposits = audit.monthsCovered > 0 ? audit.totalDeposits / audit.monthsCovered : 0;
  const operatingTotalDeposits = Math.max(0, audit.totalDeposits - debtProfile.financingCreditsTotal);
  const operatingMonthlyDeposits = audit.monthsCovered > 0
    ? operatingTotalDeposits / audit.monthsCovered
    : grossMonthlyDeposits;

  const warnings = audit.warnings.slice();
  const oldAverage = vfcBiqNumber_(base.averageMonthlyDeposits);
  if (oldAverage > 0 && grossMonthlyDeposits > 0) {
    const variance = Math.abs(oldAverage - grossMonthlyDeposits) / grossMonthlyDeposits;
    if (variance >= 0.05) {
      warnings.push(
        'Average monthly deposits recalculated from distinct statement periods: ' +
        vfcBiqRound_(oldAverage, 1) + ' -> ' + vfcBiqRound_(grossMonthlyDeposits, 1) + '.'
      );
    }
  }
  if (debtProfile.financingCreditsTotal > 0) {
    warnings.push('Financing credits were detected and shown separately from estimated operating deposits.');
  }

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
    mcaPaymentFlag: debtProfile.activeDebtObligations.length > 0 ? 1 : vfcBiqFlag_(base.mcaPaymentFlag),
    monthlyDeposits: audit.monthlyDepositRates,
    monthlyWithdrawals: audit.monthlyWithdrawalRates,
    depositVolatility: vfcBiqRound_(vfcBiqCoefficientOfVariation_(audit.monthlyDepositRates), 0.01),
    depositTrend: vfcBiqRound_(vfcBiqTrend_(audit.monthlyDepositRates), 0.01),
    estimatedOperatingTotalDeposits: vfcBiqRound_(operatingTotalDeposits, 0.01),
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
  const summaryIndex = headers.indexOf('summary');
  const risksIndex = headers.indexOf('risks');
  if (companyIndex < 0 || periodIndex < 0 || uploadIdIndex < 0 || signalIndex < 0) {
    throw new Error('PDF Summaries is missing required columns.');
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

    const existingText = String(row[signalIndex] || '').trim();
    const existingPayload = vfcBiqParseSignalCell_(existingText);
    if (existingPayload && vfcBiqPayloadHasSignals_(existingPayload)) {
      filesSkipped++;
      continue;
    }

    const uploadId = String(row[uploadIdIndex] || '').trim();
    const upload = uploadById[uploadId] || null;
    const fileId = upload && upload.fileId ? String(upload.fileId) : '';
    const fileName = String(row[fileNameIndex] || (upload && upload.fileName) || 'statement.pdf');

    let evidence = [
      existingPayload ? '' : existingText,
      summaryIndex >= 0 ? String(row[summaryIndex] || '') : '',
      risksIndex >= 0 ? String(row[risksIndex] || '') : ''
    ].filter(Boolean).join('\n');

    let signals = vfcBiqExtractFromText_(evidence);

    if (!vfcBiqPayloadHasSignals_(signals) && fileId) {
      try {
        const fullText = extractTextFromPdf_(fileId);
        signals = vfcBiqExtractFromText_(fullText);
      } catch (error) {
        errors.push(fileName + ': ' + String(error && error.message || error));
      }
    }

    const payload = {
      version: 1,
      analyzedAt: new Date().toISOString(),
      fileName: fileName,
      debtPayments: signals.debtPayments || [],
      financingCredits: signals.financingCredits || []
    };

    sheet.getRange(i + 1, signalIndex + 1).setValue(
      VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload)
    );
    filesAnalyzed++;
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

function vfcBiqExtractFromText_(text) {
  text = String(text || '').replace(/\r/g, '\n');
  const lines = text.split(/\n+/).map(function(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  const yearMatch = text.match(/\b(20\d{2})\b/);
  const defaultYear = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  let currentDate = '';
  const debtPayments = [];
  const financingCredits = [];

  lines.forEach(function(line) {
    const parsedDate = vfcBiqDateFromLine_(line, defaultYear);
    if (parsedDate) currentDate = parsedDate;

    const amount = vfcBiqFirstMoney_(line);
    if (!(amount > 0)) return;

    const lower = line.toLowerCase();
    let category = '';
    let counterparty = '';

    if (/loan\s+payment/.test(lower)) {
      category = 'TERM_LOAN';
      counterparty = vfcBiqLoanLabel_(line);
    } else if (/merch\s+pad|merchant\s+(?:growth\s+)?pad|mca\s+(?:pad|payment|debit)/.test(lower)) {
      category = 'MCA';
      counterparty = /merchant\s+growth/i.test(line) ? 'Merchant Growth' : 'MERCH PAD';
    } else if (/commercial\s+loans?|business\s+cr\s+eft/.test(lower)) {
      category = 'COMMERCIAL_LOAN';
      counterparty = 'Commercial Loans';
    } else if (/\bloc\b.*(?:payment|pmt|pad)|line\s+of\s+credit.*(?:payment|pmt|pad)/.test(lower)) {
      category = 'LOC';
      counterparty = 'Line of Credit';
    } else if (/\bipfs\b|a-kan\/ipfs|premium\s+finance/.test(lower)) {
      category = 'INSURANCE_FINANCE';
      counterparty = 'A-KAN/IPFS';
    } else if (/\b(?:cra|ccra)\b.*(?:pad|canada)/.test(lower)) {
      category = 'TAX_GOVERNMENT';
      counterparty = /ccra/i.test(line) ? 'CCRA Canada' : 'CRA Canada';
    } else if (/amex\s+cards?|mastercard|visa.*(?:card|payment)/.test(lower) && /payment/.test(lower)) {
      category = 'CREDIT_CARD';
      counterparty = /amex/i.test(line) ? 'AMEX Cards' : 'Credit Card';
    } else if (/business\s+pad|\bpad\b/.test(lower)) {
      category = 'OTHER_RECURRING_PAD';
      counterparty = vfcBiqPadLabel_(line);
    }

    if (category) {
      debtPayments.push({
        date: currentDate,
        description: line.substring(0, 180),
        counterparty: counterparty,
        amount: vfcBiqRound_(amount, 0.01),
        category: category,
        confidence: /loan\s+payment|merch\s+pad|commercial\s+loans?|\bipfs\b|\b(?:cra|ccra)\b/i.test(line) ? 'High' : 'Moderate'
      });
    }

    if (/merchant\s+growth/.test(lower) && !/pad|payment|debit/.test(lower)) {
      financingCredits.push({
        date: currentDate,
        description: line.substring(0, 180),
        counterparty: 'Merchant Growth',
        amount: vfcBiqRound_(amount, 0.01),
        category: 'MCA_ADVANCE',
        confidence: 'High'
      });
    } else if (/loan\s+(?:advance|proceeds)|commercial\s+(?:loan\s+)?advance|financing\s+proceeds/.test(lower)) {
      financingCredits.push({
        date: currentDate,
        description: line.substring(0, 180),
        counterparty: 'Financing Proceeds',
        amount: vfcBiqRound_(amount, 0.01),
        category: 'LOAN_ADVANCE',
        confidence: 'High'
      });
    } else if (/bcc\s+bf\s+rs|deftpymt/.test(lower) && !/payment/.test(lower)) {
      financingCredits.push({
        date: currentDate,
        description: line.substring(0, 180),
        counterparty: 'Possible Commercial Financing',
        amount: vfcBiqRound_(amount, 0.01),
        category: 'UNKNOWN_FINANCING_CREDIT',
        confidence: 'Moderate'
      });
    }
  });

  return {
    debtPayments: vfcBiqDedupeSignals_(debtPayments),
    financingCredits: vfcBiqDedupeSignals_(financingCredits)
  };
}

function vfcBiqBuildStatementAudit_(companyName, period, base) {
  const rawRows = getSheetObjects_('PDF Summaries').filter(function(row) {
    return sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period));
  });

  const byKey = {};
  rawRows.forEach(function(row) {
    const start = vfcBiqIsoDate_(row.statementStartDate);
    const end = vfcBiqIsoDate_(row.statementEndDate);
    const deposits = vfcBiqNumber_(row.totalDeposits);
    const withdrawals = vfcBiqNumber_(row.totalWithdrawals);
    const fileName = String(row.fileName || '').trim().toLowerCase();
    const key = start && end
      ? [start, end, deposits.toFixed(2), withdrawals.toFixed(2)].join('|')
      : [fileName, deposits.toFixed(2), withdrawals.toFixed(2)].join('|');
    if (!byKey[key] || vfcBiqRowQuality_(row) >= vfcBiqRowQuality_(byKey[key])) {
      byKey[key] = row;
    }
  });

  const uniqueRows = Object.keys(byKey).map(function(key) { return byKey[key]; });
  uniqueRows.sort(function(a, b) {
    const ad = vfcBiqDate_(a.statementEndDate) || vfcBiqDate_(a.statementStartDate) || new Date(0);
    const bd = vfcBiqDate_(b.statementEndDate) || vfcBiqDate_(b.statementStartDate) || new Date(0);
    return ad.getTime() - bd.getTime();
  });

  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let nsfCount = 0;
  let negativeBalanceFlag = 0;
  const starts = [];
  const ends = [];
  const monthKeys = {};
  const rates = [];

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
    rates.push({
      date: end || start || new Date(2000, 0, index + 1),
      deposits: deposits / durationMonths,
      withdrawals: withdrawals / durationMonths
    });

    const monthDate = end || start;
    if (monthDate) {
      monthKeys[monthDate.getUTCFullYear() + '-' + ('0' + (monthDate.getUTCMonth() + 1)).slice(-2)] = true;
    }
  });

  const earliest = starts.length ? new Date(Math.min.apply(null, starts.map(function(d) { return d.getTime(); }))) : null;
  const latest = ends.length ? new Date(Math.max.apply(null, ends.map(function(d) { return d.getTime(); }))) : null;
  const spanMonths = earliest && latest
    ? Math.max(1, Math.round((((latest.getTime() - earliest.getTime()) / 86400000) + 1) / 30.4375))
    : 0;
  const distinctMonths = Object.keys(monthKeys).length;
  const fallbackMonths = Math.max(1, vfcBiqNumber_(base && base.monthsCovered) || uniqueRows.length || 1);
  const monthsCovered = Math.max(1, spanMonths, distinctMonths, spanMonths || distinctMonths ? 0 : fallbackMonths);

  rates.sort(function(a, b) { return a.date.getTime() - b.date.getTime(); });
  const warnings = [];
  const duplicates = rawRows.length - uniqueRows.length;
  if (duplicates > 0) warnings.push(duplicates + ' duplicate statement summary row(s) were excluded.');
  if (vfcBiqNumber_(base && base.monthsCovered) && vfcBiqNumber_(base.monthsCovered) !== monthsCovered) {
    warnings.push('Months covered corrected from ' + vfcBiqNumber_(base.monthsCovered) + ' to ' + monthsCovered + ' using statement dates.');
  }

  return {
    rawRowCount: rawRows.length,
    uniqueRows: uniqueRows,
    duplicateRowsRemoved: duplicates,
    monthsCovered: monthsCovered,
    totalDeposits: totalDeposits,
    totalWithdrawals: totalWithdrawals,
    nsfCount: nsfCount,
    negativeBalanceFlag: negativeBalanceFlag,
    monthlyDepositRates: rates.map(function(row) { return vfcBiqRound_(row.deposits, 0.01); }),
    monthlyWithdrawalRates: rates.map(function(row) { return vfcBiqRound_(row.withdrawals, 0.01); }),
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
      confidence: vfcBiqGroupConfidence_(items)
    };
  }).filter(function(item) { return item.paymentAmount > 0; });

  obligations.sort(function(a, b) { return b.monthlyEquivalent - a.monthlyEquivalent; });

  const confirmedCategories = ['MCA','TERM_LOAN','COMMERCIAL_LOAN','LOC','LEASE_FINANCE'];
  const otherCategories = ['INSURANCE_FINANCE','CREDIT_CARD','OTHER_RECURRING_PAD'];
  const activeDebt = obligations.filter(function(item) {
    return item.active && confirmedCategories.indexOf(item.category) >= 0 && item.frequency !== 'Observed once' && item.confidence !== 'Low';
  });
  const otherRecurring = obligations.filter(function(item) {
    return item.active && otherCategories.indexOf(item.category) >= 0 && item.frequency !== 'Observed once';
  });
  const taxPads = obligations.filter(function(item) {
    return item.active && item.category === 'TAX_GOVERNMENT';
  });

  const financingCredits = credits.filter(function(item) { return item.confidence !== 'Low'; });
  return {
    confirmedMonthlyDebtService: vfcBiqRound_(activeDebt.reduce(function(sum, item) { return sum + item.monthlyEquivalent; }, 0), 0.01),
    otherRecurringMonthlyObligations: vfcBiqRound_(otherRecurring.reduce(function(sum, item) { return sum + item.monthlyEquivalent; }, 0), 0.01),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxPads,
    allDetectedObligations: obligations,
    financingCredits: financingCredits,
    financingCreditsTotal: vfcBiqRound_(financingCredits.reduce(function(sum, item) { return sum + vfcBiqNumber_(item.amount); }, 0), 0.01),
    note: 'Monthly equivalents are inferred from observed transaction frequency. Outstanding balances are not inferred.'
  };
}

function vfcBiqPayloadHasSignals_(payload) {
  return !!(payload && ((payload.debtPayments && payload.debtPayments.length) || (payload.financingCredits && payload.financingCredits.length)));
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

function vfcBiqRowQuality_(row) {
  const payload = vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
  let score = 0;
  if (payload) score += 10;
  if (vfcBiqPayloadHasSignals_(payload)) score += 100;
  const created = vfcBiqDate_(row.createdAt);
  if (created) score += created.getTime() / 1e15;
  return score;
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
  if (!items || !items.length) return 'Low';
  const points = items.reduce(function(sum, item) {
    return sum + (item.confidence === 'High' ? 2 : item.confidence === 'Moderate' ? 1 : 0);
  }, 0) / items.length;
  return points >= 1.5 ? 'High' : points >= 0.75 ? 'Moderate' : 'Low';
}

function vfcBiqFirstMoney_(line) {
  const matches = String(line || '').match(/(?:\$\s*)?\d{1,3}(?:,\d{3})*\.\d{2}|(?:\$\s*)?\d+\.\d{2}/g) || [];
  for (let i = 0; i < matches.length; i++) {
    const value = vfcBiqNumber_(matches[i]);
    if (value > 0) return value;
  }
  return 0;
}

function vfcBiqDateFromLine_(line, year) {
  const match = String(line || '').match(/^\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i) ||
    String(line || '').match(/^\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/i);
  if (!match) return '';
  let day, monthText;
  if (/^\d/.test(match[1])) {
    day = Number(match[1]);
    monthText = match[2];
  } else {
    monthText = match[1];
    day = Number(match[2]);
  }
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const month = months[String(monthText).toLowerCase()];
  if (month === undefined || !day) return '';
  return Utilities.formatDate(new Date(Date.UTC(year, month, day)), 'UTC', 'yyyy-MM-dd');
}

function vfcBiqLoanLabel_(line) {
  const match = String(line || '').match(/loan\s+payment\s+([^\s]+(?:\s+\d{1,4})?)/i);
  return match ? 'Loan ' + match[1] : 'Loan Payment';
}

function vfcBiqPadLabel_(line) {
  const cleaned = String(line || '').replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b.*$/, '').trim();
  return cleaned.substring(0, 80) || 'Recurring PAD';
}

function vfcBiqNormalizeCounterparty_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(payment|payments|business|pad|investment|eft|deftpymt)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
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
  const split = Math.max(1, Math.floor(numbers.length / 2));
  const firstHalf = numbers.slice(0, split);
  const secondHalf = numbers.slice(split);
  const firstAvg = firstHalf.reduce(function(sum, n) { return sum + n; }, 0) / firstHalf.length;
  const secondAvg = secondHalf.length
    ? secondHalf.reduce(function(sum, n) { return sum + n; }, 0) / secondHalf.length
    : firstAvg;
  return firstAvg > 0 ? (secondAvg - firstAvg) / firstAvg : 0;
}
