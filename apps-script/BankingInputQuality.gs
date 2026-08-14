const VFC_BANK = {
  VERSION: 'VFC-BANKING-STABLE-12.0-AUTO-LOCKED',
  PREFIX: 'VFC_BANK_LOCKED_V1:',
  LEGACY_PREFIXES: [
    'VFC_BANK_AUTO_V2:',
    'VFC_BANK_AUTO_V1:',
    'VFC_BANKING_STABLE_V1:',
    'VFC_BANKING_V11:',
    'VFC_BANKING_V10:',
    'VFC_BANKING_V9:'
  ],
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_DAYS: 90,
  MODEL: 'gpt-4.1-mini',
  MAX_TEXT_CHARS: 120000
};

function getBankingInputQualityStatus() {
  const status = {
    modelVersion: VFC_BANK.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    bankAgnostic: true,
    verifiedResultReuse: true,
    recentDebtSignalsRequired: true,
    balanceReconciliationRequired: true,
    partialResultsAllowed: false,
    repeatedPadDetection: true,
    sameVerifiedStatementsSameBankingInputs: true,
    historicalTrainingPdfReprocessingRequired: false
  };
  console.log(JSON.stringify(status, null, 2));
  return status;
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const request = vfcBankReq_(companyOrRequest, requestedPeriod);
    const period = request.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(request.companyName, request.period)
      : request.period);
    const base = vfcBankBaseFeatures_(request.companyName, period);
    const rows = vfcBankSelected_(request.companyName, period);
    if (!rows.length) throw new Error('No bank statements found for this company and period.');

    const ensured = vfcBankEnsureCurrent_(request.companyName, period, rows);
    if (!ensured.ok) {
      return {
        ok: false,
        modelVersion: VFC_BANK.VERSION,
        companyName: request.companyName,
        period: period,
        errors: ensured.errors,
        unverifiedFiles: ensured.bad
      };
    }

    const features = vfcBankBuild_(base || {}, rows);
    return {
      ok: true,
      modelVersion: VFC_BANK.VERSION,
      companyName: request.companyName,
      period: period,
      filesAnalyzed: ensured.analyzed,
      filesReused: ensured.reused,
      filesAdopted: ensured.adopted,
      filesSkipped: ensured.skipped,
      errors: [],
      statementAudit: features.inputQualityAudit.statementAudit,
      debtProfile: features.debtProfile,
      bankingFeatures: {
        averageMonthlyDeposits: features.averageMonthlyDeposits,
        estimatedOperatingMonthlyDeposits: features.estimatedOperatingMonthlyDeposits,
        existingMonthlyDebtService: features.existingMonthlyDebtService,
        informationalRecurringMonthlyObligations: features.informationalRecurringMonthlyObligations
      }
    };
  } catch (error) {
    return {
      ok: false,
      modelVersion: VFC_BANK.VERSION,
      errors: [String(error && error.message || error)]
    };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcBankRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a, b) { return vfcBankTime_(a.createdAt) - vfcBankTime_(b.createdAt); });
  const last = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({
    companyName: last.companyName,
    period: last.detectedPeriod
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseLatestBankingInputs() {
  return refreshLatestDebtSignals();
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = vfcBankBaseFeatures_(companyName, period);
  if (!base) return null;

  const rows = vfcBankSelected_(companyName, period);
  if (!rows.length) return base;

  const ensured = vfcBankEnsureCurrent_(companyName, period, rows);
  if (!ensured.ok) {
    throw new Error(
      'Unable to verify uploaded statement(s) automatically: ' +
      ensured.bad.join(', ') +
      (ensured.errors.length ? '. ' + ensured.errors.join(' | ') : '')
    );
  }

  return vfcBankBuild_(base, rows);
}

function vfcBankBaseFeatures_(companyName, period) {
  if (typeof buildPowerFeatures_ === 'function') return buildPowerFeatures_(companyName, period);
  if (typeof buildFeaturesForCase_ === 'function') return buildFeaturesForCase_(companyName, period);
  return null;
}

function vfcBankEnsureCurrent_(company, period, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('PDF Summaries');
  if (!sheet) throw new Error('Missing PDF Summaries sheet.');

  const uploads = vfcBankUploads_();
  const reuse = vfcBankBestReuseMap_(vfcBankRows_(company, ''));
  let analyzed = 0;
  let reused = 0;
  let adopted = 0;
  let skipped = 0;
  const errors = [];

  rows.forEach(function(row, index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    const current = vfcBankNewPayload_(row.signal, recent);
    if (current) {
      skipped++;
      return;
    }

    const key = vfcBankKey_(row);
    const reusable = reuse[key] || null;
    if (reusable && vfcBankPayloadValid_(reusable, recent)) {
      const adoptedPayload = vfcBankRekeyPayload_(reusable, row);
      vfcBankWrite_(sheet, row, adoptedPayload);
      reuse[key] = adoptedPayload;
      reused++;
      return;
    }

    const legacy = vfcBankLegacyPayload_(row.signal, row);
    if (legacy && vfcBankPayloadValid_(legacy, recent)) {
      vfcBankWrite_(sheet, row, legacy);
      reuse[key] = legacy;
      adopted++;
      return;
    }

    const stored = vfcBankStoredPayload_(row);
    if (!recent && stored) {
      vfcBankWrite_(sheet, row, stored);
      reuse[key] = stored;
      adopted++;
      return;
    }

    try {
      const upload = uploads[String(row.uploadId || '').trim()] || {};
      if (!upload.fileId) throw new Error('uploaded PDF file was not found');
      if (typeof extractTextFromPdf_ !== 'function') throw new Error('PDF text reader is unavailable');

      const text = extractTextFromPdf_(upload.fileId);
      let payload = null;
      let lastError = '';

      for (let attempt = 0; attempt < 2 && !payload; attempt++) {
        try {
          if (stored) {
            const signals = vfcBankExtractSignals_(text, row);
            payload = vfcBankMakePayload_(row, {
              bankName: signals.bank || row.bank || 'Unknown',
              openingBalance: stored.openingBalance,
              closingBalance: stored.closingBalance,
              totalDeposits: stored.totalDeposits,
              totalWithdrawals: stored.totalWithdrawals,
              reconciliationDifference: stored.reconciliationDifference,
              totalsSource: stored.totalsSource,
              nsfCount: signals.nsf,
              negativeBalanceDetected: signals.negative,
              paymentCandidates: signals.payments,
              financingCredits: signals.financingCredits,
              signalsVerified: true,
              signalSource: 'PDF_SIGNAL_EXTRACTION'
            });
          } else {
            payload = vfcBankVerifyFullExtract_(vfcBankExtractFull_(text, row), row);
          }
        } catch (error) {
          lastError = String(error && error.message || error);
        }
      }

      if (!payload) {
        if (reusable && vfcBankPayloadValid_(reusable, recent)) {
          payload = vfcBankRekeyPayload_(reusable, row);
        } else {
          throw new Error(lastError || 'statement could not be verified');
        }
      }

      vfcBankWrite_(sheet, row, payload);
      reuse[key] = payload;
      analyzed++;
    } catch (error) {
      errors.push(row.fileName + ': ' + String(error && error.message || error));
    }
  });

  const bad = [];
  rows.forEach(function(row, index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    if (!vfcBankPayloadAt_(row.row, row.col, recent)) bad.push(row.fileName);
  });

  return {
    ok: bad.length === 0,
    analyzed: analyzed,
    reused: reused,
    adopted: adopted,
    skipped: skipped,
    errors: errors,
    bad: bad
  };
}

function vfcBankStoredPayload_(row) {
  const opening = vfcBankNull_(row.opening);
  const closing = vfcBankNull_(row.closing);
  const deposits = vfcBankNullPos_(row.totalDeposits);
  const withdrawals = vfcBankNullPos_(row.totalWithdrawals);
  if (opening === null || closing === null || deposits === null || withdrawals === null) return null;

  const diff = Math.abs((opening + deposits - withdrawals) - closing);
  if (diff > VFC_BANK.RECONCILE_TOLERANCE) return null;

  return vfcBankMakePayload_(row, {
    bankName: row.bank || 'Unknown',
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: deposits,
    totalWithdrawals: withdrawals,
    reconciliationDifference: diff,
    totalsSource: 'STORED_SUMMARY_RECONCILED',
    nsfCount: row.nsfCount,
    negativeBalanceDetected: vfcBankFlag_(row.negativeBalance),
    paymentCandidates: [],
    financingCredits: [],
    signalsVerified: false,
    signalSource: 'NONE'
  });
}

function vfcBankLegacyPayload_(value, row) {
  const text = String(value || '').trim();
  let prefix = '';
  for (let i = 0; i < VFC_BANK.LEGACY_PREFIXES.length; i++) {
    if (text.indexOf(VFC_BANK.LEGACY_PREFIXES[i]) === 0) {
      prefix = VFC_BANK.LEGACY_PREFIXES[i];
      break;
    }
  }
  if (!prefix) return null;

  let raw;
  try {
    raw = JSON.parse(text.substring(prefix.length));
  } catch (error) {
    return null;
  }
  if (!raw) return null;

  const header = raw.headerSummary || raw;
  const opening = vfcBankNull_(header.openingBalance);
  const closing = vfcBankNull_(header.closingBalance);
  const deposits = vfcBankNullPos_(header.totalDeposits);
  const withdrawals = vfcBankNullPos_(header.totalWithdrawals);
  if (opening === null || closing === null || deposits === null || withdrawals === null) return null;

  const diff = Math.abs((opening + deposits - withdrawals) - closing);
  if (diff > VFC_BANK.RECONCILE_TOLERANCE) return null;

  const payments = vfcBankPayments_(raw.paymentCandidates || []);
  const credits = vfcBankCredits_(raw.financingCredits || []);
  const source = String(raw.signalSource || raw.method || raw.totalsSource || '').toUpperCase();
  const signalsVerified = payments.length > 0 || credits.length > 0 || /PDF|OCR|OPENAI|AI_|TD_PAGE|STRUCTURED_SIGNAL|REUSED_VERIFIED/.test(source);

  return vfcBankMakePayload_(row, {
    bankName: raw.bankAdapter || raw.bankName || row.bank || 'Unknown',
    openingBalance: opening,
    closingBalance: closing,
    totalDeposits: deposits,
    totalWithdrawals: withdrawals,
    reconciliationDifference: diff,
    totalsSource: 'ADOPTED_PRIOR_VERIFIED_RESULT',
    nsfCount: raw.nsfCount !== undefined ? raw.nsfCount : row.nsfCount,
    negativeBalanceDetected: raw.negativeBalanceDetected !== undefined
      ? raw.negativeBalanceDetected
      : vfcBankFlag_(row.negativeBalance),
    paymentCandidates: payments,
    financingCredits: credits,
    signalsVerified: signalsVerified,
    signalSource: source || 'LEGACY'
  });
}

function vfcBankMakePayload_(row, values) {
  return {
    version: 1,
    modelVersion: VFC_BANK.VERSION,
    verified: true,
    signalsVerified: !!values.signalsVerified,
    verifiedAt: new Date().toISOString(),
    statementKey: vfcBankKey_(row),
    bankName: String(values.bankName || row.bank || 'Unknown'),
    statementStartDate: vfcBankIso_(row.start),
    statementEndDate: vfcBankIso_(row.end),
    openingBalance: vfcBankRound_(values.openingBalance, .01),
    closingBalance: vfcBankRound_(values.closingBalance, .01),
    totalDeposits: vfcBankRound_(values.totalDeposits, .01),
    totalWithdrawals: vfcBankRound_(values.totalWithdrawals, .01),
    reconciliationDifference: vfcBankRound_(values.reconciliationDifference, .01),
    totalsSource: String(values.totalsSource || ''),
    signalSource: String(values.signalSource || ''),
    nsfCount: Math.max(0, Math.round(vfcBankNum_(values.nsfCount))),
    negativeBalanceDetected: !!values.negativeBalanceDetected,
    paymentCandidates: vfcBankPayments_(values.paymentCandidates || []),
    financingCredits: vfcBankCredits_(values.financingCredits || [])
  };
}

function vfcBankRekeyPayload_(payload, row) {
  return vfcBankMakePayload_(row, {
    bankName: payload.bankName,
    openingBalance: payload.openingBalance,
    closingBalance: payload.closingBalance,
    totalDeposits: payload.totalDeposits,
    totalWithdrawals: payload.totalWithdrawals,
    reconciliationDifference: payload.reconciliationDifference,
    totalsSource: payload.totalsSource || 'REUSED_VERIFIED_RESULT',
    signalSource: payload.signalSource || 'REUSED_VERIFIED_RESULT',
    nsfCount: payload.nsfCount,
    negativeBalanceDetected: payload.negativeBalanceDetected,
    paymentCandidates: payload.paymentCandidates || [],
    financingCredits: payload.financingCredits || [],
    signalsVerified: !!payload.signalsVerified
  });
}

function vfcBankExtractSignals_(statementText, row) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      bank: { type: 'string' },
      nsf: { type: 'integer', minimum: 0 },
      negative: { type: 'boolean' },
      payments: vfcBankPaymentSchema_(),
      financingCredits: vfcBankCreditSchema_()
    },
    required: ['bank', 'nsf', 'negative', 'payments', 'financingCredits']
  };

  const instructions = [
    'Read this complete business bank statement. It may be from any Canadian bank or credit union.',
    'Extract individual exact debit transactions that are clearly loan, financing, MCA, PAD/preauthorized debit, tax/government, insurance finance, credit-card payment, or another fixed recurring obligation.',
    'Do not decide recurrence. Return every qualifying occurrence separately with its exact date and amount.',
    'Do not classify bank fees, NSF fees, payment coverage fees, suppliers, payroll, fuel, purchases, ordinary transfers, e-transfers, cheques, or normal operating expenses as financing debt.',
    'A generic PAD can be category PAD even when no lender name is known.',
    'Financing credits are incoming credits only when the description explicitly proves loan, funding, financing, advance, MCA, or cash-advance proceeds.',
    'Never use a nearby amount or infer an amount from another line.',
    'Use YYYY-MM-DD dates. Return JSON only.'
  ].join(' ');

  return vfcBankOpenAIJson_(statementText, row, schema, instructions, 'vfc_bank_signals_v12');
}

function vfcBankExtractFull_(statementText, row) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      bank: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      opening: { type: ['number', 'null'] },
      closing: { type: ['number', 'null'] },
      credits: { type: ['number', 'null'] },
      debits: { type: ['number', 'null'] },
      pageCredits: { type: 'array', items: { type: 'number' } },
      pageDebits: { type: 'array', items: { type: 'number' } },
      transactionCredits: { type: ['number', 'null'] },
      transactionDebits: { type: ['number', 'null'] },
      nsf: { type: 'integer', minimum: 0 },
      negative: { type: 'boolean' },
      payments: vfcBankPaymentSchema_(),
      financingCredits: vfcBankCreditSchema_()
    },
    required: [
      'bank', 'start', 'end', 'opening', 'closing', 'credits', 'debits',
      'pageCredits', 'pageDebits', 'transactionCredits', 'transactionDebits',
      'nsf', 'negative', 'payments', 'financingCredits'
    ]
  };

  const instructions = [
    'Read this complete business bank statement. It may be from any Canadian bank or credit union.',
    'Return only figures explicitly supported by the statement. Never estimate.',
    'Opening and closing are the first and final statement balances.',
    'Credits and debits are whole-statement totals, never a single page subtotal.',
    'If page credit/debit subtotals are printed, return every page subtotal exactly once.',
    'Return transactionCredits and transactionDebits only if every statement transaction can be confidently totaled; otherwise return null.',
    'Never use average balance, minimum balance, available balance, or running balances as deposits or withdrawals.',
    'For payments return every individual exact debit that is clearly loan, financing, MCA, PAD/preauthorized debit, tax/government, insurance finance, credit-card payment, or another fixed recurring obligation.',
    'Do not classify bank fees, NSF fees, payment coverage fees, suppliers, payroll, fuel, purchases, ordinary transfers, e-transfers, cheques, or normal operating expenses as financing debt.',
    'A generic PAD can be category PAD even when no lender name is known.',
    'Financing credits are incoming credits only when the description explicitly proves loan, funding, financing, advance, MCA, or cash-advance proceeds.',
    'Use YYYY-MM-DD dates. Return JSON only.'
  ].join(' ');

  return vfcBankOpenAIJson_(statementText, row, schema, instructions, 'vfc_bank_full_v12');
}

function vfcBankPaymentSchema_() {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string' },
        description: { type: 'string' },
        counterparty: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        category: { type: 'string', enum: ['LOAN', 'MCA', 'FINANCING', 'PAD', 'TAX', 'INSURANCE', 'CREDIT_CARD', 'OTHER'] },
        confidence: { type: 'string', enum: ['High', 'Moderate', 'Low'] }
      },
      required: ['date', 'description', 'counterparty', 'amount', 'category', 'confidence']
    }
  };
}

function vfcBankCreditSchema_() {
  return {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string' },
        description: { type: 'string' },
        counterparty: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        confidence: { type: 'string', enum: ['High', 'Moderate', 'Low'] }
      },
      required: ['date', 'description', 'counterparty', 'amount', 'confidence']
    }
  };
}

function vfcBankOpenAIJson_(statementText, row, schema, instructions, schemaName) {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY.');

  const model = properties.getProperty('OPENAI_BANKING_MODEL') ||
    (typeof VFC_CONFIG !== 'undefined' && VFC_CONFIG.OPENAI_MODEL
      ? VFC_CONFIG.OPENAI_MODEL
      : VFC_BANK.MODEL);

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model: model,
      instructions: instructions,
      input: JSON.stringify({
        file: row.fileName,
        knownStart: vfcBankIso_(row.start),
        knownEnd: vfcBankIso_(row.end),
        statementText: String(statementText || '').substring(0, VFC_BANK.MAX_TEXT_CHARS)
      }),
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema: schema
        }
      }
    }),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('Unreadable statement extraction response. HTTP ' + status + '.');
  }

  if (status < 200 || status >= 300 || body.error) {
    throw new Error(
      body && body.error && body.error.message
        ? body.error.message
        : 'Statement extraction failed. HTTP ' + status + '.'
    );
  }

  const output = vfcBankOutput_(body);
  if (!output) throw new Error('Empty statement extraction response.');

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error('Statement extraction was not valid JSON.');
  }
}

function vfcBankVerifyFullExtract_(raw, row) {
  raw = raw || {};
  const totals = [];
  const statementCredits = vfcBankNullPos_(raw.credits);
  const statementDebits = vfcBankNullPos_(raw.debits);
  const pageCredits = vfcBankArr_(raw.pageCredits);
  const pageDebits = vfcBankArr_(raw.pageDebits);
  const transactionCredits = vfcBankNullPos_(raw.transactionCredits);
  const transactionDebits = vfcBankNullPos_(raw.transactionDebits);

  if (statementCredits !== null && statementDebits !== null) {
    totals.push({ credits: statementCredits, debits: statementDebits, source: 'STATEMENT_TOTALS', rank: 1 });
  }
  if (pageCredits.length && pageDebits.length) {
    totals.push({ credits: vfcBankSum_(pageCredits), debits: vfcBankSum_(pageDebits), source: 'PAGE_SUBTOTALS', rank: 1 });
  }
  if (transactionCredits !== null && transactionDebits !== null) {
    totals.push({ credits: transactionCredits, debits: transactionDebits, source: 'TRANSACTION_SUM', rank: 2 });
  }

  const balances = [];
  const extractedOpening = vfcBankNull_(raw.opening);
  const extractedClosing = vfcBankNull_(raw.closing);
  const storedOpening = vfcBankNull_(row.opening);
  const storedClosing = vfcBankNull_(row.closing);

  if (extractedOpening !== null && extractedClosing !== null) {
    balances.push({ opening: extractedOpening, closing: extractedClosing, source: 'EXTRACTED_BALANCES' });
  }
  if (storedOpening !== null && storedClosing !== null &&
      (storedOpening !== extractedOpening || storedClosing !== extractedClosing)) {
    balances.push({ opening: storedOpening, closing: storedClosing, source: 'STORED_BALANCES' });
  }

  let best = null;
  totals.forEach(function(total) {
    balances.forEach(function(balance) {
      const diff = Math.abs(
        (balance.opening + total.credits - total.debits) - balance.closing
      );
      if (diff <= VFC_BANK.RECONCILE_TOLERANCE) {
        const candidate = {
          opening: balance.opening,
          closing: balance.closing,
          deposits: total.credits,
          withdrawals: total.debits,
          diff: diff,
          source: total.source + '+' + balance.source,
          rank: total.rank
        };
        if (!best || candidate.diff < best.diff ||
            (Math.abs(candidate.diff - best.diff) < 0.001 && candidate.rank < best.rank)) {
          best = candidate;
        }
      }
    });
  });

  if (!best) throw new Error('statement totals did not reconcile');

  return vfcBankMakePayload_(row, {
    bankName: raw.bank || row.bank || 'Unknown',
    openingBalance: best.opening,
    closingBalance: best.closing,
    totalDeposits: best.deposits,
    totalWithdrawals: best.withdrawals,
    reconciliationDifference: best.diff,
    totalsSource: best.source,
    nsfCount: raw.nsf,
    negativeBalanceDetected: !!raw.negative,
    paymentCandidates: raw.payments || [],
    financingCredits: raw.financingCredits || [],
    signalsVerified: true,
    signalSource: 'PDF_FULL_EXTRACTION'
  });
}

function vfcBankBuild_(base, rows) {
  let deposits = 0;
  let withdrawals = 0;
  let nsf = 0;
  let negative = 0;
  let latest = null;
  const monthlyDeposits = [];
  const monthlyWithdrawals = [];
  const audit = [];
  const verifiedRows = [];

  rows.forEach(function(row, index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    const payload = vfcBankPayloadAt_(row.row, row.col, recent);
    if (!payload) throw new Error('Verified statement result missing: ' + row.fileName);

    deposits += payload.totalDeposits;
    withdrawals += payload.totalWithdrawals;
    monthlyDeposits.push(payload.totalDeposits);
    monthlyWithdrawals.push(payload.totalWithdrawals);
    nsf += Math.max(0, vfcBankNum_(payload.nsfCount));
    if (payload.negativeBalanceDetected) negative = 1;

    const endDate = vfcBankDate_(payload.statementEndDate);
    if (endDate && (!latest || endDate > latest)) latest = endDate;

    verifiedRows.push({ row: row, payload: payload });
    audit.push({
      fileName: row.fileName,
      bank: payload.bankName,
      statementStartDate: payload.statementStartDate,
      statementEndDate: payload.statementEndDate,
      totalDeposits: payload.totalDeposits,
      totalWithdrawals: payload.totalWithdrawals,
      openingBalance: payload.openingBalance,
      closingBalance: payload.closingBalance,
      reconciliationDifference: payload.reconciliationDifference,
      totalsSource: payload.totalsSource,
      signalSource: payload.signalSource,
      signalsVerified: payload.signalsVerified,
      verified: true
    });
  });

  const recentRows = verifiedRows.slice(Math.max(0, verifiedRows.length - VFC_BANK.DEBT_LOOKBACK));
  const debt = vfcBankDebt_(recentRows, latest);
  const months = verifiedRows.length;
  const grossMonthly = deposits / Math.max(1, months);
  const operatingTotal = Math.max(0, deposits - debt.financingCreditsTotal);
  const operatingMonthly = operatingTotal / Math.max(1, months);

  return Object.assign({}, base, {
    statementCount: months,
    monthsCovered: months,
    totalDeposits: vfcBankRound_(deposits, .01),
    averageMonthlyDeposits: vfcBankRound_(grossMonthly, .01),
    totalWithdrawals: vfcBankRound_(withdrawals, .01),
    depositWithdrawalRatio: withdrawals > 0 ? vfcBankRound_(deposits / withdrawals, .01) : 0,
    nsfCount: nsf,
    nsfPerMonth: vfcBankRound_(nsf / Math.max(1, months), .01),
    negativeBalanceFlag: negative,
    mcaPaymentFlag: debt.activeDebtObligations.length ? 1 : 0,
    monthlyDeposits: monthlyDeposits,
    monthlyWithdrawals: monthlyWithdrawals,
    depositVolatility: vfcBankRound_(vfcBankCv_(monthlyDeposits), .01),
    depositTrend: vfcBankRound_(vfcBankTrend_(monthlyDeposits), .01),
    estimatedOperatingTotalDeposits: vfcBankRound_(operatingTotal, .01),
    estimatedOperatingMonthlyDeposits: vfcBankRound_(operatingMonthly, .01),
    detectedFinancingCredits: vfcBankRound_(debt.financingCreditsTotal, .01),
    existingMonthlyDebtService: vfcBankRound_(debt.confirmedMonthlyDebtService, .01),
    otherRecurringMonthlyObligations: 0,
    informationalRecurringMonthlyObligations: vfcBankRound_(debt.informationalMonthlyObligations, .01),
    debtServiceToDepositsRatio: grossMonthly > 0
      ? vfcBankRound_(debt.confirmedMonthlyDebtService / grossMonthly, .0001)
      : 0,
    debtProfile: debt,
    inputQualityAudit: {
      modelVersion: VFC_BANK.VERSION,
      verified: true,
      selectedStatementRows: months,
      grossAverageMonthlyDeposits: vfcBankRound_(grossMonthly, .01),
      estimatedOperatingMonthlyDeposits: vfcBankRound_(operatingMonthly, .01),
      statementAudit: audit,
      warnings: []
    }
  });
}

function vfcBankPayments_(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = {};

  items.forEach(function(item) {
    item = item || {};
    const amount = vfcBankPos_(item.amount);
    const description = String(item.description || '').trim();
    const date = vfcBankIso_(item.date);
    const category = vfcBankCategory_(item.category, description);

    if (!date || !description || amount <= 0 || !category) return;
    if (/\bFEE\b|SERVICE\s+CHARGE|NSF|PAYMENT\s+COVERAGE/i.test(description)) return;

    const normalized = {
      date: date,
      description: description.substring(0, 180),
      counterparty: String(item.counterparty || description).trim().substring(0, 120),
      amount: vfcBankRound_(amount, .01),
      category: category,
      confidence: vfcBankConf_(item.confidence)
    };

    const key = [
      normalized.date,
      normalized.amount,
      normalized.category,
      vfcBankCanon_(normalized)
    ].join('|');

    if (!seen[key]) {
      seen[key] = 1;
      out.push(normalized);
    }
  });

  return out;
}

function vfcBankCategory_(category, description) {
  const c = String(category || '').toUpperCase();
  if (['LOAN', 'TERM_LOAN', 'TRUCK_FINANCE', 'AUTO_FINANCE', 'COMMERCIAL_LOAN', 'LOC', 'LEASE_FINANCE'].indexOf(c) >= 0) return 'LOAN';
  if (c === 'MCA') return 'MCA';
  if (['FINANCING', 'OTHER_FINANCING_PAYMENT'].indexOf(c) >= 0) return 'FINANCING';
  if (['PAD', 'RECURRING_PAD'].indexOf(c) >= 0) return 'PAD';
  if (['TAX', 'TAX_GOVERNMENT'].indexOf(c) >= 0) return 'TAX';
  if (['INSURANCE', 'INSURANCE_FINANCE'].indexOf(c) >= 0) return 'INSURANCE';
  if (['CREDIT_CARD', 'CREDIT_CARD_PAYMENT'].indexOf(c) >= 0) return 'CREDIT_CARD';
  if (['OTHER', 'OTHER_RECURRING'].indexOf(c) >= 0) return 'OTHER';

  const s = String(description || '').toUpperCase();
  if (/\bCRA\b|\bCCRA\b|GST|HST|\bTAX\b|WCB|EMPTX|TXBAL/.test(s)) return 'TAX';
  if (/\bIPFS\b|PREMIUM\s+FIN|INSURANCE\s+FIN|\bINSURANCE\b/.test(s)) return 'INSURANCE';
  if (/CREDIT\s+CARD/.test(s)) return 'CREDIT_CARD';
  if (/\bPAD\b|PRE[- ]?AUTH/.test(s)) return 'PAD';
  if (/\bMCA\b|MERCHANT\s+CASH\s+ADVANCE/.test(s)) return 'MCA';
  if (/TRUCK\s*FIN|TRUCKFIN|FORD\s+CREDIT|\bLOAN\b/.test(s)) return 'LOAN';
  if (/FINANC|CASH\s+ADVANCE/.test(s)) return 'FINANCING';
  return '';
}

function vfcBankCredits_(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = {};

  items.forEach(function(item) {
    item = item || {};
    const amount = vfcBankPos_(item.amount);
    const date = vfcBankIso_(item.date);
    const description = String(item.description || '').trim();
    const confidence = vfcBankConf_(item.confidence);
    const legacyCategory = String(item.category || '').toUpperCase();
    const proven = /LOAN|FUND|FINANC|ADVANCE|CASH\s+ADVANCE|\bMCA\b/i.test(description) ||
      /LOAN_ADVANCE|MCA_ADVANCE|OTHER_FINANCING_CREDIT/.test(legacyCategory);

    if (!date || !description || amount < 5000 || confidence !== 'High' || !proven) return;

    const normalized = {
      date: date,
      description: description.substring(0, 180),
      counterparty: String(item.counterparty || description).trim().substring(0, 120),
      amount: vfcBankRound_(amount, .01),
      confidence: confidence
    };

    const key = [normalized.date, normalized.amount, normalized.description.toLowerCase()].join('|');
    if (!seen[key]) {
      seen[key] = 1;
      out.push(normalized);
    }
  });

  return out;
}

function vfcBankDebt_(verifiedRows, latest) {
  let payments = [];
  let credits = [];

  (verifiedRows || []).forEach(function(item) {
    payments = payments.concat(item.payload.paymentCandidates || []);
    credits = credits.concat(item.payload.financingCredits || []);
  });

  const groups = {};
  payments.forEach(function(payment) {
    const family = vfcBankFamily_(payment.category);
    const canonical = vfcBankCanon_(payment);
    if (!canonical) return;
    const key = family + '|' + canonical;
    if (!groups[key]) {
      groups[key] = {
        family: family,
        category: payment.category,
        canonical: canonical,
        items: []
      };
    }
    groups[key].items.push(payment);
  });

  const observed = Object.keys(groups)
    .map(function(key) { return vfcBankGroup_(groups[key], latest); })
    .filter(Boolean);

  const active = observed.filter(function(item) {
    return item.active && item.recurring &&
      (item.family === 'FINANCING' || item.family === 'PAD') &&
      item.confidence !== 'Low';
  });

  const tax = observed.filter(function(item) {
    return item.active && item.recurring && item.family === 'TAX';
  });

  const other = observed.filter(function(item) {
    return item.active && item.recurring &&
      item.family !== 'FINANCING' &&
      item.family !== 'PAD' &&
      item.family !== 'TAX';
  });

  const creditSeen = {};
  credits = credits.filter(function(item) {
    const key = [item.date, item.amount, item.description.toLowerCase()].join('|');
    if (creditSeen[key]) return false;
    creditSeen[key] = 1;
    return true;
  });

  return {
    confirmedMonthlyDebtService: vfcBankRound_(
      active.reduce(function(sum, item) { return sum + item.monthlyEquivalent; }, 0),
      .01
    ),
    informationalMonthlyObligations: vfcBankRound_(
      tax.concat(other).reduce(function(sum, item) { return sum + item.monthlyEquivalent; }, 0),
      .01
    ),
    activeDebtObligations: active,
    taxGovernmentPads: tax,
    otherRecurringObligations: other,
    observedOnce: observed.filter(function(item) { return !item.recurring; }),
    allDetectedObligations: observed,
    financingCredits: credits,
    financingCreditsTotal: vfcBankRound_(
      credits.reduce(function(sum, item) { return sum + item.amount; }, 0),
      .01
    ),
    note: 'Confirmed debt uses repeated explicit financing/loan/MCA payments or repeated PADs. Tax, insurance, cards and unclear recurring obligations are informational only.'
  };
}

function vfcBankFamily_(category) {
  const c = String(category || '').toUpperCase();
  if (c === 'LOAN' || c === 'MCA' || c === 'FINANCING') return 'FINANCING';
  if (c === 'PAD') return 'PAD';
  if (c === 'TAX') return 'TAX';
  if (c === 'INSURANCE') return 'INSURANCE';
  if (c === 'CREDIT_CARD') return 'CREDIT_CARD';
  return 'OTHER';
}

function vfcBankGroup_(group, latest) {
  const seen = {};
  const items = (group.items || []).filter(function(item) {
    const key = item.date + '|' + vfcBankRound_(item.amount, .01);
    if (seen[key]) return false;
    seen[key] = 1;
    return true;
  }).sort(function(a, b) {
    return vfcBankDate_(a.date) - vfcBankDate_(b.date);
  });

  if (!items.length) return null;

  const dates = items.map(function(item) { return vfcBankDate_(item.date); }).filter(Boolean);
  const amounts = items.map(function(item) { return item.amount; }).filter(function(amount) { return amount > 0; });
  const recurring = dates.length >= 2;
  const frequency = recurring ? vfcBankFrequency_(dates) : 'Observed once';
  const paymentAmount = vfcBankMedian_(amounts);
  const monthly = recurring ? vfcBankMonthly_(paymentAmount, frequency, dates) : 0;
  const last = dates[dates.length - 1];
  const daysSinceLast = latest && last ? (latest - last) / 86400000 : 0;
  const active = recurring && (!latest || (daysSinceLast >= -3 && daysSinceLast <= VFC_BANK.ACTIVE_DAYS));

  return {
    counterparty: vfcBankBest_(items),
    description: items[0].description || '',
    category: group.category,
    family: group.family,
    paymentAmount: vfcBankRound_(paymentAmount, .01),
    frequency: frequency,
    monthlyEquivalent: vfcBankRound_(monthly, .01),
    occurrences: dates.length,
    firstSeen: vfcBankIso_(dates[0]),
    lastSeen: vfcBankIso_(last),
    recurring: recurring,
    active: active,
    confidence: vfcBankGroupConf_(items),
    patternLabel: group.canonical
  };
}

function vfcBankCanon_(item) {
  let text = String((item && (item.counterparty || item.description)) || '').toUpperCase();

  if (item && item.category === 'TAX') {
    if (/\bCRA\b|\bCCRA\b/.test(text)) return 'CRA CCRA TAX';
    if (/GST|HST/.test(text)) return 'GST HST TAX';
    if (/WCB/.test(text)) return 'WCB';
    if (/EMPTX/.test(text)) return 'EMPLOYER TAX';
    if (/TXBAL/.test(text)) return 'TAX BALANCE';
  }

  return text
    .replace(/\b(?:PAYMENT|PAYMENTS|PYMT|PMT|PAD|PAA|APY|MSP|EFT|DEBIT|WITHDRAWAL|PREAUTHORIZED|PRE-AUTHORIZED)\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
}

function vfcBankFrequency_(dates) {
  const sorted = dates.slice().sort(function(a, b) { return a - b; });
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.abs((sorted[i] - sorted[i - 1]) / 86400000);
    if (gap > 0) gaps.push(gap);
  }

  const medianGap = vfcBankMedian_(gaps);
  if (medianGap <= 4) return 'Business daily';
  if (medianGap <= 10) return 'Weekly';
  if (medianGap <= 20) return 'Biweekly';
  if (medianGap <= 45) return 'Monthly';
  if (medianGap <= 75) return 'Every 2 months';
  return 'Irregular';
}

function vfcBankMonthly_(amount, frequency, dates) {
  if (frequency === 'Business daily') return amount * 21.7;
  if (frequency === 'Weekly') return amount * 4.33;
  if (frequency === 'Biweekly') return amount * 2.17;
  if (frequency === 'Monthly') return amount;
  if (frequency === 'Every 2 months') return amount * .5;

  if (frequency === 'Irregular' && dates && dates.length >= 2) {
    const sorted = dates.slice().sort(function(a, b) { return a - b; });
    const spanDays = Math.max(30, (sorted[sorted.length - 1] - sorted[0]) / 86400000);
    return amount * dates.length / Math.max(1, spanDays / 30.4375);
  }

  return 0;
}

function vfcBankSelected_(company, period) {
  const rows = vfcBankRows_(company, period);
  const map = {};

  rows.forEach(function(row) {
    const key = vfcBankKey_(row);
    const old = map[key];
    if (!old || vfcBankTime_(row.createdAt) >= vfcBankTime_(old.createdAt)) {
      map[key] = row;
    }
  });

  return Object.keys(map)
    .map(function(key) { return map[key]; })
    .sort(function(a, b) {
      return (vfcBankDate_(a.end) || new Date(0)) - (vfcBankDate_(b.end) || new Date(0));
    })
    .slice(-VFC_BANK.MAX_STATEMENTS);
}

function vfcBankRows_(company, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const columns = {
    upload: vfcBankCol_(headers, 'Upload ID'),
    company: vfcBankCol_(headers, 'Company Name'),
    period: vfcBankCol_(headers, 'Detected Period'),
    file: vfcBankCol_(headers, 'File Name'),
    bank: vfcBankColOpt_(headers, 'Bank Name'),
    start: vfcBankCol_(headers, 'Statement Start Date'),
    end: vfcBankCol_(headers, 'Statement End Date'),
    opening: vfcBankColOpt_(headers, 'Opening Balance'),
    closing: vfcBankColOpt_(headers, 'Closing Balance'),
    deposits: vfcBankCol_(headers, 'Total Deposits'),
    withdrawals: vfcBankCol_(headers, 'Total Withdrawals'),
    nsf: vfcBankCol_(headers, 'NSF Count'),
    negative: vfcBankCol_(headers, 'Negative Balance Detected'),
    signal: vfcBankCol_(headers, 'Possible MCA Or Loan Payments'),
    created: vfcBankCol_(headers, 'Created At')
  };

  return values.slice(1).map(function(row, index) {
    return {
      uploadId: row[columns.upload],
      companyName: row[columns.company],
      detectedPeriod: row[columns.period],
      fileName: String(row[columns.file] || 'statement.pdf'),
      bank: columns.bank >= 0 ? row[columns.bank] : '',
      start: row[columns.start],
      end: row[columns.end],
      opening: columns.opening >= 0 ? row[columns.opening] : '',
      closing: columns.closing >= 0 ? row[columns.closing] : '',
      totalDeposits: row[columns.deposits],
      totalWithdrawals: row[columns.withdrawals],
      nsfCount: row[columns.nsf],
      negativeBalance: row[columns.negative],
      signal: row[columns.signal],
      createdAt: row[columns.created],
      row: index + 2,
      col: columns.signal + 1
    };
  }).filter(function(row) {
    return (!company || vfcBankSame_(row.companyName, company)) &&
      (!period || vfcBankPeriodSame_(row.detectedPeriod, period));
  });
}

function vfcBankUploads_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads');
  if (!sheet) return {};

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};

  const headers = values[0];
  const uploadColumn = vfcBankCol_(headers, 'Upload ID');
  const fileColumn = vfcBankCol_(headers, 'File ID');
  const out = {};

  values.slice(1).forEach(function(row) {
    const id = String(row[uploadColumn] || '').trim();
    if (id) out[id] = { fileId: String(row[fileColumn] || '').trim() };
  });

  return out;
}

function vfcBankBestReuseMap_(rows) {
  const out = {};
  const scores = {};

  (rows || []).forEach(function(row) {
    const current = vfcBankNewPayload_(row.signal, false);
    const legacy = current || vfcBankLegacyPayload_(row.signal, row);
    if (!legacy) return;

    const key = vfcBankKey_(row);
    const score = vfcBankPayloadScore_(legacy);
    if (scores[key] === undefined || score > scores[key]) {
      scores[key] = score;
      out[key] = legacy;
    }
  });

  return out;
}

function vfcBankPayloadScore_(payload) {
  if (!payload) return -1;
  let score = 0;
  if (payload.signalsVerified) score += 1000;
  score += (payload.paymentCandidates || []).length * 50;
  score += (payload.financingCredits || []).length * 20;
  if (!/STORED_SUMMARY/i.test(String(payload.totalsSource || ''))) score += 10;
  if (/PDF|OCR|OPENAI|AI|TD_PAGE/i.test(String(payload.signalSource || ''))) score += 10;
  return score;
}

function vfcBankNewPayload_(value, requireSignals) {
  const text = String(value || '').trim();
  if (text.indexOf(VFC_BANK.PREFIX) !== 0) return null;

  try {
    const payload = JSON.parse(text.substring(VFC_BANK.PREFIX.length));
    return vfcBankPayloadValid_(payload, requireSignals) ? payload : null;
  } catch (error) {
    return null;
  }
}

function vfcBankPayloadAt_(rowNumber, columnNumber, requireSignals) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return null;
  return vfcBankNewPayload_(sheet.getRange(rowNumber, columnNumber).getValue(), requireSignals);
}

function vfcBankPayloadValid_(payload, requireSignals) {
  if (!payload || !payload.verified) return false;

  const opening = vfcBankNull_(payload.openingBalance);
  const closing = vfcBankNull_(payload.closingBalance);
  const deposits = vfcBankNullPos_(payload.totalDeposits);
  const withdrawals = vfcBankNullPos_(payload.totalWithdrawals);
  if (opening === null || closing === null || deposits === null || withdrawals === null) return false;

  const diff = Math.abs((opening + deposits - withdrawals) - closing);
  if (diff > VFC_BANK.RECONCILE_TOLERANCE) return false;
  if (requireSignals && !payload.signalsVerified) return false;
  return true;
}

function vfcBankWrite_(sheet, row, payload) {
  sheet.getRange(row.row, row.col).setValue(VFC_BANK.PREFIX + JSON.stringify(payload));
}

function vfcBankKey_(row) {
  return [
    String(row.companyName || '').trim().toLowerCase(),
    vfcBankIso_(row.start),
    vfcBankIso_(row.end)
  ].join('|');
}

function vfcBankBest_(items) {
  const counts = {};
  (items || []).forEach(function(item) {
    const text = String(item.counterparty || item.description || '').trim();
    if (text) counts[text] = (counts[text] || 0) + 1;
  });

  const keys = Object.keys(counts).sort(function(a, b) {
    return counts[b] !== counts[a] ? counts[b] - counts[a] : a.length - b.length;
  });
  return keys.length ? keys[0] : 'Recurring Payment';
}

function vfcBankGroupConf_(items) {
  if (!items || !items.length) return 'Low';
  const score = items.reduce(function(total, item) {
    return total + (item.confidence === 'High' ? 2 : item.confidence === 'Moderate' ? 1 : 0);
  }, 0) / items.length;
  return score >= 1.5 ? 'High' : score >= .75 ? 'Moderate' : 'Low';
}

function vfcBankOutput_(body) {
  if (body && typeof body.output_text === 'string' && body.output_text) return body.output_text;
  const output = body && Array.isArray(body.output) ? body.output : [];
  for (let i = 0; i < output.length; i++) {
    const content = Array.isArray(output[i].content) ? output[i].content : [];
    for (let j = 0; j < content.length; j++) {
      if (content[j] && typeof content[j].text === 'string' && content[j].text) return content[j].text;
    }
  }
  return '';
}

function vfcBankReq_(value, requestedPeriod) {
  let company = '';
  let period = requestedPeriod || '';
  if (value && typeof value === 'object') {
    company = value.companyName || value.company || '';
    period = value.period || value.detectedPeriod || period;
  } else {
    company = value || '';
  }
  company = String(company || '').trim();
  period = String(period || '').trim();
  if (!company) throw new Error('Company name is required.');
  return { companyName: company, period: period };
}

function vfcBankCol_(headers, wanted) {
  const index = vfcBankColOpt_(headers, wanted);
  if (index < 0) throw new Error('Missing required column: ' + wanted);
  return index;
}

function vfcBankColOpt_(headers, wanted) {
  const target = String(wanted || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').toLowerCase().replace(/[^a-z0-9]/g, '') === target) return i;
  }
  return -1;
}

function vfcBankDate_(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

function vfcBankIso_(value) {
  const date = vfcBankDate_(value);
  return date ? Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd') : '';
}

function vfcBankNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  let number = vfcBankNum_(text);
  if (/OD$/i.test(text)) number = -Math.abs(number);
  return isFinite(number) ? number : null;
}

function vfcBankNullPos_(value) {
  const number = vfcBankNull_(value);
  return number !== null && number >= 0 ? number : null;
}

function vfcBankNum_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const number = parseFloat(String(value || '').replace(/[^0-9.\-]/g, ''));
  return isFinite(number) ? number : 0;
}

function vfcBankPos_(value) {
  return Math.max(0, vfcBankNum_(value));
}

function vfcBankArr_(value) {
  return Array.isArray(value)
    ? value.map(vfcBankPos_).filter(function(number) { return isFinite(number) && number >= 0; })
    : [];
}

function vfcBankRound_(value, step) {
  const increment = vfcBankNum_(step) || 1;
  return Math.round(vfcBankNum_(value) / increment) * increment;
}

function vfcBankSum_(items) {
  return (items || []).reduce(function(sum, item) { return sum + vfcBankNum_(item); }, 0);
}

function vfcBankMedian_(items) {
  const numbers = (items || [])
    .map(vfcBankNum_)
    .filter(function(number) { return isFinite(number) && number >= 0; })
    .sort(function(a, b) { return a - b; });

  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function vfcBankCv_(items) {
  const numbers = (items || []).map(vfcBankNum_).filter(function(number) { return number >= 0; });
  if (!numbers.length) return 1;
  const average = vfcBankSum_(numbers) / numbers.length;
  if (!average) return 1;
  return Math.sqrt(
    numbers.reduce(function(sum, number) {
      return sum + Math.pow(number - average, 2);
    }, 0) / numbers.length
  ) / average;
}

function vfcBankTrend_(items) {
  const numbers = (items || []).map(vfcBankNum_);
  if (numbers.length < 2) return 0;
  const split = Math.max(1, Math.floor(numbers.length / 2));
  const first = numbers.slice(0, split);
  const second = numbers.slice(split);
  const firstAverage = vfcBankSum_(first) / first.length;
  const secondAverage = second.length ? vfcBankSum_(second) / second.length : firstAverage;
  return firstAverage > 0 ? (secondAverage - firstAverage) / firstAverage : 0;
}

function vfcBankConf_(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'high' ? 'High' : text === 'low' ? 'Low' : 'Moderate';
}

function vfcBankFlag_(value) {
  return /^(1|true|yes|detected)$/i.test(String(value || '').trim());
}

function vfcBankSame_(left, right) {
  return String(left == null ? '' : left).trim().toLowerCase() ===
    String(right == null ? '' : right).trim().toLowerCase();
}

function vfcBankPeriodSame_(left, right) {
  const clean = function(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  };
  return clean(left) === clean(right);
}

function vfcBankTime_(value) {
  const date = vfcBankDate_(value);
  return date ? date.getTime() : 0;
}
