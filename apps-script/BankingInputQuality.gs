const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-6.0-DETERMINISTIC',
  SIGNAL_PREFIX: 'VFC_BANKING_V9:',
  PAYLOAD_VERSION: 9,
  MAX_STATEMENTS: 12,
  LATEST_BATCH_GAP_MINUTES: 10,
  MAX_STATEMENT_GAP_DAYS: 75,
  ACTIVE_LOOKBACK_DAYS: 75,
  TD_RECONCILE_TOLERANCE_DOLLARS: 5
};

/**
 * VFC deterministic banking-input layer.
 *
 * Design rules:
 * - Same statement set must produce the same banking metrics every time.
 * - OpenAI never calculates TD statement deposit/withdrawal totals.
 * - TD totals are the sum of the page-level Credits/Debits subtotals and are
 *   accepted only when they reconcile opening + credits - debits = closing.
 * - Recurring obligations are calculated locally from exact transaction
 *   descriptions, amounts and dates. Fees are never treated as debt.
 * - Explicit loan/finance/PAD descriptions may become confirmed financing debt.
 * - Tax, insurance, credit-card and unclear recurring items stay informational.
 * - No lender name is required or hard-coded for recurring PAD detection.
 * - No sheets are created/deleted and no debt multiplier is added to Our Max.
 */

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const request = vfcBiqNormalizeRequest_(companyOrRequest, requestedPeriod);
    const period = request.period || (
      typeof resolveLatestAssessmentPeriod_ === 'function'
        ? resolveLatestAssessmentPeriod_(request.companyName, request.period)
        : request.period
    );
    return vfcBiqRefresh_(request.companyName, period);
  } catch (error) {
    return {
      ok: false,
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      filesAnalyzed: 0,
      filesReused: 0,
      filesSkipped: 0,
      errors: [String(error && error.message || error)]
    };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcBiqReadSummaryRows_('', '');
  if (!rows.length) throw new Error('PDF Summaries has no records.');
  const latest = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({
    companyName: latest.companyName,
    period: latest.detectedPeriod
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseLatestBankingInputs() {
  const rows = vfcBiqReadSummaryRows_('', '');
  if (!rows.length) throw new Error('PDF Summaries has no records.');
  const latest = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({
    companyName: latest.companyName,
    period: latest.detectedPeriod
  });
  console.log(JSON.stringify({
    ok: result.ok,
    modelVersion: result.modelVersion,
    companyName: result.companyName,
    period: result.period,
    filesAnalyzed: result.filesAnalyzed,
    filesReused: result.filesReused,
    filesSkipped: result.filesSkipped,
    errors: result.errors,
    statementAudit: result.statementAudit,
    debtProfile: result.debtProfile
  }, null, 2));
  return result;
}

function getBankingInputQualityStatus() {
  const result = {
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    tdDepositMethod: 'sum page Credits subtotals + balance reconciliation',
    tdWithdrawalMethod: 'sum page Debits subtotals + balance reconciliation',
    recurringDebtMethod: 'deterministic description + amount + date recurrence',
    lenderAgnosticPadDetection: true,
    excludesFeesFromDebt: true,
    separatesTaxAndInsurance: true,
    reusesSameStatementResults: true,
    maxStatements: VFC_BANKING_INPUT_CONFIG.MAX_STATEMENTS,
    createsNewSheets: false,
    changesProductionFormula: false
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName, period)
    : (typeof buildFeaturesForCase_ === 'function'
      ? buildFeaturesForCase_(companyName, period)
      : null);

  if (!base) return null;

  const audit = vfcBiqBuildAudit_(companyName, period, base);

  // Historical training records that have never been processed by this layer
  // continue using their existing features. Current assessments are refreshed
  // before this function is called, so they will have V9 payloads.
  if (!audit.rows.length || audit.processedRows === 0) return base;

  if (audit.processedRows !== audit.rows.length) {
    throw new Error(
      'Banking input validation is incomplete: ' +
      audit.processedRows + ' of ' + audit.rows.length +
      ' current statements were verified. Re-run the assessment.'
    );
  }

  if (!audit.allStatementsVerified) {
    throw new Error(
      'One or more current bank statements failed deposit/withdrawal reconciliation. ' +
      'The engine stopped rather than estimate from inconsistent inputs.'
    );
  }

  const debtProfile = vfcBiqBuildDebtProfile_(
    audit.rows,
    audit.monthsCovered,
    audit.latestStatementDate
  );

  const grossMonthlyDeposits = audit.totalDeposits / Math.max(1, audit.monthsCovered);
  const operatingTotalDeposits = Math.max(
    0,
    audit.totalDeposits - debtProfile.financingCreditsTotal
  );
  const operatingMonthlyDeposits = operatingTotalDeposits / Math.max(1, audit.monthsCovered);

  const warnings = audit.warnings.slice();
  const oldAverage = vfcBiqNumber_(base.averageMonthlyDeposits);
  if (
    oldAverage > 0 && grossMonthlyDeposits > 0 &&
    Math.abs(oldAverage - grossMonthlyDeposits) / grossMonthlyDeposits >= 0.05
  ) {
    warnings.push(
      'Average monthly deposits corrected from ' +
      vfcBiqRound_(oldAverage, 1) + ' to ' +
      vfcBiqRound_(grossMonthlyDeposits, 1) +
      ' using reconciled statement totals.'
    );
  }

  return Object.assign({}, base, {
    statementCount: audit.rows.length,
    monthsCovered: audit.monthsCovered,
    totalDeposits: vfcBiqRound_(audit.totalDeposits, 0.01),
    averageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
    totalWithdrawals: vfcBiqRound_(audit.totalWithdrawals, 0.01),
    depositWithdrawalRatio: vfcBiqRound_(
      audit.totalWithdrawals ? audit.totalDeposits / audit.totalWithdrawals : 0,
      0.01
    ),
    nsfCount: audit.nsfCount,
    nsfPerMonth: vfcBiqRound_(audit.nsfCount / Math.max(1, audit.monthsCovered), 0.01),
    negativeBalanceFlag: audit.negativeBalanceFlag,
    mcaPaymentFlag: debtProfile.activeDebtObligations.length ? 1 : 0,
    monthlyDeposits: audit.monthlyDeposits,
    monthlyWithdrawals: audit.monthlyWithdrawals,
    depositVolatility: vfcBiqRound_(vfcBiqCoefficientOfVariation_(audit.monthlyDeposits), 0.01),
    depositTrend: vfcBiqRound_(vfcBiqTrend_(audit.monthlyDeposits), 0.01),
    estimatedOperatingTotalDeposits: vfcBiqRound_(operatingTotalDeposits, 0.01),
    estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
    detectedFinancingCredits: vfcBiqRound_(debtProfile.financingCreditsTotal, 0.01),
    existingMonthlyDebtService: vfcBiqRound_(debtProfile.confirmedMonthlyDebtService, 0.01),
    // Informational recurring items are displayed in debtProfile but are not
    // supplied as a capacity deduction.
    otherRecurringMonthlyObligations: 0,
    informationalRecurringMonthlyObligations: vfcBiqRound_(debtProfile.informationalMonthlyObligations, 0.01),
    debtServiceToDepositsRatio: grossMonthlyDeposits > 0
      ? vfcBiqRound_(debtProfile.confirmedMonthlyDebtService / grossMonthlyDeposits, 0.0001)
      : 0,
    debtProfile: debtProfile,
    inputQualityAudit: {
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      verified: true,
      allMatchingRows: audit.allMatchingRows,
      latestBatchRows: audit.latestBatchRows,
      selectedStatementRows: audit.rows.length,
      duplicatesIgnored: audit.duplicatesIgnored,
      olderOrDisconnectedRowsIgnored: audit.olderOrDisconnectedRowsIgnored,
      validatedMonthsCovered: audit.monthsCovered,
      grossAverageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
      estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
      statementAudit: audit.statementAudit,
      warnings: warnings
    }
  });
}

function vfcBiqRefresh_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = ss.getSheetByName('PDF Summaries');
  if (!summarySheet) throw new Error('Missing PDF Summaries sheet.');

  const allRowsForPeriod = vfcBiqReadSummaryRows_(companyName, period);
  if (!allRowsForPeriod.length) {
    throw new Error('No PDF Summary rows found for this company and period.');
  }

  const latestBatch = vfcBiqLatestBatch_(allRowsForPeriod);
  const rows = vfcBiqCurrentStatementWindow_(latestBatch);
  if (!rows.length) throw new Error('No current bank-statement rows were selected.');

  const allCompanyRows = vfcBiqReadSummaryRows_(companyName, '');
  const reusable = vfcBiqReusablePayloadMap_(allCompanyRows);
  const uploadMap = vfcBiqUploadMap_();

  let filesAnalyzed = 0;
  let filesReused = 0;
  let filesSkipped = 0;
  const errors = [];

  rows.forEach(function(row) {
    const current = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if (current && current.version >= VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION && current.inputVerified) {
      filesSkipped++;
      return;
    }

    const identity = vfcBiqStatementIdentity_(row);
    const prior = reusable[identity];
    if (prior && prior.inputVerified) {
      summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(
        VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(prior)
      );
      filesReused++;
      return;
    }

    const upload = uploadMap[String(row.uploadId || '')] || {};
    if (!upload.fileId) {
      errors.push(row.fileName + ': upload file ID not found.');
      return;
    }

    try {
      const text = extractTextFromPdf_(upload.fileId);
      const payload = vfcBiqAnalyzeStatement_(text, row);
      summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(
        VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload)
      );
      filesAnalyzed++;
    } catch (error) {
      errors.push(row.fileName + ': ' + String(error && error.message || error));
    }
  });

  let features = null;
  try {
    features = getValidatedBankingFeatures_(companyName, period);
  } catch (error) {
    errors.push(String(error && error.message || error));
  }

  return {
    ok: errors.length === 0,
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    filesAnalyzed: filesAnalyzed,
    filesReused: filesReused,
    filesSkipped: filesSkipped,
    errors: errors,
    statementAudit: features && features.inputQualityAudit
      ? features.inputQualityAudit.statementAudit || []
      : [],
    debtProfile: features && features.debtProfile ? features.debtProfile : {},
    inputQualityAudit: features && features.inputQualityAudit ? features.inputQualityAudit : {}
  };
}

function vfcBiqAnalyzeStatement_(text, row) {
  const isTd = /TD\s+Canada\s+Trust|TORONTO-DOMINION\s+BANK/i.test(String(text || '')) ||
    /Toronto[- ]Dominion|TD Canada/i.test(String(row.bankName || ''));

  let totals;
  let candidates = [];
  let financingCredits = [];
  let deterministicNsf = null;

  if (isTd) {
    totals = vfcBiqParseTdTotals_(text, row);
    candidates = vfcBiqParseTdCandidates_(text, row);
    deterministicNsf = vfcBiqCountTdNsf_(text);
  } else {
    totals = vfcBiqFallbackTotals_(row);
    const extracted = vfcBiqExtractFallbackCandidatesWithOpenAI_(text, row);
    candidates = extracted.paymentCandidates;
    financingCredits = extracted.financingCredits;
  }

  if (!totals || !totals.verified) {
    throw new Error(
      'statement totals could not be verified' +
      (totals && totals.reason ? ' (' + totals.reason + ')' : '')
    );
  }

  return {
    version: VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION,
    analyzedAt: new Date().toISOString(),
    statementIdentity: vfcBiqStatementIdentity_(row),
    fileName: row.fileName,
    bankName: row.bankName || '',
    method: isTd ? 'TD_PAGE_TOTALS_DETERMINISTIC' : 'SUMMARY_TOTALS_VERIFIED',
    inputVerified: true,
    headerSummary: {
      statementStartDate: totals.statementStartDate,
      statementEndDate: totals.statementEndDate,
      openingBalance: totals.openingBalance,
      closingBalance: totals.closingBalance,
      totalDeposits: totals.totalDeposits,
      totalWithdrawals: totals.totalWithdrawals,
      reconciliationDifference: totals.reconciliationDifference,
      pageCreditSubtotals: totals.pageCreditSubtotals || [],
      pageDebitSubtotals: totals.pageDebitSubtotals || []
    },
    nsfCount: deterministicNsf === null ? vfcBiqNumber_(row.nsfCount) : deterministicNsf,
    paymentCandidates: vfcBiqDedupeSignals_(candidates),
    financingCredits: vfcBiqFilterFinancingCredits_(financingCredits)
  };
}

function vfcBiqParseTdTotals_(text, row) {
  text = String(text || '');
  const creditValues = vfcBiqRegexMoneyValues_(text, /\bCredits\s+\d+\s+([0-9][0-9,]*\.\d{2})/gi);
  const debitValues = vfcBiqRegexMoneyValues_(text, /\bDebits\s+\d+\s+([0-9][0-9,]*\.\d{2})/gi);

  if (!creditValues.length || !debitValues.length) {
    return { verified: false, reason: 'TD page Credits/Debits subtotals were not found' };
  }

  const totalDeposits = vfcBiqSum_(creditValues);
  const totalWithdrawals = vfcBiqSum_(debitValues);
  const balances = vfcBiqParseTdOpeningClosing_(text, row);
  const opening = balances.openingBalance;
  const closing = balances.closingBalance;
  const difference = (opening !== null && closing !== null)
    ? Math.abs((opening + totalDeposits - totalWithdrawals) - closing)
    : 0;

  const tolerance = VFC_BANKING_INPUT_CONFIG.TD_RECONCILE_TOLERANCE_DOLLARS;
  if (opening !== null && closing !== null && difference > tolerance) {
    return {
      verified: false,
      reason: 'TD page totals failed balance reconciliation by $' + vfcBiqRound_(difference, 0.01)
    };
  }

  return {
    verified: true,
    statementStartDate: vfcBiqIsoDate_(row.statementStartDate),
    statementEndDate: vfcBiqIsoDate_(row.statementEndDate),
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: vfcBiqRound_(totalDeposits, 0.01),
    totalWithdrawals: vfcBiqRound_(totalWithdrawals, 0.01),
    reconciliationDifference: vfcBiqRound_(difference, 0.01),
    pageCreditSubtotals: creditValues.map(function(v) { return vfcBiqRound_(v, 0.01); }),
    pageDebitSubtotals: debitValues.map(function(v) { return vfcBiqRound_(v, 0.01); })
  };
}

function vfcBiqParseTdOpeningClosing_(text, row) {
  const lines = String(text || '').split(/\r?\n/);
  let opening = null;
  let closing = null;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '').replace(/\u00a0/g, ' ').trim();
    if (!line) continue;

    if (opening === null && /BALANCE\s+FORWARD/i.test(line)) {
      const match = line.match(/BALANCE\s+FORWARD\s+[A-Z]{3}\s*\d{1,2}\s+([0-9,]+\.\d{2})(OD)?/i);
      if (match) {
        opening = vfcBiqNumber_(match[1]);
        if (match[2]) opening = -opening;
      }
    }

    const dateMatch = line.match(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s*\d{1,2}\b/i);
    if (dateMatch) {
      const afterDate = line.substring((dateMatch.index || 0) + dateMatch[0].length);
      const trailing = afterDate.match(/([0-9,]+\.\d{2})(OD)?\s*$/);
      if (trailing) {
        closing = vfcBiqNumber_(trailing[1]);
        if (trailing[2]) closing = -closing;
      }
    }
  }

  if (opening === null && row.openingBalance !== '' && row.openingBalance !== null && row.openingBalance !== undefined) {
    opening = vfcBiqNumberSigned_(row.openingBalance);
  }
  if (closing === null && row.closingBalance !== '' && row.closingBalance !== null && row.closingBalance !== undefined) {
    closing = vfcBiqNumberSigned_(row.closingBalance);
  }

  return { openingBalance: opening, closingBalance: closing };
}

function vfcBiqFallbackTotals_(row) {
  const deposits = vfcBiqPositiveNumber_(row.totalDeposits);
  const withdrawals = vfcBiqPositiveNumber_(row.totalWithdrawals);
  if (!(deposits > 0) || !(withdrawals >= 0)) {
    return { verified: false, reason: 'summary totals are missing' };
  }

  const opening = vfcBiqNullableNumber_(row.openingBalance);
  const closing = vfcBiqNullableNumber_(row.closingBalance);
  let difference = 0;
  if (opening !== null && closing !== null) {
    difference = Math.abs((opening + deposits - withdrawals) - closing);
    const tolerance = Math.max(5, Math.max(deposits, withdrawals) * 0.005);
    if (difference > tolerance) {
      return { verified: false, reason: 'summary totals failed balance reconciliation' };
    }
  }

  return {
    verified: true,
    statementStartDate: vfcBiqIsoDate_(row.statementStartDate),
    statementEndDate: vfcBiqIsoDate_(row.statementEndDate),
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: vfcBiqRound_(deposits, 0.01),
    totalWithdrawals: vfcBiqRound_(withdrawals, 0.01),
    reconciliationDifference: vfcBiqRound_(difference, 0.01)
  };
}

function vfcBiqParseTdCandidates_(text, row) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const start = vfcBiqDate_(row.statementStartDate);
  const end = vfcBiqDate_(row.statementEndDate);

  lines.forEach(function(rawLine) {
    const line = String(rawLine || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) return;
    if (/BALANCE FORWARD|MONTHLY AVER|MONTHLY MIN|NEXT STATEMENT|\bCredits\b|\bDebits\b/i.test(line)) return;

    const dateMatch = line.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s*([0-3]?\d)\b/i);
    if (!dateMatch) return;

    const prefix = line.substring(0, dateMatch.index || 0).trim();
    const moneyMatches = [];
    const moneyRegex = /([0-9][0-9,]*\.\d{2})/g;
    let match;
    while ((match = moneyRegex.exec(prefix)) !== null) {
      moneyMatches.push({ value: match[1], index: match.index });
    }
    if (!moneyMatches.length) return;

    const amountToken = moneyMatches[moneyMatches.length - 1];
    const amount = vfcBiqPositiveNumber_(amountToken.value);
    if (!(amount > 0)) return;

    let description = prefix.substring(0, amountToken.index).trim();
    description = description.replace(/^[-|\s]+/, '').replace(/\s+/g, ' ').trim();
    if (!description) return;

    const category = vfcBiqClassifyTdDescription_(description, amount);
    if (!category) return;

    const date = vfcBiqResolveTransactionDate_(dateMatch[1], dateMatch[2], start, end);
    if (!date) return;

    out.push({
      date: vfcBiqIsoDate_(date),
      description: description.substring(0, 160),
      counterparty: description.substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      category: category,
      confidence: category === 'OTHER_RECURRING' ? 'Moderate' : 'High'
    });
  });

  return out;
}

function vfcBiqClassifyTdDescription_(description, amount) {
  const text = String(description || '').toUpperCase();

  // Fees are operating charges, not debt service.
  if (/\bFEE\b|SERVICE\s+CHRG|SERVICE\s+CHARGE|MONTHLY\s+PLAN|NSF|RTD\s+CHQ|RETURN\s+FEE|PAYMENT\s+COVERAGE/i.test(text)) {
    return '';
  }

  if (/\bCRA\b|\bCCRA\b|GST-P|\bGST\b|\bHST\b|SOURCE\s+D|\bTAX\b|\bWCB\b|\bEMPTX\b|\bTXBAL\b/i.test(text)) {
    return 'TAX_GOVERNMENT';
  }

  if (/\bIPFS\b|PREMIUM\s+FIN|INSURANCE\s+FIN|\bINSURANCE\b/i.test(text)) {
    return 'INSURANCE_FINANCE';
  }

  if (/CREDIT\s+CARD\s+PAYMENT|C\/C\s+PAYMENT/i.test(text)) {
    return 'CREDIT_CARD';
  }

  if (/\bPAD\b|PRE[- ]?AUTH(?:ORIZED)?|PREAUTHORIZED/i.test(text)) {
    return amount >= 50 ? 'RECURRING_PAD' : '';
  }

  if (/\bMCA\b|MERCHANT\s+CASH\s+ADVANCE|CASH\s+ADVANCE\s+PAY/i.test(text)) {
    return 'MCA';
  }

  if (/TRUCK\s*FIN|TRUCKFIN/i.test(text)) return 'TRUCK_FINANCE';
  if (/\bAUTO\s+FIN|\bVEHICLE\s+FIN|CREDIT\s+CA\s+(?:APY|PAY|PAA)/i.test(text)) return 'AUTO_FINANCE';
  if (/\bLINE\s+OF\s+CREDIT\b|\bLOC\b/i.test(text)) return 'LOC';
  if (/\bLEASE\b/i.test(text)) return 'LEASE_FINANCE';
  if (/\bLOAN\b|LOAN\s+PYMT|LOAN\s+PAYMENT/i.test(text)) return 'TERM_LOAN';
  if (/\bFINANC(?:E|IAL|ING)\b/i.test(text)) return 'OTHER_FINANCING_PAYMENT';

  // Short coded recurring debits are useful context but are not promoted to
  // financing debt without explicit loan/finance/PAD language.
  if (/\bRLS\b|\bBUS\b\s*$/i.test(text)) return 'OTHER_RECURRING';

  return '';
}

function vfcBiqCountTdNsf_(text) {
  const matches = String(text || '').match(/\bNSF\s+(?:PAID|RETURN|RETURNED)?\s*FEE\b/gi);
  return matches ? matches.length : 0;
}

function vfcBiqExtractFallbackCandidatesWithOpenAI_(text, row) {
  if (typeof callOpenAIJson_ !== 'function') {
    return { paymentCandidates: [], financingCredits: [] };
  }

  const prompt = [
    'You are a bank-statement transaction extractor. Return JSON only.',
    'Extract exact debit transactions that are clearly loan, financing, MCA, lease/LOC, PAD/pre-authorized, tax PAD, insurance finance, or credit-card payments.',
    'Do not decide recurrence. Return each visible occurrence separately.',
    'Never use a nearby amount. Omit uncertain transactions.',
    'Fees, service charges, suppliers, payroll, purchases, ordinary transfers and e-transfers are not financing debt.',
    'Also return incoming financing credits only when the transaction explicitly says loan/financing/funding/cash-advance proceeds.',
    'Return: {payment_candidates:[{date,description,counterparty,amount,kind,confidence}], financing_credits:[{date,description,counterparty,amount,kind,confidence}]}',
    'Allowed payment kinds: LOAN_PAYMENT, MCA_PAYMENT, FINANCING_PAYMENT, PAD, TAX_PAD, INSURANCE_FINANCE, CREDIT_CARD_PAYMENT.',
    'Allowed financing credit kinds: LOAN_ADVANCE, MCA_ADVANCE, OTHER_FINANCING_CREDIT.',
    'Use YYYY-MM-DD dates. Confidence: High, Moderate, Low.',
    'Statement dates: ' + String(row.statementStartDate || '') + ' to ' + String(row.statementEndDate || ''),
    'STATEMENT TEXT:',
    String(text || '').substring(0, 60000)
  ].join('\n');

  const raw = callOpenAIJson_(prompt) || {};
  return {
    paymentCandidates: vfcBiqNormalizeFallbackPayments_(raw.payment_candidates),
    financingCredits: vfcBiqNormalizeFallbackCredits_(raw.financing_credits)
  };
}

function vfcBiqNormalizeFallbackPayments_(items) {
  if (!Array.isArray(items)) return [];
  const map = {
    LOAN_PAYMENT: 'TERM_LOAN',
    MCA_PAYMENT: 'MCA',
    FINANCING_PAYMENT: 'OTHER_FINANCING_PAYMENT',
    PAD: 'RECURRING_PAD',
    TAX_PAD: 'TAX_GOVERNMENT',
    INSURANCE_FINANCE: 'INSURANCE_FINANCE',
    CREDIT_CARD_PAYMENT: 'CREDIT_CARD'
  };
  return items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!map[kind] || !(amount > 0)) return null;
    const description = String(item.description || item.counterparty || '').trim();
    if (/\bFEE\b|SERVICE\s+CHARGE|NSF|PAYMENT\s+COVERAGE/i.test(description)) return null;
    return {
      date: vfcBiqIsoDate_(item.date),
      description: description.substring(0, 160),
      counterparty: String(item.counterparty || description).trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      category: map[kind],
      confidence: vfcBiqConfidence_(item.confidence)
    };
  }).filter(Boolean);
}

function vfcBiqNormalizeFallbackCredits_(items) {
  if (!Array.isArray(items)) return [];
  const allowed = { LOAN_ADVANCE:1, MCA_ADVANCE:1, OTHER_FINANCING_CREDIT:1 };
  return items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!allowed[kind] || !(amount >= 5000) || vfcBiqConfidence_(item.confidence) !== 'High') return null;
    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '').trim().substring(0, 160),
      counterparty: String(item.counterparty || item.description || '').trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      category: kind,
      confidence: 'High'
    };
  }).filter(Boolean);
}

function vfcBiqFilterFinancingCredits_(items) {
  return vfcBiqDedupeSignals_((items || []).filter(function(item) {
    return item && vfcBiqPositiveNumber_(item.amount) >= 5000 && item.confidence === 'High';
  }));
}

function vfcBiqBuildDebtProfile_(rows, monthsCovered, latestStatementDate) {
  let payments = [];
  let credits = [];

  (rows || []).forEach(function(row) {
    const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if (!payload || !payload.inputVerified) return;
    payments = payments.concat(payload.paymentCandidates || []);
    credits = credits.concat(payload.financingCredits || []);
  });

  payments = vfcBiqDedupeSignals_(payments);
  credits = vfcBiqFilterFinancingCredits_(credits);

  const groups = vfcBiqGroupPayments_(payments);
  const obligations = groups.map(function(group) {
    return vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate);
  }).filter(Boolean);

  obligations.sort(function(a, b) { return b.monthlyEquivalent - a.monthlyEquivalent; });

  const confirmedDebtCategories = {
    TERM_LOAN:1,
    TRUCK_FINANCE:1,
    AUTO_FINANCE:1,
    COMMERCIAL_LOAN:1,
    LOC:1,
    LEASE_FINANCE:1,
    MCA:1,
    OTHER_FINANCING_PAYMENT:1,
    RECURRING_PAD:1
  };

  const activeDebt = obligations.filter(function(item) {
    return item.active && item.recurring && confirmedDebtCategories[item.category] && item.confidence !== 'Low';
  });

  const taxGovernmentPads = obligations.filter(function(item) {
    return item.active && item.recurring && item.category === 'TAX_GOVERNMENT';
  });

  const otherRecurring = obligations.filter(function(item) {
    return item.active && item.recurring && !confirmedDebtCategories[item.category] && item.category !== 'TAX_GOVERNMENT';
  });

  const observedOnce = obligations.filter(function(item) { return !item.recurring; });

  const confirmedMonthlyDebtService = activeDebt.reduce(function(sum, item) {
    return sum + item.monthlyEquivalent;
  }, 0);
  const taxMonthly = taxGovernmentPads.reduce(function(sum, item) {
    return sum + item.monthlyEquivalent;
  }, 0);
  const otherMonthly = otherRecurring.reduce(function(sum, item) {
    return sum + item.monthlyEquivalent;
  }, 0);

  return {
    confirmedMonthlyDebtService: vfcBiqRound_(confirmedMonthlyDebtService, 0.01),
    otherRecurringMonthlyObligations: 0,
    informationalMonthlyObligations: vfcBiqRound_(taxMonthly + otherMonthly, 0.01),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxGovernmentPads,
    observedOnce: observedOnce,
    allDetectedObligations: obligations,
    financingCredits: credits,
    financingCreditsTotal: vfcBiqRound_(credits.reduce(function(sum, item) {
      return sum + vfcBiqPositiveNumber_(item.amount);
    }, 0), 0.01),
    note: 'Confirmed debt uses only recurring transactions with explicit loan/finance/MCA/PAD language. Tax, insurance, credit-card and unclear recurring items are informational only. Fees are excluded.'
  };
}

function vfcBiqGroupPayments_(payments) {
  const groups = {};
  (payments || []).forEach(function(item) {
    if (!item || !item.date || !(vfcBiqPositiveNumber_(item.amount) > 0)) return;
    const label = vfcBiqCanonicalLabel_(item);
    if (!label) return;
    const key = vfcBiqCategoryFamily_(item.category) + '|' + label;
    if (!groups[key]) {
      groups[key] = { category: item.category, label: label, items: [] };
    }
    groups[key].items.push(Object.assign({}, item, { label: label }));
  });
  return Object.keys(groups).map(function(key) { return groups[key]; });
}

function vfcBiqCategoryFamily_(category) {
  if (category === 'TAX_GOVERNMENT') return 'TAX_GOVERNMENT';
  if (category === 'INSURANCE_FINANCE') return 'INSURANCE_FINANCE';
  if (category === 'CREDIT_CARD') return 'CREDIT_CARD';
  if (category === 'OTHER_RECURRING') return 'OTHER_RECURRING';
  return 'FINANCING';
}

function vfcBiqCanonicalLabel_(item) {
  const raw = String((item && (item.counterparty || item.description)) || '').toUpperCase();
  const category = String((item && item.category) || '');
  if (category === 'TAX_GOVERNMENT') {
    if (/\bCRA\b|\bCCRA\b/.test(raw)) return 'CRA CCRA TAX';
    if (/GST-P|\bGST\b|\bHST\b/.test(raw)) return 'GST HST TAX';
    if (/\bEMPTX\b/.test(raw)) return 'EMPLOYER TAX';
    if (/\bTXBAL\b/.test(raw)) return 'TAX BALANCE';
    if (/\bWCB\b/.test(raw)) return 'WCB';
  }
  return raw
    .replace(/\b(?:PAYMENT|PAYMENTS|PYMT|PMT|PAA|APY|MSP|PAD|PREAUTHORIZED|PRE-AUTHORIZED|DEBIT|WITHDRAWAL|EFT)\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
}

function vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate) {
  if (!group || !group.items || !group.items.length) return null;

  const seen = {};
  const items = group.items.filter(function(item) {
    const key = vfcBiqIsoDate_(item.date) + '|' + vfcBiqRound_(item.amount, 0.01);
    if (!item.date || seen[key]) return false;
    seen[key] = true;
    return true;
  }).sort(function(a, b) {
    return (vfcBiqDate_(a.date) || new Date(0)) - (vfcBiqDate_(b.date) || new Date(0));
  });

  if (!items.length) return null;
  const dates = items.map(function(item) { return vfcBiqDate_(item.date); }).filter(Boolean);
  const amounts = items.map(function(item) { return vfcBiqPositiveNumber_(item.amount); }).filter(function(v) { return v > 0; });
  if (!dates.length || !amounts.length) return null;

  const occurrences = dates.length;
  const recurring = occurrences >= 2;
  const frequency = recurring ? vfcBiqInferFrequency_(dates, occurrences, monthsCovered) : 'Observed once';
  const paymentAmount = vfcBiqMedian_(amounts);
  const monthlyEquivalent = recurring
    ? vfcBiqMonthlyEquivalent_(paymentAmount, frequency, occurrences, monthsCovered)
    : 0;
  const lastDate = dates[dates.length - 1];
  const confidence = vfcBiqGroupConfidence_(items);

  return {
    counterparty: vfcBiqBestCounterparty_(items),
    description: items[0].description || '',
    category: group.category,
    paymentAmount: vfcBiqRound_(paymentAmount, 0.01),
    frequency: frequency,
    monthlyEquivalent: vfcBiqRound_(monthlyEquivalent, 0.01),
    occurrences: occurrences,
    firstSeen: vfcBiqIsoDate_(dates[0]),
    lastSeen: vfcBiqIsoDate_(lastDate),
    recurring: recurring,
    active: recurring ? vfcBiqIsActive_(lastDate, latestStatementDate, frequency) : false,
    confidence: confidence,
    patternLabel: group.label
  };
}

function vfcBiqInferFrequency_(dates, occurrences, monthsCovered) {
  if (dates && dates.length >= 2) {
    const sorted = dates.slice().sort(function(a, b) { return a - b; });
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      const days = Math.abs((sorted[i].getTime() - sorted[i - 1].getTime()) / 86400000);
      if (days > 0) intervals.push(days);
    }
    const medianDays = vfcBiqMedian_(intervals);
    if (medianDays <= 4) return 'Business daily';
    if (medianDays <= 10) return 'Weekly';
    if (medianDays <= 20) return 'Biweekly';
    if (medianDays <= 45) return 'Monthly';
    if (medianDays <= 75) return 'Every 2 months';
    return 'Irregular';
  }

  const perMonth = occurrences / Math.max(1, monthsCovered || 1);
  if (perMonth >= 3) return 'Weekly';
  if (perMonth >= 1.5) return 'Biweekly';
  if (perMonth >= 0.65) return 'Monthly';
  return 'Irregular';
}

function vfcBiqMonthlyEquivalent_(amount, frequency, occurrences, monthsCovered) {
  amount = vfcBiqPositiveNumber_(amount);
  if (!(amount > 0)) return 0;
  if (frequency === 'Business daily') return amount * 21.7;
  if (frequency === 'Weekly') return amount * 4.33;
  if (frequency === 'Biweekly') return amount * 2.17;
  if (frequency === 'Monthly') return amount;
  if (frequency === 'Every 2 months') return amount * 0.5;
  return amount * Math.max(1, occurrences) / Math.max(1, monthsCovered || 1);
}

function vfcBiqIsActive_(lastDate, latestStatementDate, frequency) {
  if (!lastDate || !latestStatementDate) return true;
  const days = (latestStatementDate.getTime() - lastDate.getTime()) / 86400000;
  const allowed = frequency === 'Every 2 months' ? 120 : VFC_BANKING_INPUT_CONFIG.ACTIVE_LOOKBACK_DAYS;
  return days >= -3 && days <= allowed;
}

function vfcBiqBestCounterparty_(items) {
  const counts = {};
  (items || []).forEach(function(item) {
    const text = String(item.counterparty || item.description || '').trim();
    if (!text) return;
    counts[text] = (counts[text] || 0) + 1;
  });
  const keys = Object.keys(counts);
  keys.sort(function(a, b) {
    if (counts[b] !== counts[a]) return counts[b] - counts[a];
    return a.length - b.length;
  });
  return keys.length ? keys[0] : 'Recurring Payment';
}

function vfcBiqGroupConfidence_(items) {
  if (!items || !items.length) return 'Low';
  const score = items.reduce(function(sum, item) {
    return sum + (item.confidence === 'High' ? 2 : item.confidence === 'Moderate' ? 1 : 0);
  }, 0) / items.length;
  if (score >= 1.5) return 'High';
  if (score >= 0.75) return 'Moderate';
  return 'Low';
}

function vfcBiqBuildAudit_(companyName, period, base) {
  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  const latestBatch = vfcBiqLatestBatch_(allRows);
  const selectedRows = vfcBiqCurrentStatementWindow_(latestBatch);

  if (!selectedRows.length) {
    return {
      rows: [], processedRows: 0, allStatementsVerified: false,
      allMatchingRows: allRows.length, latestBatchRows: latestBatch.length,
      duplicatesIgnored: 0, olderOrDisconnectedRowsIgnored: allRows.length,
      monthsCovered: 0, totalDeposits: 0, totalWithdrawals: 0,
      nsfCount: 0, negativeBalanceFlag: 0, monthlyDeposits: [], monthlyWithdrawals: [],
      latestStatementDate: null, statementAudit: [], warnings: []
    };
  }

  let processedRows = 0;
  let allStatementsVerified = true;
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  let nsfCount = 0;
  let negativeBalanceFlag = 0;
  const monthlyDeposits = [];
  const monthlyWithdrawals = [];
  const statementAudit = [];
  const ends = [];

  selectedRows.forEach(function(row) {
    const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if (payload) processedRows++;
    if (!payload || !payload.inputVerified || !payload.headerSummary) {
      allStatementsVerified = false;
      return;
    }

    const header = payload.headerSummary;
    const deposits = vfcBiqPositiveNumber_(header.totalDeposits);
    const withdrawals = vfcBiqPositiveNumber_(header.totalWithdrawals);
    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    monthlyDeposits.push(deposits);
    monthlyWithdrawals.push(withdrawals);
    nsfCount += Math.max(0, vfcBiqNumber_(payload.nsfCount));
    if (vfcBiqTruthyFlag_(row.negativeBalanceDetected)) negativeBalanceFlag = 1;

    const end = vfcBiqDate_(header.statementEndDate || row.statementEndDate);
    if (end) ends.push(end);

    statementAudit.push({
      fileName: row.fileName,
      statementStartDate: header.statementStartDate || vfcBiqIsoDate_(row.statementStartDate),
      statementEndDate: header.statementEndDate || vfcBiqIsoDate_(row.statementEndDate),
      totalDeposits: vfcBiqRound_(deposits, 0.01),
      totalWithdrawals: vfcBiqRound_(withdrawals, 0.01),
      method: payload.method || '',
      reconciliationDifference: vfcBiqRound_(header.reconciliationDifference, 0.01),
      verified: true
    });
  });

  const latestStatementDate = ends.length
    ? new Date(Math.max.apply(null, ends.map(function(d) { return d.getTime(); })))
    : null;

  const duplicatesIgnored = Math.max(0, latestBatch.length - vfcBiqUniqueStatementRows_(latestBatch).length);
  const olderOrDisconnectedRowsIgnored = Math.max(0, allRows.length - selectedRows.length);
  const warnings = [];
  if (duplicatesIgnored > 0) warnings.push(duplicatesIgnored + ' duplicate statement row(s) were ignored.');
  if (olderOrDisconnectedRowsIgnored > 0) {
    warnings.push(olderOrDisconnectedRowsIgnored + ' older, duplicate, previous-upload or disconnected statement row(s) were excluded from the current review window.');
  }

  return {
    rows: selectedRows,
    processedRows: processedRows,
    allStatementsVerified: allStatementsVerified,
    allMatchingRows: allRows.length,
    latestBatchRows: latestBatch.length,
    duplicatesIgnored: duplicatesIgnored,
    olderOrDisconnectedRowsIgnored: olderOrDisconnectedRowsIgnored,
    monthsCovered: selectedRows.length,
    totalDeposits: totalDeposits,
    totalWithdrawals: totalWithdrawals,
    nsfCount: nsfCount,
    negativeBalanceFlag: negativeBalanceFlag,
    monthlyDeposits: monthlyDeposits,
    monthlyWithdrawals: monthlyWithdrawals,
    latestStatementDate: latestStatementDate,
    statementAudit: statementAudit,
    warnings: warnings
  };
}

function vfcBiqLatestBatch_(rows) {
  const sorted = (rows || []).slice().sort(function(a, b) {
    return vfcBiqTime_(a.createdAt) - vfcBiqTime_(b.createdAt);
  });
  if (!sorted.length) return [];

  const out = [sorted[sorted.length - 1]];
  let lastTime = vfcBiqTime_(sorted[sorted.length - 1].createdAt);
  for (let i = sorted.length - 2; i >= 0; i--) {
    const time = vfcBiqTime_(sorted[i].createdAt);
    if (lastTime && time) {
      const gap = Math.abs(lastTime - time) / 60000;
      if (gap > VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES) break;
    }
    out.push(sorted[i]);
    if (time) lastTime = time;
  }
  return out.reverse();
}

function vfcBiqCurrentStatementWindow_(rows) {
  const unique = vfcBiqUniqueStatementRows_(rows);
  unique.sort(function(a, b) {
    return vfcBiqEffectiveDate_(a) - vfcBiqEffectiveDate_(b);
  });
  if (!unique.length) return [];

  const selected = [];
  let laterStart = null;
  for (let i = unique.length - 1; i >= 0; i--) {
    const row = unique[i];
    const start = vfcBiqDate_(row.statementStartDate);
    const end = vfcBiqDate_(row.statementEndDate) || start;

    if (selected.length && laterStart && end) {
      const gapDays = (laterStart.getTime() - end.getTime()) / 86400000;
      if (gapDays > VFC_BANKING_INPUT_CONFIG.MAX_STATEMENT_GAP_DAYS) break;
    }

    selected.push(row);
    if (start) laterStart = start;
    if (selected.length >= VFC_BANKING_INPUT_CONFIG.MAX_STATEMENTS) break;
  }

  return selected.reverse();
}

function vfcBiqUniqueStatementRows_(rows) {
  const map = {};
  (rows || []).forEach(function(row) {
    const start = vfcBiqIsoDate_(row.statementStartDate);
    const end = vfcBiqIsoDate_(row.statementEndDate);
    const key = start && end
      ? start + '|' + end
      : String(row.fileName || '').toLowerCase();
    const existing = map[key];
    if (!existing || vfcBiqTime_(row.createdAt) >= vfcBiqTime_(existing.createdAt)) {
      map[key] = row;
    }
  });
  return Object.keys(map).map(function(key) { return map[key]; });
}

function vfcBiqReusablePayloadMap_(rows) {
  const map = {};
  (rows || []).forEach(function(row) {
    const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if (!payload || !payload.inputVerified) return;
    const key = payload.statementIdentity || vfcBiqStatementIdentity_(row);
    if (!key) return;
    const current = map[key];
    if (!current || vfcBiqNumber_(payload.version) >= vfcBiqNumber_(current.version)) {
      map[key] = payload;
    }
  });
  return map;
}

function vfcBiqStatementIdentity_(row) {
  return [
    String(row.bankName || '').trim().toLowerCase(),
    String(row.accountHolder || '').trim().toLowerCase(),
    vfcBiqIsoDate_(row.statementStartDate),
    vfcBiqIsoDate_(row.statementEndDate),
    String(row.fileName || '').trim().toLowerCase().replace(/\s+/g, ' ')
  ].join('|');
}

function vfcBiqReadSummaryRows_(companyName, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];

  const c = {
    upload: vfcBiqColumn_(headers, 'Upload ID'),
    company: vfcBiqColumn_(headers, 'Company Name'),
    period: vfcBiqColumn_(headers, 'Detected Period'),
    file: vfcBiqColumn_(headers, 'File Name'),
    bank: vfcBiqColumnOptional_(headers, 'Bank Name'),
    holder: vfcBiqColumnOptional_(headers, 'Account Holder'),
    start: vfcBiqColumn_(headers, 'Statement Start Date'),
    end: vfcBiqColumn_(headers, 'Statement End Date'),
    opening: vfcBiqColumnOptional_(headers, 'Opening Balance'),
    closing: vfcBiqColumnOptional_(headers, 'Closing Balance'),
    deposits: vfcBiqColumn_(headers, 'Total Deposits'),
    withdrawals: vfcBiqColumn_(headers, 'Total Withdrawals'),
    nsf: vfcBiqColumn_(headers, 'NSF Count'),
    negative: vfcBiqColumn_(headers, 'Negative Balance Detected'),
    signal: vfcBiqColumn_(headers, 'Possible MCA Or Loan Payments'),
    created: vfcBiqColumn_(headers, 'Created At')
  };

  return values.slice(1).map(function(row, index) {
    return {
      uploadId: row[c.upload],
      companyName: row[c.company],
      detectedPeriod: row[c.period],
      fileName: String(row[c.file] || 'statement.pdf'),
      bankName: c.bank >= 0 ? row[c.bank] : '',
      accountHolder: c.holder >= 0 ? row[c.holder] : '',
      statementStartDate: row[c.start],
      statementEndDate: row[c.end],
      openingBalance: c.opening >= 0 ? row[c.opening] : '',
      closingBalance: c.closing >= 0 ? row[c.closing] : '',
      totalDeposits: row[c.deposits],
      totalWithdrawals: row[c.withdrawals],
      nsfCount: row[c.nsf],
      negativeBalanceDetected: row[c.negative],
      possibleMcaOrLoanPayments: row[c.signal],
      createdAt: row[c.created],
      rowNumber: index + 2,
      signalColumn: c.signal + 1
    };
  }).filter(function(row) {
    return (!companyName || vfcBiqSame_(row.companyName, companyName)) &&
      (!period || vfcBiqSame_(row.detectedPeriod, period));
  });
}

function vfcBiqUploadMap_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads');
  if (!sheet) return {};
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};
  const headers = values[0];
  const uploadColumn = vfcBiqColumn_(headers, 'Upload ID');
  const fileColumn = vfcBiqColumn_(headers, 'File ID');
  const map = {};
  values.slice(1).forEach(function(row) {
    const uploadId = String(row[uploadColumn] || '').trim();
    if (uploadId) map[uploadId] = { fileId: String(row[fileColumn] || '').trim() };
  });
  return map;
}

function vfcBiqParsePayload_(value) {
  const text = String(value || '').trim();
  if (text.indexOf(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX) !== 0) return null;
  try {
    const parsed = JSON.parse(text.substring(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length));
    return {
      version: vfcBiqNumber_(parsed.version),
      analyzedAt: parsed.analyzedAt || '',
      statementIdentity: parsed.statementIdentity || '',
      fileName: parsed.fileName || '',
      bankName: parsed.bankName || '',
      method: parsed.method || '',
      inputVerified: !!parsed.inputVerified,
      headerSummary: parsed.headerSummary || {},
      nsfCount: vfcBiqNumber_(parsed.nsfCount),
      paymentCandidates: Array.isArray(parsed.paymentCandidates) ? parsed.paymentCandidates : [],
      financingCredits: Array.isArray(parsed.financingCredits) ? parsed.financingCredits : []
    };
  } catch (error) {
    return null;
  }
}

function vfcBiqEffectiveDate_(row) {
  const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
  const header = payload && payload.headerSummary ? payload.headerSummary : {};
  return vfcBiqDate_(header.statementEndDate || row.statementEndDate || header.statementStartDate || row.statementStartDate) || new Date(0);
}

function vfcBiqDedupeSignals_(items) {
  const seen = {};
  return (items || []).filter(function(item) {
    if (!item) return false;
    const key = [
      vfcBiqIsoDate_(item.date),
      vfcBiqRound_(vfcBiqPositiveNumber_(item.amount), 0.01),
      String(item.category || ''),
      vfcBiqCanonicalLabel_(item)
    ].join('|').toLowerCase();
    if (!item.date || !item.category || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function vfcBiqResolveTransactionDate_(monthText, dayText, start, end) {
  const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,SEPT:8,OCT:9,NOV:10,DEC:11};
  const month = months[String(monthText || '').toUpperCase()];
  const day = parseInt(dayText, 10);
  if (month === undefined || !(day >= 1 && day <= 31)) return null;

  const years = [];
  if (start) years.push(start.getUTCFullYear());
  if (end && years.indexOf(end.getUTCFullYear()) < 0) years.push(end.getUTCFullYear());
  if (!years.length) years.push(new Date().getUTCFullYear());

  let best = null;
  let bestDistance = Infinity;
  years.forEach(function(year) {
    const d = new Date(Date.UTC(year, month, day));
    const anchor = end || start || new Date();
    const distance = Math.abs(d.getTime() - anchor.getTime());
    const inside = (!start || d >= new Date(start.getTime() - 3 * 86400000)) &&
      (!end || d <= new Date(end.getTime() + 3 * 86400000));
    if (inside && distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  });
  return best;
}

function vfcBiqRegexMoneyValues_(text, regex) {
  const values = [];
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const value = vfcBiqPositiveNumber_(match[1]);
    if (value >= 0) values.push(value);
  }
  return values;
}

function vfcBiqColumn_(headers, wanted) {
  const index = vfcBiqColumnOptional_(headers, wanted);
  if (index >= 0) return index;
  throw new Error('Missing required column: ' + wanted);
}

function vfcBiqColumnOptional_(headers, wanted) {
  const target = String(wanted || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < headers.length; i++) {
    const normalized = String(headers[i] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === target) return i;
  }
  return -1;
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

function vfcBiqConfidence_(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'high') return 'High';
  if (text === 'low') return 'Low';
  return 'Moderate';
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

function vfcBiqNumberSigned_(value) {
  const text = String(value == null ? '' : value).trim();
  let number = vfcBiqNumber_(text);
  if (/OD$/i.test(text)) number = -Math.abs(number);
  return number;
}

function vfcBiqNullableNumber_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return vfcBiqNumberSigned_(text);
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

function vfcBiqSum_(values) {
  return (values || []).reduce(function(sum, value) { return sum + vfcBiqNumber_(value); }, 0);
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
  const average = vfcBiqSum_(numbers) / numbers.length;
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
  const firstAverage = vfcBiqSum_(first) / first.length;
  const secondAverage = second.length ? vfcBiqSum_(second) / second.length : firstAverage;
  return firstAverage > 0 ? (secondAverage - firstAverage) / firstAverage : 0;
}

function vfcBiqSame_(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}

function vfcBiqTime_(value) {
  const date = vfcBiqDate_(value);
  return date ? date.getTime() : 0;
}
