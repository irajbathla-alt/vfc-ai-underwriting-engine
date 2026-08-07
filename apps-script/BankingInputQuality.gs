const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-3.0-OPENAI-STRUCTURED',
  SIGNAL_PREFIX: 'VFC_BANKING_V5:',
  ACTIVE_LOOKBACK_DAYS: 45,
  LATEST_BATCH_GAP_MINUTES: 10
};

/**
 * Simple banking-input quality layer.
 *
 * - Uses the latest upload batch only.
 * - Re-reads old/current PDFs only when a V5 structured result is not cached.
 * - OpenAI extracts exact statement totals and exact financing/PAD transactions.
 * - Local code only aggregates, deduplicates and infers frequency.
 * - No new Sheets are created.
 * - No new debt-service multiplier is added to Our Max.
 */
function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcBiqRequest_(companyOrRequest, requestedPeriod);
    const period = req.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(req.companyName, req.period)
      : req.period);
    return vfcBiqRefresh_(req.companyName, period);
  } catch (error) {
    return {
      ok: false,
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      filesAnalyzed: 0,
      filesSkipped: 0,
      errors: [String(error && error.message || error)]
    };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcBiqSummaryRows_('', '');
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
  const result = {
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    extractionMethod: 'OpenAI structured transaction extraction',
    regexTransactionParsing: false,
    usesLatestUploadBatchOnly: true,
    verifiesStatementHeaderTotals: true,
    cachesStructuredResults: true,
    createsNewSheets: false,
    changesProductionFormula: false
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName, period)
    : (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName, period) : null);
  if (!base) return null;

  const audit = vfcBiqAudit_(companyName, period, base);
  if (!audit.rows.length) return base;

  const debt = vfcBiqDebtProfile_(audit.rows, audit.monthsCovered, audit.latestStatementDate);
  const grossMonthly = audit.totalDeposits / Math.max(1, audit.monthsCovered);
  const operatingTotal = Math.max(0, audit.totalDeposits - debt.financingCreditsTotal);
  const operatingMonthly = operatingTotal / Math.max(1, audit.monthsCovered);
  const warnings = audit.warnings.slice();
  const oldAverage = vfcBiqNumber_(base.averageMonthlyDeposits);

  if (oldAverage > 0 && grossMonthly > 0 && Math.abs(oldAverage - grossMonthly) / grossMonthly >= 0.05) {
    warnings.push(
      'Average monthly deposits corrected from ' +
      vfcBiqRound_(oldAverage, 1) + ' to ' + vfcBiqRound_(grossMonthly, 1) +
      ' using the latest statement-header totals.'
    );
  }
  if (debt.financingCreditsTotal > 0) {
    warnings.push('Financing credits were detected and shown separately from estimated operating deposits.');
  }

  return Object.assign({}, base, {
    statementCount: audit.rows.length,
    monthsCovered: audit.monthsCovered,
    totalDeposits: vfcBiqRound_(audit.totalDeposits, 0.01),
    averageMonthlyDeposits: vfcBiqRound_(grossMonthly, 0.01),
    totalWithdrawals: vfcBiqRound_(audit.totalWithdrawals, 0.01),
    depositWithdrawalRatio: vfcBiqRound_(audit.totalWithdrawals ? audit.totalDeposits / audit.totalWithdrawals : 0, 0.01),
    nsfCount: audit.nsfCount,
    nsfPerMonth: vfcBiqRound_(audit.nsfCount / Math.max(1, audit.monthsCovered), 0.01),
    negativeBalanceFlag: audit.negativeBalanceFlag,
    mcaPaymentFlag: debt.activeDebtObligations.length ? 1 : 0,
    monthlyDeposits: audit.monthlyDeposits,
    monthlyWithdrawals: audit.monthlyWithdrawals,
    depositVolatility: vfcBiqRound_(vfcBiqCoefficientOfVariation_(audit.monthlyDeposits), 0.01),
    depositTrend: vfcBiqRound_(vfcBiqTrend_(audit.monthlyDeposits), 0.01),
    estimatedOperatingTotalDeposits: vfcBiqRound_(operatingTotal, 0.01),
    estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthly, 0.01),
    detectedFinancingCredits: vfcBiqRound_(debt.financingCreditsTotal, 0.01),
    existingMonthlyDebtService: vfcBiqRound_(debt.confirmedMonthlyDebtService, 0.01),
    otherRecurringMonthlyObligations: vfcBiqRound_(debt.otherRecurringMonthlyObligations, 0.01),
    debtServiceToDepositsRatio: grossMonthly
      ? vfcBiqRound_(debt.confirmedMonthlyDebtService / grossMonthly, 0.0001)
      : 0,
    debtProfile: debt,
    inputQualityAudit: {
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      allMatchingRows: audit.allMatchingRows,
      latestBatchRows: audit.latestBatchRows,
      olderRowsIgnored: audit.olderRowsIgnored,
      validatedMonthsCovered: audit.monthsCovered,
      grossAverageMonthlyDeposits: vfcBiqRound_(grossMonthly, 0.01),
      estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthly, 0.01),
      warnings: warnings
    }
  });
}

function vfcBiqRefresh_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = ss.getSheetByName('PDF Summaries');
  if (!summarySheet) throw new Error('Missing PDF Summaries sheet.');

  const allRows = vfcBiqSummaryRows_(companyName, period);
  if (!allRows.length) throw new Error('No PDF Summary rows found for this company and period.');

  const rows = vfcBiqLatestBatch_(allRows);
  const uploadMap = vfcBiqUploadMap_();
  let filesAnalyzed = 0;
  let filesSkipped = 0;
  const errors = [];

  rows.forEach(function(row) {
    const cached = vfcBiqParseCell_(row.possibleMcaOrLoanPayments);
    if (cached && cached.version >= 5 && cached.headerSummary && vfcBiqNumber_(cached.headerSummary.totalDeposits) > 0) {
      filesSkipped++;
      return;
    }

    const upload = uploadMap[String(row.uploadId || '')] || {};
    if (!upload.fileId) {
      errors.push(row.fileName + ': upload file ID not found.');
      return;
    }

    try {
      const text = extractTextFromPdf_(upload.fileId);
      const structured = vfcBiqOpenAIExtract_(text, row);
      const payload = {
        version: 5,
        analyzedAt: new Date().toISOString(),
        fileName: row.fileName,
        headerSummary: structured.headerSummary,
        debtPayments: structured.debtPayments,
        financingCredits: structured.financingCredits
      };

      summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(
        VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload)
      );
      filesAnalyzed++;
    } catch (error) {
      errors.push(row.fileName + ': ' + String(error && error.message || error));
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

function vfcBiqOpenAIExtract_(text, fallbackRow) {
  const prompt = [
    'You are the VFC bank-statement transaction extractor.',
    'Return JSON only. Do not provide prose outside JSON.',
    '',
    'Return exactly these top-level fields:',
    'statement_start_date, statement_end_date, total_deposits, total_withdrawals, debt_payments, financing_credits.',
    '',
    'debt_payments must be an array. Each item must contain:',
    'date, description, counterparty, amount, category, confidence.',
    '',
    'Allowed debt category values:',
    'TERM_LOAN, MCA, COMMERCIAL_LOAN, LOC, LEASE_FINANCE, INSURANCE_FINANCE, TAX_GOVERNMENT, CREDIT_CARD, OTHER_RECURRING_PAD.',
    '',
    'financing_credits must be an array. Each item must contain:',
    'date, description, counterparty, amount, category, confidence.',
    '',
    'Allowed financing-credit category values:',
    'MCA_ADVANCE, LOAN_ADVANCE, UNKNOWN_FINANCING_CREDIT.',
    '',
    'STRICT EXTRACTION RULES:',
    '1. Use YYYY-MM-DD dates.',
    '2. total_deposits must come from the statement summary/header total such as Total deposits & credits. Do not calculate it from transaction lines.',
    '3. total_withdrawals must come from the statement summary/header total such as Total cheques & debits. Do not calculate it from transaction lines.',
    '4. Extract EACH individual financing payment occurrence. Do not summarize frequency and do not combine multiple payments into one item.',
    '5. A debt payment must be visibly posted as a debit/withdrawal. Never use a nearby transaction amount.',
    '6. A financing credit must be visibly posted as a credit/deposit. Never use a nearby transaction amount.',
    '7. MERCH PAD or Merchant Growth PAD is MCA. Merchant Growth money received into the account is an MCA_ADVANCE, not operating revenue.',
    '8. Loan payment is TERM_LOAN. COMMERCIAL LOANS / Business Cr EFT financing payment is COMMERCIAL_LOAN.',
    '9. A-KAN/IPFS or premium finance is INSURANCE_FINANCE, not MCA.',
    '10. CRA/CCRA PAD is TAX_GOVERNMENT, not financing debt.',
    '11. Generic PAD may be OTHER_RECURRING_PAD only when the transaction itself clearly contains PAD and its exact debit amount is visible.',
    '12. Do not classify normal purchases, suppliers, payroll, Interac purchases, ATM deposits, e-transfers, card purchases, or ordinary operating expenses as debt/PAD.',
    '13. Do not infer an outstanding loan balance or payout balance.',
    '14. If an item is uncertain, omit it instead of guessing.',
    '15. confidence must be High, Moderate, or Low.',
    '',
    'Fallback statement information (use only when the OCR text does not clearly show the header value):',
    JSON.stringify({
      statement_start_date: fallbackRow.statementStartDate || '',
      statement_end_date: fallbackRow.statementEndDate || '',
      total_deposits: fallbackRow.totalDeposits || '',
      total_withdrawals: fallbackRow.totalWithdrawals || ''
    }),
    '',
    'BANK STATEMENT OCR TEXT:',
    String(text || '').substring(0, 60000)
  ].join('\n');

  const raw = callOpenAIJson_(prompt) || {};
  const start = vfcBiqIsoDate_(raw.statement_start_date || fallbackRow.statementStartDate);
  const end = vfcBiqIsoDate_(raw.statement_end_date || fallbackRow.statementEndDate);
  const deposits = vfcBiqPositiveNumber_(raw.total_deposits) || vfcBiqPositiveNumber_(fallbackRow.totalDeposits);
  const withdrawals = vfcBiqPositiveNumber_(raw.total_withdrawals) || vfcBiqPositiveNumber_(fallbackRow.totalWithdrawals);

  return {
    headerSummary: {
      statementStartDate: start,
      statementEndDate: end,
      totalDeposits: vfcBiqRound_(deposits, 0.01),
      totalWithdrawals: vfcBiqRound_(withdrawals, 0.01),
      verifiedFromStructuredRead: !!(vfcBiqPositiveNumber_(raw.total_deposits) > 0)
    },
    debtPayments: vfcBiqNormalizeSignals_(raw.debt_payments, false),
    financingCredits: vfcBiqNormalizeSignals_(raw.financing_credits, true)
  };
}

function vfcBiqNormalizeSignals_(items, isCredit) {
  if (!Array.isArray(items)) return [];
  const allowedDebt = {
    TERM_LOAN:1, MCA:1, COMMERCIAL_LOAN:1, LOC:1, LEASE_FINANCE:1,
    INSURANCE_FINANCE:1, TAX_GOVERNMENT:1, CREDIT_CARD:1, OTHER_RECURRING_PAD:1
  };
  const allowedCredits = { MCA_ADVANCE:1, LOAN_ADVANCE:1, UNKNOWN_FINANCING_CREDIT:1 };
  const allowed = isCredit ? allowedCredits : allowedDebt;

  return vfcBiqDedupeSignals_(items.map(function(item) {
    item = item || {};
    const category = vfcBiqNormalizeCategory_(item.category, isCredit);
    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!allowed[category] || !(amount > 0)) return null;

    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '').trim().substring(0, 180),
      counterparty: String(item.counterparty || item.description || '').trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      category: category,
      confidence: vfcBiqConfidence_(item.confidence)
    };
  }).filter(Boolean));
}

function vfcBiqNormalizeCategory_(value, isCredit) {
  const text = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (isCredit) {
    if (/MCA/.test(text)) return 'MCA_ADVANCE';
    if (/LOAN/.test(text)) return 'LOAN_ADVANCE';
    return text === 'UNKNOWN_FINANCING_CREDIT' ? text : '';
  }
  if (/TERM.*LOAN|LOAN.*PAYMENT/.test(text)) return 'TERM_LOAN';
  if (/COMMERCIAL.*LOAN/.test(text)) return 'COMMERCIAL_LOAN';
  if (/MCA|MERCHANT.*CASH/.test(text)) return 'MCA';
  if (/LINE.*CREDIT|\bLOC\b/.test(text)) return 'LOC';
  if (/LEASE/.test(text)) return 'LEASE_FINANCE';
  if (/INSURANCE|IPFS|PREMIUM.*FINANCE/.test(text)) return 'INSURANCE_FINANCE';
  if (/TAX|CRA|CCRA|GOVERNMENT/.test(text)) return 'TAX_GOVERNMENT';
  if (/CREDIT.*CARD|CARD.*PAYMENT/.test(text)) return 'CREDIT_CARD';
  if (/OTHER.*PAD|RECURRING.*PAD|\bPAD\b/.test(text)) return 'OTHER_RECURRING_PAD';
  return text;
}

function vfcBiqSummaryRows_(companyName, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const col = {
    upload: vfcBiqColumn_(headers, 'Upload ID'),
    company: vfcBiqColumn_(headers, 'Company Name'),
    period: vfcBiqColumn_(headers, 'Detected Period'),
    file: vfcBiqColumn_(headers, 'File Name'),
    start: vfcBiqColumn_(headers, 'Statement Start Date'),
    end: vfcBiqColumn_(headers, 'Statement End Date'),
    deposits: vfcBiqColumn_(headers, 'Total Deposits'),
    withdrawals: vfcBiqColumn_(headers, 'Total Withdrawals'),
    nsf: vfcBiqColumn_(headers, 'NSF Count'),
    negative: vfcBiqColumn_(headers, 'Negative Balance Detected'),
    signal: vfcBiqColumn_(headers, 'Possible MCA Or Loan Payments'),
    created: vfcBiqColumn_(headers, 'Created At')
  };

  return values.slice(1).map(function(row, index) {
    return {
      uploadId: row[col.upload],
      companyName: row[col.company],
      detectedPeriod: row[col.period],
      fileName: String(row[col.file] || 'statement.pdf'),
      statementStartDate: row[col.start],
      statementEndDate: row[col.end],
      totalDeposits: row[col.deposits],
      totalWithdrawals: row[col.withdrawals],
      nsfCount: row[col.nsf],
      negativeBalanceDetected: row[col.negative],
      possibleMcaOrLoanPayments: row[col.signal],
      createdAt: row[col.created],
      rowNumber: index + 2,
      signalColumn: col.signal + 1
    };
  }).filter(function(row) {
    return (!companyName || sameText_(row.companyName, companyName)) &&
      (!period || sameText_(row.detectedPeriod, period));
  });
}

function vfcBiqUploadMap_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads');
  if (!sheet) return {};
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};
  const headers = values[0];
  const uploadCol = vfcBiqColumn_(headers, 'Upload ID');
  const fileCol = vfcBiqColumn_(headers, 'File ID');
  const nameCol = vfcBiqColumn_(headers, 'File Name');
  const map = {};

  values.slice(1).forEach(function(row) {
    const id = String(row[uploadCol] || '').trim();
    if (id) {
      map[id] = {
        fileId: String(row[fileCol] || '').trim(),
        fileName: String(row[nameCol] || '')
      };
    }
  });
  return map;
}

function vfcBiqLatestBatch_(rows) {
  const out = [];
  const seenFileNames = {};
  let lastTime = null;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const name = String(row.fileName || '').trim().toLowerCase();
    const created = vfcBiqDate_(row.createdAt);

    if (out.length) {
      if (name && seenFileNames[name]) break;
      if (created && lastTime !== null) {
        const gapMinutes = Math.abs(lastTime - created.getTime()) / 60000;
        if (gapMinutes > VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES) break;
      }
    }

    out.push(row);
    if (name) seenFileNames[name] = true;
    if (created) lastTime = created.getTime();
  }
  return out.reverse();
}

function vfcBiqAudit_(companyName, period, base) {
  const allRows = vfcBiqSummaryRows_(companyName, period);
  const latestRows = vfcBiqLatestBatch_(allRows);
  const byStatement = {};

  latestRows.forEach(function(row) {
    const payload = vfcBiqParseCell_(row.possibleMcaOrLoanPayments);
    const header = payload && payload.headerSummary ? payload.headerSummary : {};
    const start = header.statementStartDate || vfcBiqIsoDate_(row.statementStartDate);
    const end = header.statementEndDate || vfcBiqIsoDate_(row.statementEndDate);
    const key = start && end ? start + '|' + end : String(row.fileName || '').toLowerCase();
    byStatement[key] = row;
  });

  const rows = Object.keys(byStatement).map(function(key) { return byStatement[key]; });
  rows.sort(function(a, b) { return vfcBiqEffectiveDate_(a) - vfcBiqEffectiveDate_(b); });

  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let nsfCount = 0;
  let negativeBalanceFlag = 0;
  const starts = [];
  const ends = [];
  const distinctMonths = {};
  const monthlyDeposits = [];
  const monthlyWithdrawals = [];

  rows.forEach(function(row) {
    const payload = vfcBiqParseCell_(row.possibleMcaOrLoanPayments);
    const header = payload && payload.headerSummary ? payload.headerSummary : {};
    const start = vfcBiqDate_(header.statementStartDate || row.statementStartDate);
    const end = vfcBiqDate_(header.statementEndDate || row.statementEndDate);
    const deposits = vfcBiqPositiveNumber_(header.totalDeposits) || vfcBiqPositiveNumber_(row.totalDeposits);
    const withdrawals = vfcBiqPositiveNumber_(header.totalWithdrawals) || vfcBiqPositiveNumber_(row.totalWithdrawals);

    if (start) starts.push(start);
    if (end) ends.push(end);
    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    nsfCount += Math.max(0, vfcBiqNumber_(row.nsfCount));
    if (vfcBiqTruthyFlag_(row.negativeBalanceDetected)) negativeBalanceFlag = 1;
    monthlyDeposits.push(deposits);
    monthlyWithdrawals.push(withdrawals);

    const monthDate = end || start;
    if (monthDate) {
      distinctMonths[monthDate.getUTCFullYear() + '-' + ('0' + (monthDate.getUTCMonth() + 1)).slice(-2)] = true;
    }
  });

  const earliest = starts.length ? new Date(Math.min.apply(null, starts.map(function(d) { return d.getTime(); }))) : null;
  const latest = ends.length ? new Date(Math.max.apply(null, ends.map(function(d) { return d.getTime(); }))) : null;
  const spanMonths = earliest && latest
    ? Math.max(1, Math.round((((latest.getTime() - earliest.getTime()) / 86400000) + 1) / 30.4375))
    : 0;
  const monthCount = Object.keys(distinctMonths).length;
  const monthsCovered = Math.max(1, monthCount || spanMonths || rows.length || vfcBiqNumber_(base.monthsCovered) || 1);
  const olderRowsIgnored = Math.max(0, allRows.length - latestRows.length);
  const warnings = [];

  if (olderRowsIgnored > 0) {
    warnings.push('Using the latest upload batch; ' + olderRowsIgnored + ' older statement row(s) were ignored.');
  }

  return {
    rows: rows,
    allMatchingRows: allRows.length,
    latestBatchRows: latestRows.length,
    olderRowsIgnored: olderRowsIgnored,
    monthsCovered: monthsCovered,
    totalDeposits: totalDeposits,
    totalWithdrawals: totalWithdrawals,
    nsfCount: nsfCount,
    negativeBalanceFlag: negativeBalanceFlag,
    monthlyDeposits: monthlyDeposits,
    monthlyWithdrawals: monthlyWithdrawals,
    latestStatementDate: latest,
    warnings: warnings
  };
}

function vfcBiqDebtProfile_(rows, monthsCovered, latestStatementDate) {
  let payments = [];
  let credits = [];

  (rows || []).forEach(function(row) {
    const payload = vfcBiqParseCell_(row.possibleMcaOrLoanPayments);
    if (!payload) return;
    payments = payments.concat(payload.debtPayments || []);
    credits = credits.concat(payload.financingCredits || []);
  });

  payments = vfcBiqDedupeSignals_(payments);
  credits = vfcBiqDedupeSignals_(credits);

  const groups = {};
  payments.forEach(function(payment) {
    const key = payment.category + '|' + vfcBiqNormalizeCounterparty_(payment.counterparty || payment.description);
    if (!groups[key]) groups[key] = [];
    groups[key].push(payment);
  });

  const obligations = Object.keys(groups).map(function(key) {
    const items = groups[key].slice().sort(function(a, b) {
      return (vfcBiqDate_(a.date) || new Date(0)) - (vfcBiqDate_(b.date) || new Date(0));
    });
    const dates = items.map(function(item) { return vfcBiqDate_(item.date); }).filter(Boolean);
    const amounts = items.map(function(item) { return vfcBiqPositiveNumber_(item.amount); }).filter(function(n) { return n > 0; });
    const amount = vfcBiqMedian_(amounts);
    const frequency = vfcBiqFrequency_(dates, items.length, monthsCovered);
    const monthlyEquivalent = vfcBiqMonthlyEquivalent_(amount, frequency, items.length, monthsCovered);
    const lastDate = dates.length ? dates[dates.length - 1] : null;

    return {
      counterparty: items[0] ? (items[0].counterparty || items[0].description) : '',
      description: items[0] ? (items[0].description || '') : '',
      category: items[0] ? items[0].category : '',
      paymentAmount: vfcBiqRound_(amount, 0.01),
      frequency: frequency,
      monthlyEquivalent: vfcBiqRound_(monthlyEquivalent, 0.01),
      occurrences: items.length,
      firstSeen: dates.length ? vfcBiqIsoDate_(dates[0]) : '',
      lastSeen: lastDate ? vfcBiqIsoDate_(lastDate) : '',
      active: vfcBiqIsActive_(lastDate, latestStatementDate, frequency),
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

  const validCredits = credits.filter(function(item) { return item.confidence !== 'Low'; });

  return {
    confirmedMonthlyDebtService: vfcBiqRound_(activeDebt.reduce(function(sum, item) {
      return sum + item.monthlyEquivalent;
    }, 0), 0.01),
    otherRecurringMonthlyObligations: vfcBiqRound_(otherRecurring.reduce(function(sum, item) {
      return sum + item.monthlyEquivalent;
    }, 0), 0.01),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxPads,
    allDetectedObligations: obligations,
    financingCredits: validCredits,
    financingCreditsTotal: vfcBiqRound_(validCredits.reduce(function(sum, item) {
      return sum + vfcBiqPositiveNumber_(item.amount);
    }, 0), 0.01),
    note: 'Transactions are extracted as structured items by OpenAI. Frequency is inferred locally from the observed dates. Outstanding balances are not inferred.'
  };
}

function vfcBiqParseCell_(value) {
  const text = String(value || '').trim();
  if (text.indexOf(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX) !== 0) return null;
  try {
    const parsed = JSON.parse(text.substring(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length));
    return {
      version: vfcBiqNumber_(parsed.version),
      headerSummary: parsed.headerSummary || {},
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
    if (!item) return false;
    const key = [
      vfcBiqIsoDate_(item.date),
      vfcBiqRound_(vfcBiqPositiveNumber_(item.amount), 0.01),
      String(item.category || ''),
      vfcBiqNormalizeCounterparty_(item.counterparty || item.description)
    ].join('|').toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function vfcBiqFrequency_(dates, occurrences, monthsCovered) {
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
  amount = Math.max(0, vfcBiqPositiveNumber_(amount));
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

function vfcBiqConfidence_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'high') return 'High';
  if (text === 'low') return 'Low';
  return 'Moderate';
}

function vfcBiqColumn_(headers, wanted) {
  const target = String(wanted || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').toLowerCase().replace(/[^a-z0-9]/g, '') === target) return i;
  }
  throw new Error('Missing required column: ' + wanted);
}

function vfcBiqEffectiveDate_(row) {
  const payload = vfcBiqParseCell_(row.possibleMcaOrLoanPayments);
  const header = payload && payload.headerSummary ? payload.headerSummary : {};
  return vfcBiqDate_(header.statementEndDate || row.statementEndDate || header.statementStartDate || row.statementStartDate) || new Date(0);
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

function vfcBiqRequest_(companyOrRequest, requestedPeriod) {
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

function vfcBiqPositiveNumber_(value) {
  return Math.max(0, vfcBiqNumber_(value));
}

function vfcBiqTruthyFlag_(value) {
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
  const average = numbers.reduce(function(sum, value) { return sum + value; }, 0) / numbers.length;
  if (!average) return 1;
  const variance = numbers.reduce(function(sum, value) { return sum + Math.pow(value - average, 2); }, 0) / numbers.length;
  return Math.sqrt(variance) / average;
}

function vfcBiqTrend_(values) {
  const numbers = (values || []).map(vfcBiqNumber_);
  if (numbers.length < 2) return 0;
  const split = Math.max(1, Math.floor(numbers.length / 2));
  const first = numbers.slice(0, split);
  const second = numbers.slice(split);
  const firstAverage = first.reduce(function(sum, value) { return sum + value; }, 0) / first.length;
  const secondAverage = second.length
    ? second.reduce(function(sum, value) { return sum + value; }, 0) / second.length
    : firstAverage;
  return firstAverage > 0 ? (secondAverage - firstAverage) / firstAverage : 0;
}
