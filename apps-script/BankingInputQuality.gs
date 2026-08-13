const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-7.0-MULTIBANK-RECONCILED',
  SIGNAL_PREFIX: 'VFC_BANKING_V10:',
  PAYLOAD_VERSION: 10,
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK_STATEMENTS: 6,
  MAX_STATEMENT_GAP_DAYS: 75,
  LATEST_BATCH_GAP_MINUTES: 10,
  ACTIVE_LOOKBACK_DAYS: 90,
  RECONCILE_TOLERANCE_DOLLARS: 5
};

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const request = vfcBiqNormalizeRequest_(companyOrRequest, requestedPeriod);
    const period = request.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(request.companyName, request.period)
      : request.period);
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
  const result = refreshLatestDebtSignals();
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
    bankAgnostic: true,
    deterministicAdapters: ['TD'],
    genericMethod: 'reconciled stored totals -> reconciled OpenAI extraction fallback',
    sameStatementReuse: true,
    debtLookbackStatements: VFC_BANKING_INPUT_CONFIG.DEBT_LOOKBACK_STATEMENTS,
    lenderAgnosticRecurringPaymentDetection: true,
    excludesFeesFromDebt: true,
    separatesTaxInsuranceAndCards: true,
    partialStatementCalculationAllowed: false,
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

  const audit = vfcBiqBuildAudit_(companyName, period);
  if (!audit.rows.length || audit.processedRows === 0) return base;

  if (audit.processedRows !== audit.rows.length || !audit.allStatementsVerified) {
    const missing = audit.unverifiedFiles.length ? ' Unverified: ' + audit.unverifiedFiles.join(', ') : '';
    throw new Error('Banking input validation is incomplete: ' + audit.processedRows + ' of ' + audit.rows.length + ' current statements were verified.' + missing);
  }

  const debtProfile = vfcBiqBuildDebtProfile_(audit.rows, audit.monthsCovered, audit.latestStatementDate);
  const grossMonthlyDeposits = audit.totalDeposits / Math.max(1, audit.monthsCovered);
  const operatingTotalDeposits = Math.max(0, audit.totalDeposits - debtProfile.financingCreditsTotal);
  const operatingMonthlyDeposits = operatingTotalDeposits / Math.max(1, audit.monthsCovered);
  const warnings = audit.warnings.slice();
  const oldAverage = vfcBiqNumber_(base.averageMonthlyDeposits);

  if (oldAverage > 0 && grossMonthlyDeposits > 0 && Math.abs(oldAverage - grossMonthlyDeposits) / grossMonthlyDeposits >= 0.05) {
    warnings.push('Average monthly deposits corrected from ' + vfcBiqRound_(oldAverage, 1) + ' to ' + vfcBiqRound_(grossMonthlyDeposits, 1) + ' using reconciled statement totals.');
  }

  return Object.assign({}, base, {
    statementCount: audit.rows.length,
    monthsCovered: audit.monthsCovered,
    totalDeposits: vfcBiqRound_(audit.totalDeposits, 0.01),
    averageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
    totalWithdrawals: vfcBiqRound_(audit.totalWithdrawals, 0.01),
    depositWithdrawalRatio: vfcBiqRound_(audit.totalWithdrawals ? audit.totalDeposits / audit.totalWithdrawals : 0, 0.01),
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
    otherRecurringMonthlyObligations: 0,
    informationalRecurringMonthlyObligations: vfcBiqRound_(debtProfile.informationalMonthlyObligations, 0.01),
    debtServiceToDepositsRatio: grossMonthlyDeposits > 0 ? vfcBiqRound_(debtProfile.confirmedMonthlyDebtService / grossMonthlyDeposits, 0.0001) : 0,
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
  if (!allRowsForPeriod.length) throw new Error('No PDF Summary rows found for this company and period.');

  const latestBatch = vfcBiqLatestBatch_(allRowsForPeriod);
  const rows = vfcBiqCurrentStatementWindow_(latestBatch);
  if (!rows.length) throw new Error('No current bank-statement rows were selected.');

  const reusable = vfcBiqReusablePayloadMap_(vfcBiqReadSummaryRows_(companyName, ''));
  const uploadMap = vfcBiqUploadMap_();
  let filesAnalyzed = 0;
  let filesReused = 0;
  let filesSkipped = 0;
  const errors = [];

  rows.forEach(function(row, rowIndex) {
    const current = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if (current && current.version >= VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION && current.inputVerified) {
      filesSkipped++;
      return;
    }

    const identity = vfcBiqStatementIdentity_(row);
    const prior = reusable[identity];
    if (prior && prior.inputVerified && prior.version >= VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION) {
      summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(prior));
      filesReused++;
      return;
    }

    try {
      const storedTotals = vfcBiqStoredTotals_(row);
      const needsDebtSignals = rowIndex >= Math.max(0, rows.length - VFC_BANKING_INPUT_CONFIG.DEBT_LOOKBACK_STATEMENTS);

      if (storedTotals.verified && !needsDebtSignals) {
        const totalsOnlyPayload = vfcBiqTotalsOnlyPayload_(row, storedTotals);
        summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(totalsOnlyPayload));
        filesAnalyzed++;
        return;
      }

      const upload = uploadMap[String(row.uploadId || '')] || {};
      if (!upload.fileId) throw new Error('upload file ID not found');
      const text = extractTextFromPdf_(upload.fileId);
      const payload = vfcBiqAnalyzeStatement_(text, row, storedTotals, needsDebtSignals);
      summarySheet.getRange(row.rowNumber, row.signalColumn).setValue(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload));
      filesAnalyzed++;
    } catch (error) {
      errors.push(row.fileName + ': ' + String(error && error.message || error));
    }
  });

  const audit = vfcBiqBuildAudit_(companyName, period);
  const incomplete = audit.processedRows !== audit.rows.length || !audit.allStatementsVerified;
  if (incomplete && audit.unverifiedFiles.length) errors.push('Unverified statement(s): ' + audit.unverifiedFiles.join(', '));

  let features = null;
  if (!incomplete) {
    try { features = getValidatedBankingFeatures_(companyName, period); }
    catch (error) { errors.push(String(error && error.message || error)); }
  }

  return {
    ok: errors.length === 0 && !incomplete,
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    companyName: companyName,
    period: period,
    filesAnalyzed: filesAnalyzed,
    filesReused: filesReused,
    filesSkipped: filesSkipped,
    errors: errors,
    statementAudit: audit.statementAudit || [],
    debtProfile: features && features.debtProfile ? features.debtProfile : {},
    inputQualityAudit: features && features.inputQualityAudit ? features.inputQualityAudit : { unverifiedFiles: audit.unverifiedFiles || [] }
  };
}

function vfcBiqAnalyzeStatement_(text, row, storedTotals, needsDebtSignals) {
  const bank = vfcBiqDetectBank_(text, row);
  let totals = storedTotals && storedTotals.verified ? storedTotals : null;
  let method = totals ? 'STORED_TOTALS_RECONCILED' : '';

  if (bank === 'TD') {
    const tdTotals = vfcBiqParseTdTotals_(text, row);
    if (tdTotals && tdTotals.verified) {
      totals = tdTotals;
      method = 'TD_PAGE_TOTALS_RECONCILED';
    }
  }

  if (!totals || !totals.verified) {
    totals = vfcBiqExtractAndReconcileTotalsWithOpenAI_(text, row, bank);
    method = 'GENERIC_AI_EXTRACTED_RECONCILED';
  }

  if (!totals || !totals.verified) throw new Error('statement totals could not be reconciled' + (totals && totals.reason ? ' (' + totals.reason + ')' : ''));

  let paymentCandidates = [];
  let financingCredits = [];
  let nsfCount = vfcBiqNumber_(row.nsfCount);

  if (needsDebtSignals !== false) {
    if (bank === 'TD') {
      paymentCandidates = vfcBiqParseTdCandidates_(text, row);
      nsfCount = vfcBiqCountTdNsf_(text);
    } else {
      const signals = vfcBiqExtractGenericSignalsWithOpenAI_(text, row);
      paymentCandidates = signals.paymentCandidates;
      financingCredits = signals.financingCredits;
    }
  }

  return {
    version: VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION,
    analyzedAt: new Date().toISOString(),
    statementIdentity: vfcBiqStatementIdentity_(row),
    fileName: row.fileName,
    bankName: row.bankName || bank,
    bankAdapter: bank,
    method: method,
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
    nsfCount: nsfCount,
    paymentCandidates: vfcBiqDedupeSignals_(paymentCandidates),
    financingCredits: vfcBiqFilterFinancingCredits_(financingCredits)
  };
}

function vfcBiqTotalsOnlyPayload_(row, totals) {
  return {
    version: VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION,
    analyzedAt: new Date().toISOString(),
    statementIdentity: vfcBiqStatementIdentity_(row),
    fileName: row.fileName,
    bankName: row.bankName || '',
    bankAdapter: vfcBiqBankKey_(row.bankName),
    method: 'STORED_TOTALS_RECONCILED_TOTALS_ONLY',
    inputVerified: true,
    headerSummary: {
      statementStartDate: totals.statementStartDate,
      statementEndDate: totals.statementEndDate,
      openingBalance: totals.openingBalance,
      closingBalance: totals.closingBalance,
      totalDeposits: totals.totalDeposits,
      totalWithdrawals: totals.totalWithdrawals,
      reconciliationDifference: totals.reconciliationDifference,
      pageCreditSubtotals: [],
      pageDebitSubtotals: []
    },
    nsfCount: vfcBiqNumber_(row.nsfCount),
    paymentCandidates: [],
    financingCredits: []
  };
}

function vfcBiqDetectBank_(text, row) {
  const source = (String(row.bankName || '') + '\n' + String(text || '').substring(0, 8000)).toUpperCase();
  if (/TD CANADA TRUST|TORONTO[- ]DOMINION|THE TORONTO-DOMINION BANK/.test(source)) return 'TD';
  if (/ROYAL BANK OF CANADA|\bRBC\b/.test(source)) return 'RBC';
  if (/BANK OF MONTREAL|\bBMO\b/.test(source)) return 'BMO';
  if (/SCOTIABANK|BANK OF NOVA SCOTIA/.test(source)) return 'SCOTIA';
  if (/CIBC|CANADIAN IMPERIAL BANK OF COMMERCE/.test(source)) return 'CIBC';
  if (/ATB FINANCIAL/.test(source)) return 'ATB';
  if (/NATIONAL BANK OF CANADA|BANQUE NATIONALE/.test(source)) return 'NBC';
  return 'GENERIC';
}

function vfcBiqBankKey_(value) {
  const text = String(value || '').toUpperCase();
  if (/TD|TORONTO[- ]DOMINION/.test(text)) return 'TD';
  if (/RBC|ROYAL BANK/.test(text)) return 'RBC';
  if (/BMO|BANK OF MONTREAL/.test(text)) return 'BMO';
  if (/SCOTIA|NOVA SCOTIA/.test(text)) return 'SCOTIA';
  if (/CIBC|CANADIAN IMPERIAL/.test(text)) return 'CIBC';
  if (/ATB/.test(text)) return 'ATB';
  if (/NATIONAL BANK|BANQUE NATIONALE/.test(text)) return 'NBC';
  return text.replace(/[^A-Z0-9]/g, '').substring(0, 24) || 'GENERIC';
}

function vfcBiqStoredTotals_(row) {
  const opening = vfcBiqNullableNumber_(row.openingBalance);
  const closing = vfcBiqNullableNumber_(row.closingBalance);
  const deposits = vfcBiqNullablePositiveNumber_(row.totalDeposits);
  const withdrawals = vfcBiqNullablePositiveNumber_(row.totalWithdrawals);
  if (opening === null || closing === null || deposits === null || withdrawals === null) return { verified: false, reason: 'stored summary does not contain all four balance fields' };
  return vfcBiqReconcileTotals_({
    statementStartDate: row.statementStartDate,
    statementEndDate: row.statementEndDate,
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: deposits,
    totalWithdrawals: withdrawals
  });
}

function vfcBiqParseTdTotals_(text, row) {
  const creditValues = vfcBiqRegexMoneyValues_(String(text || ''), /\bCredits\s+\d+\s+\$?\s*([0-9][0-9,]*\.\d{2})/gi);
  const debitValues = vfcBiqRegexMoneyValues_(String(text || ''), /\bDebits\s+\d+\s+\$?\s*([0-9][0-9,]*\.\d{2})/gi);
  if (!creditValues.length || !debitValues.length) return { verified: false, reason: 'TD page subtotals not found' };
  const balances = vfcBiqParseTdOpeningClosing_(text, row);
  if (balances.openingBalance === null || balances.closingBalance === null) return { verified: false, reason: 'TD opening/closing balance not found' };
  return vfcBiqReconcileTotals_({
    statementStartDate: row.statementStartDate,
    statementEndDate: row.statementEndDate,
    openingBalance: balances.openingBalance,
    closingBalance: balances.closingBalance,
    totalDeposits: vfcBiqSum_(creditValues),
    totalWithdrawals: vfcBiqSum_(debitValues),
    pageCreditSubtotals: creditValues,
    pageDebitSubtotals: debitValues
  });
}

function vfcBiqParseTdOpeningClosing_(text, row) {
  const lines = String(text || '').split(/\r?\n/);
  let opening = null;
  let closing = null;
  lines.forEach(function(raw) {
    const line = String(raw || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) return;
    if (opening === null && /BALANCE\s+FORWARD/i.test(line)) {
      const m = line.match(/BALANCE\s+FORWARD\s+[A-Z]{3}\s*\d{1,2}\s+([0-9,]+\.\d{2})(OD)?/i);
      if (m) {
        opening = vfcBiqNumber_(m[1]);
        if (m[2]) opening = -Math.abs(opening);
      }
    }
    const dm = line.match(/\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s*\d{1,2}\b/i);
    if (dm) {
      const trailing = line.substring((dm.index || 0) + dm[0].length).match(/([0-9,]+\.\d{2})(OD)?\s*$/);
      if (trailing) {
        closing = vfcBiqNumber_(trailing[1]);
        if (trailing[2]) closing = -Math.abs(closing);
      }
    }
  });
  if (opening === null) opening = vfcBiqNullableNumber_(row.openingBalance);
  if (closing === null) closing = vfcBiqNullableNumber_(row.closingBalance);
  return { openingBalance: opening, closingBalance: closing };
}

function vfcBiqExtractAndReconcileTotalsWithOpenAI_(text, row, bank) {
  if (typeof callOpenAIJson_ !== 'function') return { verified: false, reason: 'OpenAI JSON helper unavailable' };
  const prompt = [
    'You are a bank-statement totals extractor. Return JSON only.',
    'Bank/format hint: ' + bank + '.',
    'Extract only figures explicitly printed on the statement. Never estimate.',
    'Return: statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, page_credit_subtotals, page_debit_subtotals.',
    'If only page-level subtotals exist, return every page subtotal in the arrays and leave statement-level totals blank.',
    'For TD, capture every page footer Credits amount and Debits amount.',
    'Do not use monthly average balance, minimum balance, transaction amounts, or running balances as statement totals.',
    'Known period: ' + String(row.statementStartDate || '') + ' to ' + String(row.statementEndDate || ''),
    'OCR TEXT:',
    String(text || '').substring(0, 60000)
  ].join('\n');
  const raw = callOpenAIJson_(prompt) || {};
  const opening = vfcBiqNullableNumber_(raw.opening_balance);
  const closing = vfcBiqNullableNumber_(raw.closing_balance);
  let deposits = vfcBiqNullablePositiveNumber_(raw.total_deposits);
  let withdrawals = vfcBiqNullablePositiveNumber_(raw.total_withdrawals);
  const credits = vfcBiqNumberArray_(raw.page_credit_subtotals);
  const debits = vfcBiqNumberArray_(raw.page_debit_subtotals);
  if (deposits === null && credits.length) deposits = vfcBiqSum_(credits);
  if (withdrawals === null && debits.length) withdrawals = vfcBiqSum_(debits);
  if (opening === null || closing === null || deposits === null || withdrawals === null) return { verified: false, reason: 'fallback totals incomplete' };
  return vfcBiqReconcileTotals_({
    statementStartDate: raw.statement_start_date || row.statementStartDate,
    statementEndDate: raw.statement_end_date || row.statementEndDate,
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: deposits,
    totalWithdrawals: withdrawals,
    pageCreditSubtotals: credits,
    pageDebitSubtotals: debits
  });
}

function vfcBiqReconcileTotals_(input) {
  const opening = vfcBiqNullableNumber_(input.openingBalance);
  const closing = vfcBiqNullableNumber_(input.closingBalance);
  const deposits = vfcBiqNullablePositiveNumber_(input.totalDeposits);
  const withdrawals = vfcBiqNullablePositiveNumber_(input.totalWithdrawals);
  if (opening === null || closing === null || deposits === null || withdrawals === null) return { verified: false, reason: 'all four balance fields are required' };
  const difference = Math.abs((opening + deposits - withdrawals) - closing);
  if (difference > VFC_BANKING_INPUT_CONFIG.RECONCILE_TOLERANCE_DOLLARS) return { verified: false, reason: 'balance reconciliation differs by $' + vfcBiqRound_(difference, 0.01) };
  return {
    verified: true,
    statementStartDate: vfcBiqIsoDate_(input.statementStartDate),
    statementEndDate: vfcBiqIsoDate_(input.statementEndDate),
    openingBalance: vfcBiqRound_(opening, 0.01),
    closingBalance: vfcBiqRound_(closing, 0.01),
    totalDeposits: vfcBiqRound_(deposits, 0.01),
    totalWithdrawals: vfcBiqRound_(withdrawals, 0.01),
    reconciliationDifference: vfcBiqRound_(difference, 0.01),
    pageCreditSubtotals: input.pageCreditSubtotals || [],
    pageDebitSubtotals: input.pageDebitSubtotals || []
  };
}

function vfcBiqParseTdCandidates_(text, row) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  const start = vfcBiqDate_(row.statementStartDate);
  const end = vfcBiqDate_(row.statementEndDate);
  lines.forEach(function(rawLine) {
    const line = String(rawLine || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line || /BALANCE FORWARD|MONTHLY AVER|MONTHLY MIN|NEXT STATEMENT|\bCredits\b|\bDebits\b/i.test(line)) return;
    const dm = line.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s*([0-3]?\d)\b/i);
    if (!dm) return;
    const prefix = line.substring(0, dm.index || 0).trim();
    const money = [];
    const re = /([0-9][0-9,]*\.\d{2})/g;
    let m;
    while ((m = re.exec(prefix)) !== null) money.push({ value: m[1], index: m.index });
    if (!money.length) return;
    const token = money[money.length - 1];
    const amount = vfcBiqPositiveNumber_(token.value);
    let description = prefix.substring(0, token.index).trim().replace(/^[-|\s]+/, '').replace(/\s+/g, ' ');
    if (!description || !(amount > 0)) return;
    const category = vfcBiqClassifyTransactionDescription_(description, amount);
    if (!category) return;
    const date = vfcBiqResolveTransactionDate_(dm[1], dm[2], start, end);
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

function vfcBiqClassifyTransactionDescription_(description, amount) {
  const text = String(description || '').toUpperCase();
  if (/\bFEE\b|SERVICE\s+CHRG|SERVICE\s+CHARGE|MONTHLY\s+PLAN|NSF|RETURN\s+FEE|PAYMENT\s+COVERAGE/i.test(text)) return '';
  if (/\bCRA\b|\bCCRA\b|GST-P|\bGST\b|\bHST\b|SOURCE\s+D|\bTAX\b|\bWCB\b|\bEMPTX\b|\bTXBAL\b/i.test(text)) return 'TAX_GOVERNMENT';
  if (/\bIPFS\b|PREMIUM\s+FIN|INSURANCE\s+FIN|\bINSURANCE\b/i.test(text)) return 'INSURANCE_FINANCE';
  if (/CREDIT\s+CARD\s+PAYMENT|C\/C\s+PAYMENT/i.test(text)) return 'CREDIT_CARD';
  if (/\bMCA\b|MERCHANT\s+CASH\s+ADVANCE|CASH\s+ADVANCE\s+PAY/i.test(text)) return 'MCA';
  if (/TRUCK\s*FIN|TRUCKFIN/i.test(text)) return 'TRUCK_FINANCE';
  if (/\bAUTO\s+FIN|\bVEHICLE\s+FIN|FORD\s+CREDIT|CREDIT\s+CA\s+(?:APY|PAY|PAA)/i.test(text)) return 'AUTO_FINANCE';
  if (/\bLINE\s+OF\s+CREDIT\b|\bLOC\b/i.test(text)) return 'LOC';
  if (/\bLEASE\b/i.test(text)) return 'LEASE_FINANCE';
  if (/\bLOAN\b|LOAN\s+PYMT|LOAN\s+PAYMENT/i.test(text)) return 'TERM_LOAN';
  if (/\bFINANC(?:E|IAL|ING)\b/i.test(text)) return 'OTHER_FINANCING_PAYMENT';
  if (/\bPAD\b|PRE[- ]?AUTH(?:ORIZED)?|PREAUTHORIZED/i.test(text)) return amount >= 50 ? 'RECURRING_PAD' : '';
  if (/\bRLS\b|\bBUS\b\s*$/i.test(text)) return 'OTHER_RECURRING';
  return '';
}

function vfcBiqCountTdNsf_(text) {
  const matches = String(text || '').match(/\bNSF\s+(?:PAID|RETURN|RETURNED)?\s*FEE\b/gi);
  return matches ? matches.length : 0;
}

function vfcBiqExtractGenericSignalsWithOpenAI_(text, row) {
  if (typeof callOpenAIJson_ !== 'function') return { paymentCandidates: [], financingCredits: [] };
  const prompt = [
    'You are a bank-statement transaction extractor. Return JSON only.',
    'Extract EACH exact debit clearly identified as loan, financing, MCA, lease/LOC, PAD/pre-authorized debit, tax/government PAD, insurance finance, or credit-card payment.',
    'Do not decide recurrence. Return each occurrence separately. Never use a nearby amount.',
    'Fees, suppliers, payroll, purchases, ordinary transfers and ordinary e-transfers are not financing debt.',
    'Also extract incoming financing credits only when explicitly identified as loan/funding/financing/cash-advance proceeds.',
    'Return {payment_candidates:[{date,description,counterparty,amount,kind,confidence}], financing_credits:[{date,description,counterparty,amount,kind,confidence}]}.',
    'Allowed payment kinds: LOAN_PAYMENT, MCA_PAYMENT, FINANCING_PAYMENT, PAD, TAX_PAD, INSURANCE_FINANCE, CREDIT_CARD_PAYMENT.',
    'Allowed credit kinds: LOAN_ADVANCE, MCA_ADVANCE, OTHER_FINANCING_CREDIT.',
    'Use YYYY-MM-DD dates. Confidence: High, Moderate, Low.',
    'Statement period: ' + String(row.statementStartDate || '') + ' to ' + String(row.statementEndDate || ''),
    'OCR TEXT:',
    String(text || '').substring(0, 60000)
  ].join('\n');
  const raw = callOpenAIJson_(prompt) || {};
  return {
    paymentCandidates: vfcBiqNormalizeGenericPayments_(raw.payment_candidates),
    financingCredits: vfcBiqNormalizeGenericCredits_(raw.financing_credits)
  };
}

function vfcBiqNormalizeGenericPayments_(items) {
  if (!Array.isArray(items)) return [];
  const map = { LOAN_PAYMENT:'TERM_LOAN', MCA_PAYMENT:'MCA', FINANCING_PAYMENT:'OTHER_FINANCING_PAYMENT', PAD:'RECURRING_PAD', TAX_PAD:'TAX_GOVERNMENT', INSURANCE_FINANCE:'INSURANCE_FINANCE', CREDIT_CARD_PAYMENT:'CREDIT_CARD' };
  return items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!map[kind] || !(amount > 0)) return null;
    const description = String(item.description || item.counterparty || '').trim();
    if (/\bFEE\b|SERVICE\s+CHARGE|NSF|PAYMENT\s+COVERAGE/i.test(description)) return null;
    const localCategory = vfcBiqClassifyTransactionDescription_(description, amount);
    return {
      date: vfcBiqIsoDate_(item.date),
      description: description.substring(0, 160),
      counterparty: String(item.counterparty || description).trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      category: localCategory || map[kind],
      confidence: vfcBiqConfidence_(item.confidence)
    };
  }).filter(Boolean);
}

function vfcBiqNormalizeGenericCredits_(items) {
  if (!Array.isArray(items)) return [];
  const allowed = { LOAN_ADVANCE:1, MCA_ADVANCE:1, OTHER_FINANCING_CREDIT:1 };
  return items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!allowed[kind] || amount < 5000 || vfcBiqConfidence_(item.confidence) !== 'High') return null;
    return { date:vfcBiqIsoDate_(item.date), description:String(item.description || '').trim().substring(0,160), counterparty:String(item.counterparty || item.description || '').trim().substring(0,100), amount:vfcBiqRound_(amount,0.01), category:kind, confidence:'High' };
  }).filter(Boolean);
}

function vfcBiqFilterFinancingCredits_(items) {
  return vfcBiqDedupeSignals_((items || []).filter(function(item) { return item && vfcBiqPositiveNumber_(item.amount) >= 5000 && item.confidence === 'High'; }));
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
  const obligations = vfcBiqGroupPayments_(payments).map(function(group) { return vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate); }).filter(Boolean);
  obligations.sort(function(a,b){ return b.monthlyEquivalent-a.monthlyEquivalent; });
  const confirmed = { TERM_LOAN:1, TRUCK_FINANCE:1, AUTO_FINANCE:1, COMMERCIAL_LOAN:1, LOC:1, LEASE_FINANCE:1, MCA:1, OTHER_FINANCING_PAYMENT:1, RECURRING_PAD:1 };
  const activeDebt = obligations.filter(function(x){ return x.active && x.recurring && confirmed[x.category] && x.confidence !== 'Low'; });
  const taxGovernmentPads = obligations.filter(function(x){ return x.active && x.recurring && x.category === 'TAX_GOVERNMENT'; });
  const otherRecurring = obligations.filter(function(x){ return x.active && x.recurring && !confirmed[x.category] && x.category !== 'TAX_GOVERNMENT'; });
  const observedOnce = obligations.filter(function(x){ return !x.recurring; });
  const debt = activeDebt.reduce(function(s,x){ return s+x.monthlyEquivalent; },0);
  const info = taxGovernmentPads.concat(otherRecurring).reduce(function(s,x){ return s+x.monthlyEquivalent; },0);
  return {
    confirmedMonthlyDebtService: vfcBiqRound_(debt,0.01),
    otherRecurringMonthlyObligations: 0,
    informationalMonthlyObligations: vfcBiqRound_(info,0.01),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxGovernmentPads,
    observedOnce: observedOnce,
    allDetectedObligations: obligations,
    financingCredits: credits,
    financingCreditsTotal: vfcBiqRound_(credits.reduce(function(s,x){ return s+vfcBiqPositiveNumber_(x.amount); },0),0.01),
    note: 'Confirmed debt requires repeated explicit loan/finance/MCA/PAD transactions. Tax/government, insurance, cards and unclear recurring items are informational only. Fees are excluded.'
  };
}

function vfcBiqGroupPayments_(payments) {
  const groups = {};
  (payments || []).forEach(function(item) {
    if (!item || !item.date || !(vfcBiqPositiveNumber_(item.amount) > 0)) return;
    const label = vfcBiqCanonicalLabel_(item);
    if (!label) return;
    const key = vfcBiqCategoryFamily_(item.category) + '|' + label;
    if (!groups[key]) groups[key] = { category:item.category, label:label, items:[] };
    groups[key].items.push(item);
  });
  return Object.keys(groups).map(function(k){ return groups[k]; });
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
  return raw.replace(/\b(?:PAYMENT|PAYMENTS|PYMT|PMT|PAA|APY|MSP|PAD|PREAUTHORIZED|PRE-AUTHORIZED|DEBIT|WITHDRAWAL|EFT)\b/g,' ').replace(/\b\d{5,}\b/g,' ').replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,8).join(' ');
}

function vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate) {
  if (!group || !group.items || !group.items.length) return null;
  const seen = {};
  const items = group.items.filter(function(item) {
    const key = vfcBiqIsoDate_(item.date)+'|'+vfcBiqRound_(item.amount,0.01);
    if (!item.date || seen[key]) return false;
    seen[key]=true; return true;
  }).sort(function(a,b){ return (vfcBiqDate_(a.date)||new Date(0))-(vfcBiqDate_(b.date)||new Date(0)); });
  if (!items.length) return null;
  const dates = items.map(function(x){ return vfcBiqDate_(x.date); }).filter(Boolean);
  const amounts = items.map(function(x){ return vfcBiqPositiveNumber_(x.amount); }).filter(function(v){ return v>0; });
  const occurrences = dates.length;
  const recurring = occurrences >= 2;
  const frequency = recurring ? vfcBiqInferFrequency_(dates, occurrences, monthsCovered) : 'Observed once';
  const paymentAmount = vfcBiqMedian_(amounts);
  const monthlyEquivalent = recurring ? vfcBiqMonthlyEquivalent_(paymentAmount, frequency, occurrences, monthsCovered) : 0;
  const lastDate = dates[dates.length-1];
  return {
    counterparty: vfcBiqBestCounterparty_(items),
    description: items[0].description || '',
    category: group.category,
    paymentAmount: vfcBiqRound_(paymentAmount,0.01),
    frequency: frequency,
    monthlyEquivalent: vfcBiqRound_(monthlyEquivalent,0.01),
    occurrences: occurrences,
    firstSeen: vfcBiqIsoDate_(dates[0]),
    lastSeen: vfcBiqIsoDate_(lastDate),
    recurring: recurring,
    active: recurring ? vfcBiqIsActive_(lastDate, latestStatementDate, frequency) : false,
    confidence: vfcBiqGroupConfidence_(items),
    patternLabel: group.label
  };
}

function vfcBiqInferFrequency_(dates, occurrences, monthsCovered) {
  if (dates && dates.length >= 2) {
    const sorted = dates.slice().sort(function(a,b){ return a-b; });
    const intervals=[];
    for (let i=1;i<sorted.length;i++) { const days=Math.abs((sorted[i]-sorted[i-1])/86400000); if(days>0) intervals.push(days); }
    const d=vfcBiqMedian_(intervals);
    if (d<=4) return 'Business daily';
    if (d<=10) return 'Weekly';
    if (d<=20) return 'Biweekly';
    if (d<=45) return 'Monthly';
    if (d<=75) return 'Every 2 months';
    return 'Irregular';
  }
  const perMonth=occurrences/Math.max(1,monthsCovered||1);
  if(perMonth>=3) return 'Weekly';
  if(perMonth>=1.5) return 'Biweekly';
  if(perMonth>=0.65) return 'Monthly';
  return 'Irregular';
}

function vfcBiqMonthlyEquivalent_(amount, frequency, occurrences, monthsCovered) {
  amount=vfcBiqPositiveNumber_(amount);
  if(!(amount>0)) return 0;
  if(frequency==='Business daily') return amount*21.7;
  if(frequency==='Weekly') return amount*4.33;
  if(frequency==='Biweekly') return amount*2.17;
  if(frequency==='Monthly') return amount;
  if(frequency==='Every 2 months') return amount*0.5;
  return amount*Math.max(1,occurrences)/Math.max(1,monthsCovered||1);
}

function vfcBiqIsActive_(lastDate, latestStatementDate, frequency) {
  if(!lastDate||!latestStatementDate) return true;
  const days=(latestStatementDate-lastDate)/86400000;
  const allowed=frequency==='Every 2 months'?120:VFC_BANKING_INPUT_CONFIG.ACTIVE_LOOKBACK_DAYS;
  return days>=-3&&days<=allowed;
}

function vfcBiqBestCounterparty_(items) {
  const counts={};
  (items||[]).forEach(function(x){ const t=String(x.counterparty||x.description||'').trim(); if(t) counts[t]=(counts[t]||0)+1; });
  const keys=Object.keys(counts).sort(function(a,b){ return counts[b]!==counts[a]?counts[b]-counts[a]:a.length-b.length; });
  return keys.length?keys[0]:'Recurring Payment';
}

function vfcBiqGroupConfidence_(items) {
  if(!items||!items.length) return 'Low';
  const score=items.reduce(function(s,x){ return s+(x.confidence==='High'?2:x.confidence==='Moderate'?1:0); },0)/items.length;
  return score>=1.5?'High':score>=0.75?'Moderate':'Low';
}

function vfcBiqBuildAudit_(companyName, period) {
  const allRows=vfcBiqReadSummaryRows_(companyName,period);
  const latestBatch=vfcBiqLatestBatch_(allRows);
  const selectedRows=vfcBiqCurrentStatementWindow_(latestBatch);
  let processedRows=0, allStatementsVerified=true, totalDeposits=0, totalWithdrawals=0, nsfCount=0, negativeBalanceFlag=0;
  const monthlyDeposits=[], monthlyWithdrawals=[], statementAudit=[], unverifiedFiles=[], ends=[];
  selectedRows.forEach(function(row){
    const payload=vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if(payload) processedRows++;
    if(!payload||!payload.inputVerified||!payload.headerSummary){ allStatementsVerified=false; unverifiedFiles.push(row.fileName); return; }
    const h=payload.headerSummary;
    const d=vfcBiqPositiveNumber_(h.totalDeposits), w=vfcBiqPositiveNumber_(h.totalWithdrawals);
    totalDeposits+=d; totalWithdrawals+=w; monthlyDeposits.push(d); monthlyWithdrawals.push(w);
    nsfCount+=Math.max(0,vfcBiqNumber_(payload.nsfCount));
    if(vfcBiqTruthyFlag_(row.negativeBalanceDetected)) negativeBalanceFlag=1;
    const end=vfcBiqDate_(h.statementEndDate||row.statementEndDate); if(end) ends.push(end);
    statementAudit.push({ fileName:row.fileName, bank:payload.bankAdapter||payload.bankName||'', statementStartDate:h.statementStartDate||vfcBiqIsoDate_(row.statementStartDate), statementEndDate:h.statementEndDate||vfcBiqIsoDate_(row.statementEndDate), totalDeposits:vfcBiqRound_(d,0.01), totalWithdrawals:vfcBiqRound_(w,0.01), method:payload.method||'', reconciliationDifference:vfcBiqRound_(h.reconciliationDifference,0.01), verified:true });
  });
  const latestStatementDate=ends.length?new Date(Math.max.apply(null,ends.map(function(d){return d.getTime();}))):null;
  const duplicatesIgnored=Math.max(0,latestBatch.length-vfcBiqUniqueStatementRows_(latestBatch).length);
  const olderOrDisconnectedRowsIgnored=Math.max(0,allRows.length-selectedRows.length);
  const warnings=[];
  if(duplicatesIgnored>0) warnings.push(duplicatesIgnored+' duplicate statement row(s) were ignored.');
  if(olderOrDisconnectedRowsIgnored>0) warnings.push(olderOrDisconnectedRowsIgnored+' older, duplicate, previous-upload or disconnected statement row(s) were excluded from the current review window.');
  return { rows:selectedRows, processedRows:processedRows, allStatementsVerified:allStatementsVerified, unverifiedFiles:unverifiedFiles, allMatchingRows:allRows.length, latestBatchRows:latestBatch.length, duplicatesIgnored:duplicatesIgnored, olderOrDisconnectedRowsIgnored:olderOrDisconnectedRowsIgnored, monthsCovered:selectedRows.length, totalDeposits:totalDeposits, totalWithdrawals:totalWithdrawals, nsfCount:nsfCount, negativeBalanceFlag:negativeBalanceFlag, monthlyDeposits:monthlyDeposits, monthlyWithdrawals:monthlyWithdrawals, latestStatementDate:latestStatementDate, statementAudit:statementAudit, warnings:warnings };
}

function vfcBiqLatestBatch_(rows) {
  const sorted=(rows||[]).slice().sort(function(a,b){return vfcBiqTime_(a.createdAt)-vfcBiqTime_(b.createdAt);});
  if(!sorted.length) return [];
  const out=[sorted[sorted.length-1]];
  let lastTime=vfcBiqTime_(sorted[sorted.length-1].createdAt);
  for(let i=sorted.length-2;i>=0;i--){ const time=vfcBiqTime_(sorted[i].createdAt); if(lastTime&&time&&Math.abs(lastTime-time)/60000>VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES) break; out.push(sorted[i]); if(time) lastTime=time; }
  return out.reverse();
}

function vfcBiqCurrentStatementWindow_(rows) {
  const unique=vfcBiqUniqueStatementRows_(rows).sort(function(a,b){return vfcBiqEffectiveDate_(a)-vfcBiqEffectiveDate_(b);});
  const selected=[]; let laterStart=null;
  for(let i=unique.length-1;i>=0;i--){ const row=unique[i], start=vfcBiqDate_(row.statementStartDate), end=vfcBiqDate_(row.statementEndDate)||start; if(selected.length&&laterStart&&end&&(laterStart-end)/86400000>VFC_BANKING_INPUT_CONFIG.MAX_STATEMENT_GAP_DAYS) break; selected.push(row); if(start) laterStart=start; if(selected.length>=VFC_BANKING_INPUT_CONFIG.MAX_STATEMENTS) break; }
  return selected.reverse();
}

function vfcBiqUniqueStatementRows_(rows) {
  const map={};
  (rows||[]).forEach(function(row){ const start=vfcBiqIsoDate_(row.statementStartDate), end=vfcBiqIsoDate_(row.statementEndDate), key=start&&end?start+'|'+end:String(row.fileName||'').toLowerCase(); const existing=map[key]; if(!existing||vfcBiqTime_(row.createdAt)>=vfcBiqTime_(existing.createdAt)) map[key]=row; });
  return Object.keys(map).map(function(k){return map[k];});
}

function vfcBiqReusablePayloadMap_(rows) {
  const map={};
  (rows||[]).forEach(function(row){ const p=vfcBiqParsePayload_(row.possibleMcaOrLoanPayments); if(!p||!p.inputVerified||p.version<VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION) return; const key=p.statementIdentity||vfcBiqStatementIdentity_(row); if(key) map[key]=p; });
  return map;
}

function vfcBiqStatementIdentity_(row) {
  return [vfcBiqBankKey_(row.bankName),String(row.companyName||'').trim().toLowerCase(),vfcBiqIsoDate_(row.statementStartDate),vfcBiqIsoDate_(row.statementEndDate)].join('|');
}

function vfcBiqReadSummaryRows_(companyName, period) {
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if(!sheet) return [];
  const values=sheet.getDataRange().getValues(); if(values.length<2) return [];
  const headers=values[0];
  const c={ upload:vfcBiqColumn_(headers,'Upload ID'), company:vfcBiqColumn_(headers,'Company Name'), period:vfcBiqColumn_(headers,'Detected Period'), file:vfcBiqColumn_(headers,'File Name'), bank:vfcBiqColumnOptional_(headers,'Bank Name'), holder:vfcBiqColumnOptional_(headers,'Account Holder'), start:vfcBiqColumn_(headers,'Statement Start Date'), end:vfcBiqColumn_(headers,'Statement End Date'), opening:vfcBiqColumnOptional_(headers,'Opening Balance'), closing:vfcBiqColumnOptional_(headers,'Closing Balance'), deposits:vfcBiqColumn_(headers,'Total Deposits'), withdrawals:vfcBiqColumn_(headers,'Total Withdrawals'), nsf:vfcBiqColumn_(headers,'NSF Count'), negative:vfcBiqColumn_(headers,'Negative Balance Detected'), signal:vfcBiqColumn_(headers,'Possible MCA Or Loan Payments'), created:vfcBiqColumn_(headers,'Created At') };
  return values.slice(1).map(function(r,i){ return { uploadId:r[c.upload], companyName:r[c.company], detectedPeriod:r[c.period], fileName:String(r[c.file]||'statement.pdf'), bankName:c.bank>=0?r[c.bank]:'', accountHolder:c.holder>=0?r[c.holder]:'', statementStartDate:r[c.start], statementEndDate:r[c.end], openingBalance:c.opening>=0?r[c.opening]:'', closingBalance:c.closing>=0?r[c.closing]:'', totalDeposits:r[c.deposits], totalWithdrawals:r[c.withdrawals], nsfCount:r[c.nsf], negativeBalanceDetected:r[c.negative], possibleMcaOrLoanPayments:r[c.signal], createdAt:r[c.created], rowNumber:i+2, signalColumn:c.signal+1 }; }).filter(function(r){ return (!companyName||vfcBiqSame_(r.companyName,companyName))&&(!period||vfcBiqSame_(r.detectedPeriod,period)); });
}

function vfcBiqUploadMap_() {
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads'); if(!sheet) return {};
  const values=sheet.getDataRange().getValues(); if(values.length<2) return {};
  const headers=values[0], uc=vfcBiqColumn_(headers,'Upload ID'), fc=vfcBiqColumn_(headers,'File ID'), map={};
  values.slice(1).forEach(function(r){ const id=String(r[uc]||'').trim(); if(id) map[id]={fileId:String(r[fc]||'').trim()}; });
  return map;
}

function vfcBiqParsePayload_(value) {
  const text=String(value||'').trim(); if(text.indexOf(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX)!==0) return null;
  try { const p=JSON.parse(text.substring(VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length)); return { version:vfcBiqNumber_(p.version), analyzedAt:p.analyzedAt||'', statementIdentity:p.statementIdentity||'', fileName:p.fileName||'', bankName:p.bankName||'', bankAdapter:p.bankAdapter||'', method:p.method||'', inputVerified:!!p.inputVerified, headerSummary:p.headerSummary||{}, nsfCount:vfcBiqNumber_(p.nsfCount), paymentCandidates:Array.isArray(p.paymentCandidates)?p.paymentCandidates:[], financingCredits:Array.isArray(p.financingCredits)?p.financingCredits:[] }; } catch(e){ return null; }
}

function vfcBiqEffectiveDate_(row){ const p=vfcBiqParsePayload_(row.possibleMcaOrLoanPayments), h=p&&p.headerSummary?p.headerSummary:{}; return vfcBiqDate_(h.statementEndDate||row.statementEndDate||h.statementStartDate||row.statementStartDate)||new Date(0); }
function vfcBiqDedupeSignals_(items){ const seen={}; return (items||[]).filter(function(x){ if(!x) return false; const key=[vfcBiqIsoDate_(x.date),vfcBiqRound_(vfcBiqPositiveNumber_(x.amount),0.01),String(x.category||''),vfcBiqCanonicalLabel_(x)].join('|').toLowerCase(); if(!x.date||!x.category||seen[key]) return false; seen[key]=true; return true; }); }
function vfcBiqResolveTransactionDate_(monthText,dayText,start,end){ const months={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,SEPT:8,OCT:9,NOV:10,DEC:11}, month=months[String(monthText||'').toUpperCase()], day=parseInt(dayText,10); if(month===undefined||!(day>=1&&day<=31)) return null; const years=[]; if(start) years.push(start.getUTCFullYear()); if(end&&years.indexOf(end.getUTCFullYear())<0) years.push(end.getUTCFullYear()); let best=null,bestDistance=Infinity; years.forEach(function(year){ const d=new Date(Date.UTC(year,month,day)), anchor=end||start||new Date(), distance=Math.abs(d-anchor), inside=(!start||d>=new Date(start.getTime()-3*86400000))&&(!end||d<=new Date(end.getTime()+3*86400000)); if(inside&&distance<bestDistance){best=d;bestDistance=distance;} }); return best; }
function vfcBiqRegexMoneyValues_(text,regex){ const values=[]; let m; while((m=regex.exec(String(text||'')))!==null) values.push(vfcBiqPositiveNumber_(m[1])); return values; }
function vfcBiqNumberArray_(value){ return Array.isArray(value)?value.map(vfcBiqPositiveNumber_).filter(function(n){return n>=0;}):[]; }
function vfcBiqColumn_(headers,wanted){ const i=vfcBiqColumnOptional_(headers,wanted); if(i>=0) return i; throw new Error('Missing required column: '+wanted); }
function vfcBiqColumnOptional_(headers,wanted){ const target=String(wanted||'').toLowerCase().replace(/[^a-z0-9]/g,''); for(let i=0;i<headers.length;i++){ if(String(headers[i]||'').toLowerCase().replace(/[^a-z0-9]/g,'')===target) return i; } return -1; }
function vfcBiqNormalizeRequest_(companyOrRequest,requestedPeriod){ let companyName='',period=requestedPeriod||''; if(companyOrRequest&&typeof companyOrRequest==='object'){companyName=companyOrRequest.companyName||companyOrRequest.company||'';period=companyOrRequest.period||companyOrRequest.detectedPeriod||period;}else companyName=companyOrRequest||''; companyName=String(companyName||'').trim(); period=String(period||'').trim(); if(!companyName) throw new Error('Company name is required.'); return {companyName:companyName,period:period}; }
function vfcBiqConfidence_(value){ const t=String(value||'').trim().toLowerCase(); return t==='high'?'High':t==='low'?'Low':'Moderate'; }
function vfcBiqDate_(value){ if(!value) return null; const d=value instanceof Date?value:new Date(value); return isNaN(d.getTime())?null:d; }
function vfcBiqIsoDate_(value){ const d=vfcBiqDate_(value); return d?Utilities.formatDate(d,'UTC','yyyy-MM-dd'):''; }
function vfcBiqNumber_(value){ if(typeof value==='number') return isFinite(value)?value:0; const n=parseFloat(String(value||'').replace(/[^0-9.\-]/g,'')); return isFinite(n)?n:0; }
function vfcBiqNullableNumber_(value){ if(value===''||value===null||value===undefined) return null; const text=String(value).trim(); if(!text) return null; let n=vfcBiqNumber_(text); if(/OD$/i.test(text)) n=-Math.abs(n); return n; }
function vfcBiqNullablePositiveNumber_(value){ if(value===''||value===null||value===undefined) return null; const text=String(value).trim(); if(!text) return null; const n=vfcBiqNumber_(text); return isFinite(n)&&n>=0?n:null; }
function vfcBiqPositiveNumber_(value){ return Math.max(0,vfcBiqNumber_(value)); }
function vfcBiqTruthyFlag_(value){ return /^(1|true|yes|detected)$/i.test(String(value||'').trim())?1:0; }
function vfcBiqRound_(value,step){ const n=vfcBiqNumber_(value), inc=vfcBiqNumber_(step)||1; return Math.round(n/inc)*inc; }
function vfcBiqSum_(values){ return (values||[]).reduce(function(s,v){return s+vfcBiqNumber_(v);},0); }
function vfcBiqMedian_(values){ const a=(values||[]).map(vfcBiqNumber_).filter(function(v){return v>0;}).sort(function(a,b){return a-b;}); if(!a.length) return 0; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function vfcBiqCoefficientOfVariation_(values){ const a=(values||[]).map(vfcBiqNumber_).filter(function(v){return v>=0;}); if(!a.length) return 1; const avg=vfcBiqSum_(a)/a.length; if(!avg) return 1; const variance=a.reduce(function(s,v){return s+Math.pow(v-avg,2);},0)/a.length; return Math.sqrt(variance)/avg; }
function vfcBiqTrend_(values){ const a=(values||[]).map(vfcBiqNumber_); if(a.length<2) return 0; const split=Math.max(1,Math.floor(a.length/2)), first=a.slice(0,split), second=a.slice(split), f=vfcBiqSum_(first)/first.length, s=second.length?vfcBiqSum_(second)/second.length:f; return f>0?(s-f)/f:0; }
function vfcBiqSame_(a,b){ return String(a==null?'':a).trim().toLowerCase()===String(b==null?'':b).trim().toLowerCase(); }
function vfcBiqTime_(value){ const d=vfcBiqDate_(value); return d?d.getTime():0; }
