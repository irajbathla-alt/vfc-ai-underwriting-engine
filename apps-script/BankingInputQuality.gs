const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-2.0-SIMPLE',
  SIGNAL_PREFIX: 'VFC_BANKING_V2:',
  ACTIVE_LOOKBACK_DAYS: 45,
  LATEST_BATCH_GAP_MINUTES: 10
};

/**
 * Simple banking-input layer.
 *
 * One job only:
 * - validate the latest uploaded statement set
 * - read exact statement-header deposits/withdrawals when available
 * - detect explicit recurring loan/MCA/PAD transactions
 * - detect obvious financing credits
 *
 * No new Sheets are created and no new debt multiplier is added to Our Max.
 */
function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const request = vfcBiqNormalizeRequest_(companyOrRequest, requestedPeriod);
    const period = request.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(request.companyName, request.period)
      : request.period);
    return vfcBiqRefreshLatestBatch_(request.companyName, period);
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
    usesLatestUploadBatchOnly: true,
    verifiesStatementHeaderTotals: true,
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
        'Average monthly deposits corrected from ' +
        vfcBiqRound_(oldAverage, 1) + ' to ' + vfcBiqRound_(grossMonthlyDeposits, 1) +
        ' using the latest statement set.'
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
      allMatchingRows: audit.rawRowCount,
      latestBatchRows: audit.latestBatchRowCount,
      distinctStatementRows: audit.uniqueRows.length,
      olderRowsIgnored: audit.olderRowsIgnored,
      duplicateRowsRemoved: audit.duplicateRowsRemoved,
      validatedMonthsCovered: audit.monthsCovered,
      originalMonthsCovered: vfcBiqNumber_(base.monthsCovered),
      grossAverageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
      estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
      warnings: warnings
    }
  });
}

function vfcBiqRefreshLatestBatch_(companyName, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) throw new Error('Missing PDF Summaries sheet.');

  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  if (!allRows.length) throw new Error('No PDF Summary rows were found for this company and period.');
  const latestRows = vfcBiqLatestBatchRows_(allRows);

  const uploads = getSheetObjects_('Uploads');
  const uploadById = {};
  uploads.forEach(function(row) {
    if (row.uploadId) uploadById[String(row.uploadId)] = row;
  });

  let filesAnalyzed = 0;
  let filesSkipped = 0;
  const errors = [];

  latestRows.forEach(function(row) {
    const existing = vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
    if (vfcBiqPayloadComplete_(existing)) {
      filesSkipped++;
      return;
    }

    const upload = uploadById[String(row.uploadId || '')] || {};
    const fileId = String(upload.fileId || '');
    const fileName = String(row.fileName || upload.fileName || 'statement.pdf');
    if (!fileId) {
      errors.push(fileName + ': upload file ID not found.');
      return;
    }

    try {
      const text = extractTextFromPdf_(fileId);
      const parsed = vfcBiqParseStatement_(text, row);
      const payload = {
        version: 2,
        analyzedAt: new Date().toISOString(),
        fileName: fileName,
        headerSummary: parsed.headerSummary,
        debtPayments: parsed.debtPayments,
        financingCredits: parsed.financingCredits
      };
      sheet.getRange(row._rowNumber, row._signalColumn).setValue(
        VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload)
      );
      filesAnalyzed++;
    } catch (error) {
      errors.push(fileName + ': ' + String(error && error.message || error));
    }
  });

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

function vfcBiqReadSummaryRows_(companyName, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(function(value) { return normalizeHeader_(value); });
  const signalColumn = headers.indexOf('possibleMcaOrLoanPayments') + 1;

  return values.slice(1).map(function(row, index) {
    const obj = {};
    headers.forEach(function(header, columnIndex) {
      obj[header] = row[columnIndex];
    });
    obj._rowNumber = index + 2;
    obj._signalColumn = signalColumn;
    return obj;
  }).filter(function(row) {
    return sameText_(row.companyName, companyName) && (!period || sameText_(row.detectedPeriod, period));
  });
}

function vfcBiqLatestBatchRows_(rows) {
  if (!rows || rows.length <= 1) return (rows || []).slice();
  const selected = [];
  const seenNames = {};
  let lastIncludedTime = null;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const fileName = String(row.fileName || '').trim().toLowerCase();
    const created = vfcBiqDate_(row.createdAt);

    if (selected.length) {
      if (fileName && seenNames[fileName]) break;
      if (created && lastIncludedTime) {
        const gapMinutes = Math.abs(lastIncludedTime - created.getTime()) / 60000;
        if (gapMinutes > VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES) break;
      }
    }

    selected.push(row);
    if (fileName) seenNames[fileName] = true;
    if (created) lastIncludedTime = created.getTime();
  }

  return selected.reverse();
}

function vfcBiqParseStatement_(text, fallbackRow) {
  const cleanText = String(text || '').replace(/\u00a0/g, ' ');
  const headerSummary = vfcBiqParseHeaderSummary_(cleanText, fallbackRow || {});
  const signals = vfcBiqExtractTransactions_(cleanText);
  return {
    headerSummary: headerSummary,
    debtPayments: signals.debtPayments,
    financingCredits: signals.financingCredits
  };
}

function vfcBiqParseHeaderSummary_(text, fallbackRow) {
  const deposits = vfcBiqMatchAmount_(text, [
    /Total\s+deposits\s*(?:&|and)\s*credits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,
    /Total\s+deposits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,
    /Total\s+credits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i
  ]) || vfcBiqNumber_(fallbackRow.totalDeposits);

  const withdrawals = vfcBiqMatchAmount_(text, [
    /Total\s+cheques\s*(?:&|and)\s*debits(?:\s*\([^)]*\))?\s*-?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,
    /Total\s+withdrawals(?:\s*\([^)]*\))?\s*-?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,
    /Total\s+debits(?:\s*\([^)]*\))?\s*-?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i
  ]) || vfcBiqNumber_(fallbackRow.totalWithdrawals);

  const range = vfcBiqStatementDateRange_(text);
  return {
    statementStartDate: range.start || vfcBiqIsoDate_(fallbackRow.statementStartDate),
    statementEndDate: range.end || vfcBiqIsoDate_(fallbackRow.statementEndDate),
    totalDeposits: vfcBiqRound_(deposits, 0.01),
    totalWithdrawals: vfcBiqRound_(withdrawals, 0.01),
    verifiedFromStatementHeader: !!(vfcBiqMatchAmount_(text, [
      /Total\s+deposits\s*(?:&|and)\s*credits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i,
      /Total\s+deposits(?:\s*\([^)]*\))?\s*\+?\s*\$?\s*([0-9][0-9,]*\.\d{2})/i
    ]))
  };
}

function vfcBiqExtractTransactions_(text) {
  const lines = String(text || '').replace(/\r/g, '\n').split(/\n+/).map(function(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
  }).filter(Boolean);

  const yearMatch = text.match(/\b(20\d{2})\b/);
  const defaultYear = yearMatch ? Number(yearMatch[1]) : new Date().getFullYear();
  let currentDate = '';
  const debtPayments = [];
  const financingCredits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsedDate = vfcBiqDateFromLine_(line, defaultYear);
    if (parsedDate) currentDate = parsedDate;

    const window = [line, lines[i + 1] || ''].join(' ');
    const lower = window.toLowerCase();

    vfcBiqCaptureDebt_(debtPayments, currentDate, window, /loan\s+payment\b.{0,90}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i, 'TERM_LOAN', vfcBiqLoanLabel_(window), 'High');
    vfcBiqCaptureDebt_(debtPayments, currentDate, window, /(?:investment\s+)?(?:merch\s+pad|merchant\s+(?:growth\s+)?pad)\b.{0,70}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i, 'MCA', 'Merchant Growth / MERCH PAD', 'High');
    vfcBiqCaptureDebt_(debtPayments, currentDate, window, /commercial\s+loans?.{0,90}?business\s+cr\s+eft.{0,50}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i, 'COMMERCIAL_LOAN', 'Commercial Loans', 'High');
    vfcBiqCaptureDebt_(debtPayments, currentDate, window, /(?:business\s+pad\s+)?(?:a-?kan\/?ipfs|ipfs|premium\s+finance).{0,60}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i, 'INSURANCE_FINANCE', 'A-KAN/IPFS', 'High');
    vfcBiqCaptureDebt_(debtPayments, currentDate, window, /(?:pad\s+)?(?:cra|ccra)\s+canada.{0,50}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i, 'TAX_GOVERNMENT', /ccra/i.test(window) ? 'CCRA Canada' : 'CRA Canada', 'High');

    if (/\bpad\b/i.test(window) && !/merch\s+pad|merchant\s+(?:growth\s+)?pad|a-?kan\/?ipfs|\bipfs\b|\b(?:cra|ccra)\b/i.test(window)) {
      vfcBiqCaptureDebt_(debtPayments, currentDate, window, /\bpad\b.{0,80}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i, 'OTHER_RECURRING_PAD', vfcBiqPadLabel_(window), 'Moderate');
    }

    const merchantAdvance = window.match(/investment\s+merchant\s+growth\b.{0,60}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i);
    if (merchantAdvance) {
      vfcBiqPushSignal_(financingCredits, currentDate, window, merchantAdvance[1], 'MCA_ADVANCE', 'Merchant Growth', 'High');
    }

    const bccAdvance = window.match(/bcc\s+bf\s+rs\s*<?deftpymt>?\b.{0,60}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i);
    if (bccAdvance) {
      vfcBiqPushSignal_(financingCredits, currentDate, window, bccAdvance[1], 'UNKNOWN_FINANCING_CREDIT', 'Possible Commercial Financing', 'Moderate');
    }

    if (/loan\s+(?:advance|proceeds)|financing\s+proceeds/i.test(lower)) {
      const genericAdvance = window.match(/(?:loan\s+(?:advance|proceeds)|financing\s+proceeds).{0,60}?([0-9]{1,3}(?:,[0-9]{3})*\.\d{2}|[0-9]+\.\d{2})/i);
      if (genericAdvance) {
        vfcBiqPushSignal_(financingCredits, currentDate, window, genericAdvance[1], 'LOAN_ADVANCE', 'Financing Proceeds', 'High');
      }
    }
  }

  return {
    debtPayments: vfcBiqDedupeSignals_(debtPayments),
    financingCredits: vfcBiqDedupeSignals_(financingCredits)
  };
}

function vfcBiqCaptureDebt_(target, date, text, regex, category, counterparty, confidence) {
  const match = String(text || '').match(regex);
  if (!match) return;
  vfcBiqPushSignal_(target, date, text, match[1], category, counterparty, confidence);
}

function vfcBiqPushSignal_(target, date, text, amountText, category, counterparty, confidence) {
  const amount = vfcBiqNumber_(amountText);
  if (!(amount > 0)) return;
  target.push({
    date: date,
    description: String(text || '').substring(0, 180),
    counterparty: counterparty,
    amount: vfcBiqRound_(amount, 0.01),
    category: category,
    confidence: confidence
  });
}

function vfcBiqBuildStatementAudit_(companyName, period, base) {
  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  const latestRows = vfcBiqLatestBatchRows_(allRows);
  const byKey = {};

  latestRows.forEach(function(row) {
    const payload = vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
    const header = payload && payload.headerSummary ? payload.headerSummary : {};
    const start = header.statementStartDate || vfcBiqIsoDate_(row.statementStartDate);
    const end = header.statementEndDate || vfcBiqIsoDate_(row.statementEndDate);
    const fileName = String(row.fileName || '').trim().toLowerCase();
    const key = start && end ? start + '|' + end : fileName;
    const quality = (header.verifiedFromStatementHeader ? 100 : 0) + (vfcBiqDate_(row.createdAt) ? vfcBiqDate_(row.createdAt).getTime() / 1e15 : 0);
    if (!byKey[key] || quality >= byKey[key]._quality) {
      row._quality = quality;
      byKey[key] = row;
    }
  });

  const uniqueRows = Object.keys(byKey).map(function(key) { return byKey[key]; });
  uniqueRows.sort(function(a, b) {
    return vfcBiqEffectiveDate_(a).getTime() - vfcBiqEffectiveDate_(b).getTime();
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
    const payload = vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
    const header = payload && payload.headerSummary ? payload.headerSummary : {};
    const start = vfcBiqDate_(header.statementStartDate || row.statementStartDate);
    const end = vfcBiqDate_(header.statementEndDate || row.statementEndDate);
    if (start) starts.push(start);
    if (end) ends.push(end);

    const deposits = Math.max(0, vfcBiqNumber_(header.totalDeposits || row.totalDeposits));
    const withdrawals = Math.max(0, vfcBiqNumber_(header.totalWithdrawals || row.totalWithdrawals));
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
    if (monthDate) monthKeys[monthDate.getUTCFullYear() + '-' + ('0' + (monthDate.getUTCMonth() + 1)).slice(-2)] = true;
  });

  const earliest = starts.length ? new Date(Math.min.apply(null, starts.map(function(d) { return d.getTime(); }))) : null;
  const latest = ends.length ? new Date(Math.max.apply(null, ends.map(function(d) { return d.getTime(); }))) : null;
  const spanMonths = earliest && latest
    ? Math.max(1, Math.round((((latest.getTime() - earliest.getTime()) / 86400000) + 1) / 30.4375))
    : 0;
  const distinctMonths = Object.keys(monthKeys).length;
  const fallbackMonths = Math.max(1, uniqueRows.length || vfcBiqNumber_(base && base.monthsCovered) || 1);
  const monthsCovered = Math.max(1, spanMonths, distinctMonths, spanMonths || distinctMonths ? 0 : fallbackMonths);

  rates.sort(function(a, b) { return a.date.getTime() - b.date.getTime(); });
  const olderRowsIgnored = Math.max(0, allRows.length - latestRows.length);
  const duplicates = Math.max(0, latestRows.length - uniqueRows.length);
  const warnings = [];
  if (olderRowsIgnored > 0) warnings.push('Using the latest upload batch; ' + olderRowsIgnored + ' older statement row(s) were ignored.');
  if (duplicates > 0) warnings.push(duplicates + ' duplicate statement(s) inside the latest upload were excluded.');
  if (vfcBiqNumber_(base && base.monthsCovered) && vfcBiqNumber_(base.monthsCovered) !== monthsCovered) {
    warnings.push('Months covered corrected from ' + vfcBiqNumber_(base.monthsCovered) + ' to ' + monthsCovered + ' using statement dates.');
  }

  return {
    rawRowCount: allRows.length,
    latestBatchRowCount: latestRows.length,
    uniqueRows: uniqueRows,
    olderRowsIgnored: olderRowsIgnored,
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

function vfcBiqPayloadComplete_(payload) {
  return !!(payload && payload.version >= 2 && payload.headerSummary && vfcBiqNumber_(payload.headerSummary.totalDeposits) > 0);
}

function vfcBiqParseSignalCell_(value) {
  const text = String(value || '').trim();
  if (text.indexOf(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX) !== 0) return null;
  try {
    const parsed = JSON.parse(text.substring(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      version: vfcBiqNumber_(parsed.version),
      headerSummary: parsed.headerSummary && typeof parsed.headerSummary === 'object' ? parsed.headerSummary : {},
      debtPayments: Array.isArray(parsed.debtPayments) ? parsed.debtPayments : [],
      financingCredits: Array.isArray(parsed.financingCredits) ? parsed.financingCredits : []
    };
  } catch (error) {
    return null;
  }
}

function vfcBiqEffectiveDate_(row) {
  const payload = vfcBiqParseSignalCell_(row.possibleMcaOrLoanPayments);
  const header = payload && payload.headerSummary ? payload.headerSummary : {};
  return vfcBiqDate_(header.statementEndDate || row.statementEndDate || header.statementStartDate || row.statementStartDate) || new Date(0);
}

function vfcBiqMatchAmount_(text, patterns) {
  for (let i = 0; i < patterns.length; i++) {
    const match = String(text || '').match(patterns[i]);
    if (match && match[1]) {
      const value = vfcBiqNumber_(match[1]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function vfcBiqStatementDateRange_(text) {
  const monthPattern = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const regex = new RegExp('\\b' + monthPattern + '\\s+(\\d{1,2}),\\s*(20\\d{2})\\s+to\\s+' + monthPattern + '\\s+(\\d{1,2}),\\s*(20\\d{2})', 'i');
  const match = String(text || '').match(regex);
  if (!match) return { start: '', end: '' };
  return {
    start: vfcBiqNamedDate_(match[1], match[2], match[3]),
    end: vfcBiqNamedDate_(match[4], match[5], match[6])
  };
}

function vfcBiqNamedDate_(monthText, day, year) {
  const months = {jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11};
  const month = months[String(monthText || '').toLowerCase()];
  if (month === undefined) return '';
  return Utilities.formatDate(new Date(Date.UTC(Number(year), month, Number(day))), 'UTC', 'yyyy-MM-dd');
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
