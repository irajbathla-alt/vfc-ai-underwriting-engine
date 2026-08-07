const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-4.0-REPEATED-PAD',
  SIGNAL_PREFIX: 'VFC_BANKING_V6:',
  PAYLOAD_VERSION: 6,
  ACTIVE_LOOKBACK_DAYS: 60,
  LATEST_BATCH_GAP_MINUTES: 10,
  AMOUNT_TOLERANCE_PERCENT: 0.02,
  AMOUNT_TOLERANCE_DOLLARS: 2
};

/**
 * FINAL SIMPLE BANKING INPUT LAYER
 *
 * Purpose:
 * - Use the latest uploaded statement batch only.
 * - Read each current PDF once when a V6 result is not cached.
 * - Ask OpenAI for exact statement-header totals and individual financing/PAD debit candidates.
 * - Confirm debt only from repeated payment patterns across dates.
 * - Never require or hard-code any lender name.
 * - Keep tax/government and insurance-finance PADs separate.
 * - Detect obvious financing credits separately from operating deposits.
 * - Create no new Sheets and add no new debt-service multiplier to Our Max.
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

function getBankingInputQualityStatus() {
  const result = {
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    method: 'OpenAI candidate extraction + local repeated-payment detection',
    lenderAgnostic: true,
    confirmsRepeatedPadsOnly: true,
    excludesTaxPadsFromDebt: true,
    separatesInsuranceFinance: true,
    regexTransactionParsing: false,
    usesLatestUploadBatchOnly: true,
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
    : (typeof buildFeaturesForCase_ === 'function'
      ? buildFeaturesForCase_(companyName, period)
      : null);

  if (!base) return null;

  const audit = vfcBiqBuildAudit_(companyName, period, base);
  if (!audit.rows.length) return base;

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
    oldAverage > 0 &&
    grossMonthlyDeposits > 0 &&
    Math.abs(oldAverage - grossMonthlyDeposits) / grossMonthlyDeposits >= 0.05
  ) {
    warnings.push(
      'Average monthly deposits corrected from ' +
      vfcBiqRound_(oldAverage, 1) +
      ' to ' +
      vfcBiqRound_(grossMonthlyDeposits, 1) +
      ' using the latest statement-header totals.'
    );
  }

  if (debtProfile.financingCreditsTotal > 0) {
    warnings.push(
      'Financing credits were detected and shown separately from estimated operating deposits.'
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
    nsfPerMonth: vfcBiqRound_(
      audit.nsfCount / Math.max(1, audit.monthsCovered),
      0.01
    ),
    negativeBalanceFlag: audit.negativeBalanceFlag,
    mcaPaymentFlag: debtProfile.activeDebtObligations.length ? 1 : 0,
    monthlyDeposits: audit.monthlyDeposits,
    monthlyWithdrawals: audit.monthlyWithdrawals,
    depositVolatility: vfcBiqRound_(
      vfcBiqCoefficientOfVariation_(audit.monthlyDeposits),
      0.01
    ),
    depositTrend: vfcBiqRound_(vfcBiqTrend_(audit.monthlyDeposits), 0.01),
    estimatedOperatingTotalDeposits: vfcBiqRound_(operatingTotalDeposits, 0.01),
    estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
    detectedFinancingCredits: vfcBiqRound_(
      debtProfile.financingCreditsTotal,
      0.01
    ),
    existingMonthlyDebtService: vfcBiqRound_(
      debtProfile.confirmedMonthlyDebtService,
      0.01
    ),
    otherRecurringMonthlyObligations: vfcBiqRound_(
      debtProfile.otherRecurringMonthlyObligations,
      0.01
    ),
    debtServiceToDepositsRatio: grossMonthlyDeposits > 0
      ? vfcBiqRound_(
        debtProfile.confirmedMonthlyDebtService / grossMonthlyDeposits,
        0.0001
      )
      : 0,
    debtProfile: debtProfile,
    inputQualityAudit: {
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      allMatchingRows: audit.allMatchingRows,
      latestBatchRows: audit.latestBatchRows,
      olderRowsIgnored: audit.olderRowsIgnored,
      validatedMonthsCovered: audit.monthsCovered,
      grossAverageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
      estimatedOperatingMonthlyDeposits: vfcBiqRound_(
        operatingMonthlyDeposits,
        0.01
      ),
      warnings: warnings
    }
  });
}

function vfcBiqRefresh_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = ss.getSheetByName('PDF Summaries');
  if (!summarySheet) throw new Error('Missing PDF Summaries sheet.');

  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  if (!allRows.length) {
    throw new Error('No PDF Summary rows found for this company and period.');
  }

  const rows = vfcBiqLatestBatch_(allRows);
  const uploadMap = vfcBiqUploadMap_();

  let filesAnalyzed = 0;
  let filesSkipped = 0;
  const errors = [];

  rows.forEach(function(row) {
    const cached = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);

    if (
      cached &&
      cached.version >= VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION &&
      cached.headerSummary &&
      vfcBiqPositiveNumber_(cached.headerSummary.totalDeposits) > 0
    ) {
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
      const structured = vfcBiqExtractStatementWithOpenAI_(text, row);

      const payload = {
        version: VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION,
        analyzedAt: new Date().toISOString(),
        fileName: row.fileName,
        headerSummary: structured.headerSummary,
        paymentCandidates: structured.paymentCandidates,
        financingCredits: structured.financingCredits
      };

      summarySheet
        .getRange(row.rowNumber, row.signalColumn)
        .setValue(
          VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(payload)
        );

      filesAnalyzed++;
    } catch (error) {
      errors.push(
        row.fileName + ': ' + String(error && error.message || error)
      );
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
    debtProfile: features && features.debtProfile
      ? features.debtProfile
      : {},
    inputQualityAudit: features && features.inputQualityAudit
      ? features.inputQualityAudit
      : {}
  };
}

function vfcBiqExtractStatementWithOpenAI_(text, fallbackRow) {
  const prompt = [
    'You are the VFC bank-statement payment extractor.',
    'Return JSON only. Do not write prose outside JSON.',
    '',
    'Return exactly these top-level fields:',
    'statement_start_date, statement_end_date, total_deposits, total_withdrawals, payment_candidates, financing_credits.',
    '',
    'payment_candidates must be an array. Each item must contain:',
    'date, description, counterparty, amount, kind, confidence.',
    '',
    'Allowed payment kind values:',
    'LOAN_PAYMENT, MCA_PAYMENT, FINANCING_PAYMENT, PAD, TAX_PAD, INSURANCE_FINANCE, CREDIT_CARD_PAYMENT.',
    '',
    'financing_credits must be an array. Each item must contain:',
    'date, description, counterparty, amount, kind, confidence.',
    '',
    'Allowed financing-credit kind values:',
    'LOAN_ADVANCE, MCA_ADVANCE, OTHER_FINANCING_CREDIT.',
    '',
    'STRICT RULES:',
    '1. Use YYYY-MM-DD dates.',
    '2. total_deposits must come from the statement summary/header total, such as Total deposits & credits. Do not calculate it from transaction rows.',
    '3. total_withdrawals must come from the statement summary/header total, such as Total cheques & debits. Do not calculate it from transaction rows.',
    '4. Extract EACH individual debit that is clearly a loan repayment, MCA/cash-advance repayment, financing repayment, lease/LOC financing payment, or a transaction whose own description explicitly contains PAD/pre-authorized debit.',
    '5. Do not decide whether a payment is recurring. Extract each visible occurrence separately. Local code will determine recurrence across statements.',
    '6. The amount must be the exact debit amount belonging to that same transaction. Never borrow an amount from a nearby transaction.',
    '7. Use PAD when the transaction itself says PAD or pre-authorized debit and the payee is not clearly tax/government or insurance finance.',
    '8. Use TAX_PAD for CRA, CCRA, Revenue Agency, government tax, source-deduction, GST/HST or similar tax PADs.',
    '9. Use INSURANCE_FINANCE for IPFS, premium finance, insurance financing or clearly insurance-finance debits.',
    '10. Use LOAN_PAYMENT for a clearly labelled loan payment.',
    '11. Use MCA_PAYMENT for a clearly labelled merchant cash advance/cash advance repayment.',
    '12. Use FINANCING_PAYMENT for another clearly identifiable financing repayment that is not better classified above.',
    '13. Normal purchases, suppliers, payroll, card purchases, Interac purchases, ATM transactions, ordinary e-transfers and ordinary operating expenses are NOT financing payment candidates unless the transaction itself clearly says PAD/pre-authorized debit or financing/loan repayment.',
    '14. A single PAD is still a candidate. Do not call it recurring. Local code will require repetition before counting it as confirmed debt.',
    '15. Do not infer an outstanding balance or payoff balance.',
    '16. Omit uncertain transactions instead of guessing.',
    '17. confidence must be High, Moderate, or Low.',
    '18. Do not rely on any specific lender name. Apply these rules to any lender/funder/payee.',
    '',
    'FINANCING CREDIT RULES:',
    '19. Extract an incoming credit only when the transaction itself clearly shows loan proceeds, financing proceeds, funding advance, cash advance, lender disbursement or another financing advance.',
    '20. Do not treat normal sales deposits, e-transfers, owner/shareholder transfers or customer receipts as financing credits unless financing is explicit.',
    '',
    'Fallback statement information, only if the OCR text does not clearly show a header value:',
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

  return {
    headerSummary: {
      statementStartDate: vfcBiqIsoDate_(
        raw.statement_start_date || fallbackRow.statementStartDate
      ),
      statementEndDate: vfcBiqIsoDate_(
        raw.statement_end_date || fallbackRow.statementEndDate
      ),
      totalDeposits: vfcBiqRound_(
        vfcBiqPositiveNumber_(raw.total_deposits) ||
        vfcBiqPositiveNumber_(fallbackRow.totalDeposits),
        0.01
      ),
      totalWithdrawals: vfcBiqRound_(
        vfcBiqPositiveNumber_(raw.total_withdrawals) ||
        vfcBiqPositiveNumber_(fallbackRow.totalWithdrawals),
        0.01
      ),
      verifiedFromStructuredRead:
        vfcBiqPositiveNumber_(raw.total_deposits) > 0
    },
    paymentCandidates: vfcBiqNormalizePaymentCandidates_(
      raw.payment_candidates
    ),
    financingCredits: vfcBiqNormalizeFinancingCredits_(
      raw.financing_credits
    )
  };
}

function vfcBiqNormalizePaymentCandidates_(items) {
  if (!Array.isArray(items)) return [];

  const allowedKinds = {
    LOAN_PAYMENT: 1,
    MCA_PAYMENT: 1,
    FINANCING_PAYMENT: 1,
    PAD: 1,
    TAX_PAD: 1,
    INSURANCE_FINANCE: 1,
    CREDIT_CARD_PAYMENT: 1
  };

  const normalized = items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_');

    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!allowedKinds[kind] || !(amount > 0)) return null;

    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '')
        .trim()
        .substring(0, 180),
      counterparty: String(
        item.counterparty || item.description || ''
      ).trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      kind: kind,
      category: vfcBiqCategoryFromCandidate_(kind, item),
      confidence: vfcBiqConfidence_(item.confidence)
    };
  }).filter(Boolean);

  return vfcBiqDedupeSignals_(normalized);
}

function vfcBiqNormalizeFinancingCredits_(items) {
  if (!Array.isArray(items)) return [];

  const allowedKinds = {
    LOAN_ADVANCE: 1,
    MCA_ADVANCE: 1,
    OTHER_FINANCING_CREDIT: 1
  };

  const normalized = items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_');

    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!allowedKinds[kind] || !(amount > 0)) return null;

    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '')
        .trim()
        .substring(0, 180),
      counterparty: String(
        item.counterparty || item.description || ''
      ).trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      kind: kind,
      category: kind,
      confidence: vfcBiqConfidence_(item.confidence)
    };
  }).filter(Boolean);

  return vfcBiqDedupeSignals_(normalized);
}

function vfcBiqCategoryFromCandidate_(kind, item) {
  const text = [
    item && item.description,
    item && item.counterparty
  ].join(' ').toLowerCase();

  if (
    kind === 'TAX_PAD' ||
    /\b(cra|ccra|revenue agency|gst|hst|source deduction|tax)\b/i.test(text)
  ) {
    return 'TAX_GOVERNMENT';
  }

  if (
    kind === 'INSURANCE_FINANCE' ||
    /\b(ipfs|premium finance|insurance finance|insurance financing)\b/i.test(text)
  ) {
    return 'INSURANCE_FINANCE';
  }

  if (kind === 'CREDIT_CARD_PAYMENT') return 'CREDIT_CARD';

  if (kind === 'LOAN_PAYMENT') {
    if (/commercial\s+loan/i.test(text)) return 'COMMERCIAL_LOAN';
    if (/\bline\s+of\s+credit\b|\bloc\b/i.test(text)) return 'LOC';
    if (/\blease\b/i.test(text)) return 'LEASE_FINANCE';
    return 'TERM_LOAN';
  }

  if (kind === 'MCA_PAYMENT') return 'MCA';

  if (kind === 'FINANCING_PAYMENT') {
    if (/commercial\s+loan/i.test(text)) return 'COMMERCIAL_LOAN';
    if (/\bline\s+of\s+credit\b|\bloc\b/i.test(text)) return 'LOC';
    if (/\blease\b/i.test(text)) return 'LEASE_FINANCE';
    return 'OTHER_FINANCING_PAYMENT';
  }

  if (kind === 'PAD') return 'RECURRING_PAD';

  return 'OTHER_FINANCING_PAYMENT';
}

function vfcBiqBuildDebtProfile_(rows, monthsCovered, latestStatementDate) {
  let payments = [];
  let credits = [];

  (rows || []).forEach(function(row) {
    const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    if (!payload) return;

    payments = payments.concat(payload.paymentCandidates || []);
    credits = credits.concat(payload.financingCredits || []);
  });

  payments = vfcBiqDedupeSignals_(payments);
  credits = vfcBiqDedupeSignals_(credits);

  const groups = vfcBiqGroupPayments_(payments);
  const obligations = groups.map(function(group) {
    return vfcBiqSummarizeGroup_(
      group,
      monthsCovered,
      latestStatementDate
    );
  }).filter(Boolean);

  obligations.sort(function(a, b) {
    return b.monthlyEquivalent - a.monthlyEquivalent;
  });

  const confirmedDebtCategories = {
    TERM_LOAN: 1,
    COMMERCIAL_LOAN: 1,
    LOC: 1,
    LEASE_FINANCE: 1,
    MCA: 1,
    OTHER_FINANCING_PAYMENT: 1,
    RECURRING_PAD: 1
  };

  const otherCategories = {
    INSURANCE_FINANCE: 1,
    CREDIT_CARD: 1
  };

  const activeDebt = obligations.filter(function(item) {
    return (
      item.active &&
      item.recurring &&
      confirmedDebtCategories[item.category] &&
      item.confidence !== 'Low'
    );
  });

  const otherRecurring = obligations.filter(function(item) {
    return (
      item.active &&
      item.recurring &&
      otherCategories[item.category] &&
      item.confidence !== 'Low'
    );
  });

  const taxGovernmentPads = obligations.filter(function(item) {
    return (
      item.active &&
      item.recurring &&
      item.category === 'TAX_GOVERNMENT'
    );
  });

  const observedOnce = obligations.filter(function(item) {
    return !item.recurring;
  });

  const validCredits = credits.filter(function(item) {
    return item.confidence !== 'Low';
  });

  return {
    confirmedMonthlyDebtService: vfcBiqRound_(
      activeDebt.reduce(function(sum, item) {
        return sum + item.monthlyEquivalent;
      }, 0),
      0.01
    ),
    otherRecurringMonthlyObligations: vfcBiqRound_(
      otherRecurring.reduce(function(sum, item) {
        return sum + item.monthlyEquivalent;
      }, 0),
      0.01
    ),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxGovernmentPads,
    observedOnce: observedOnce,
    allDetectedObligations: obligations,
    financingCredits: validCredits,
    financingCreditsTotal: vfcBiqRound_(
      validCredits.reduce(function(sum, item) {
        return sum + vfcBiqPositiveNumber_(item.amount);
      }, 0),
      0.01
    ),
    note:
      'Debt is confirmed only when the same or similar financing/PAD payment repeats on multiple dates. Tax/government and insurance-finance PADs are kept separate. No lender name is required.'
  };
}

function vfcBiqGroupPayments_(payments) {
  const groups = [];

  (payments || [])
    .slice()
    .sort(function(a, b) {
      const ad = vfcBiqDate_(a.date) || new Date(0);
      const bd = vfcBiqDate_(b.date) || new Date(0);
      return ad - bd;
    })
    .forEach(function(payment) {
      const normalized = Object.assign({}, payment, {
        label: vfcBiqCanonicalLabel_(payment),
        amount: vfcBiqPositiveNumber_(payment.amount)
      });

      let target = null;

      for (let i = 0; i < groups.length; i++) {
        if (vfcBiqSamePaymentPattern_(groups[i], normalized)) {
          target = groups[i];
          break;
        }
      }

      if (!target) {
        target = {
          category: normalized.category,
          label: normalized.label,
          referenceAmount: normalized.amount,
          items: []
        };
        groups.push(target);
      }

      target.items.push(normalized);
      target.referenceAmount = vfcBiqMedian_(
        target.items.map(function(item) {
          return item.amount;
        })
      );

      if (
        target.label === 'generic' &&
        normalized.label &&
        normalized.label !== 'generic'
      ) {
        target.label = normalized.label;
      }
    });

  return groups;
}

function vfcBiqSamePaymentPattern_(group, payment) {
  if (!group || !payment) return false;

  if (!vfcBiqCategoryFamilyMatches_(group.category, payment.category)) {
    return false;
  }

  if (!vfcBiqAmountsSimilar_(group.referenceAmount, payment.amount)) {
    return false;
  }

  if (
    group.category === 'TERM_LOAN' ||
    group.category === 'COMMERCIAL_LOAN' ||
    group.category === 'LOC' ||
    group.category === 'LEASE_FINANCE' ||
    group.category === 'MCA'
  ) {
    return true;
  }

  return vfcBiqLabelsMatch_(group.label, payment.label);
}

function vfcBiqCategoryFamilyMatches_(a, b) {
  if (a === b) return true;

  const financing = {
    TERM_LOAN: 1,
    COMMERCIAL_LOAN: 1,
    LOC: 1,
    LEASE_FINANCE: 1,
    MCA: 1,
    OTHER_FINANCING_PAYMENT: 1
  };

  return !!(financing[a] && financing[b]);
}

function vfcBiqAmountsSimilar_(a, b) {
  a = vfcBiqPositiveNumber_(a);
  b = vfcBiqPositiveNumber_(b);
  if (!(a > 0) || !(b > 0)) return false;

  const tolerance = Math.max(
    VFC_BANKING_INPUT_CONFIG.AMOUNT_TOLERANCE_DOLLARS,
    Math.max(a, b) * VFC_BANKING_INPUT_CONFIG.AMOUNT_TOLERANCE_PERCENT
  );

  return Math.abs(a - b) <= tolerance;
}

function vfcBiqCanonicalLabel_(payment) {
  const text = [
    payment && payment.counterparty,
    payment && payment.description
  ].join(' ').toLowerCase();

  const loanId = text.match(
    /\b(?:loan|facility|account)\s*(?:payment|no|number|#)?\s*[:#.-]?\s*([a-z0-9-]{5,})\b/i
  );

  if (loanId && loanId[1]) {
    return 'loan-' + loanId[1].replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  const cleaned = text
    .replace(/\b(?:payment|payments|pmt|business|pad|preauthorized|pre-authorized|debit|withdrawal|eft|electronic|funds|transfer|misc|investment)\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 3) return 'generic';

  return cleaned
    .split(' ')
    .filter(function(token) {
      return token.length > 1;
    })
    .slice(0, 8)
    .join(' ') || 'generic';
}

function vfcBiqLabelsMatch_(a, b) {
  a = String(a || 'generic');
  b = String(b || 'generic');

  if (a === b) return true;
  if (a === 'generic' || b === 'generic') return true;

  const aTokens = {};
  const bTokens = {};

  a.split(/\s+/).forEach(function(token) {
    if (token) aTokens[token] = true;
  });
  b.split(/\s+/).forEach(function(token) {
    if (token) bTokens[token] = true;
  });

  const union = {};
  Object.keys(aTokens).forEach(function(token) { union[token] = true; });
  Object.keys(bTokens).forEach(function(token) { union[token] = true; });

  const all = Object.keys(union);
  if (!all.length) return true;

  let intersection = 0;
  all.forEach(function(token) {
    if (aTokens[token] && bTokens[token]) intersection++;
  });

  return intersection / all.length >= 0.5;
}

function vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate) {
  if (!group || !group.items || !group.items.length) return null;

  const byDate = {};
  group.items.forEach(function(item) {
    const date = vfcBiqIsoDate_(item.date);
    if (!date) return;

    const key = date + '|' + vfcBiqRound_(item.amount, 0.01);
    if (!byDate[key]) byDate[key] = item;
  });

  const items = Object.keys(byDate).map(function(key) {
    return byDate[key];
  });

  items.sort(function(a, b) {
    return (vfcBiqDate_(a.date) || new Date(0)) -
      (vfcBiqDate_(b.date) || new Date(0));
  });

  const dates = items
    .map(function(item) { return vfcBiqDate_(item.date); })
    .filter(Boolean);

  const amounts = items
    .map(function(item) { return vfcBiqPositiveNumber_(item.amount); })
    .filter(function(amount) { return amount > 0; });

  if (!amounts.length) return null;

  const paymentAmount = vfcBiqMedian_(amounts);
  const distinctDates = {};
  dates.forEach(function(date) {
    distinctDates[vfcBiqIsoDate_(date)] = true;
  });

  const occurrences = Object.keys(distinctDates).length;
  const recurring = occurrences >= 2;
  const frequency = recurring
    ? vfcBiqInferFrequency_(dates, occurrences, monthsCovered)
    : 'Observed once';

  const monthlyEquivalent = recurring
    ? vfcBiqMonthlyEquivalent_(
      paymentAmount,
      frequency,
      occurrences,
      monthsCovered
    )
    : 0;

  const lastDate = dates.length ? dates[dates.length - 1] : null;
  const confidence = vfcBiqGroupConfidence_(items);

  return {
    counterparty: vfcBiqBestCounterparty_(items),
    description: items[0] ? items[0].description : '',
    category: group.category,
    paymentAmount: vfcBiqRound_(paymentAmount, 0.01),
    frequency: frequency,
    monthlyEquivalent: vfcBiqRound_(monthlyEquivalent, 0.01),
    occurrences: occurrences,
    firstSeen: dates.length ? vfcBiqIsoDate_(dates[0]) : '',
    lastSeen: lastDate ? vfcBiqIsoDate_(lastDate) : '',
    recurring: recurring,
    active: recurring
      ? vfcBiqIsActive_(lastDate, latestStatementDate, frequency)
      : false,
    confidence: confidence,
    patternLabel: group.label
  };
}

function vfcBiqBestCounterparty_(items) {
  const candidates = (items || [])
    .map(function(item) {
      return String(item.counterparty || '').trim();
    })
    .filter(Boolean)
    .sort(function(a, b) {
      return b.length - a.length;
    });

  return candidates.length ? candidates[0] : 'Recurring Payment';
}

function vfcBiqInferFrequency_(dates, occurrences, monthsCovered) {
  if (dates && dates.length >= 2) {
    const sorted = dates
      .slice()
      .sort(function(a, b) { return a - b; });

    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      const days = Math.abs(
        (sorted[i].getTime() - sorted[i - 1].getTime()) / 86400000
      );
      if (days > 0) intervals.push(days);
    }

    const medianDays = vfcBiqMedian_(intervals);

    if (medianDays > 0 && medianDays <= 3.5) return 'Business daily';
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

  const days = (
    latestStatementDate.getTime() - lastDate.getTime()
  ) / 86400000;

  const allowed = frequency === 'Every 2 months'
    ? 90
    : VFC_BANKING_INPUT_CONFIG.ACTIVE_LOOKBACK_DAYS;

  return days >= -3 && days <= allowed;
}

function vfcBiqGroupConfidence_(items) {
  if (!items || !items.length) return 'Low';

  const score = items.reduce(function(sum, item) {
    return sum + (
      item.confidence === 'High'
        ? 2
        : item.confidence === 'Moderate'
          ? 1
          : 0
    );
  }, 0) / items.length;

  if (score >= 1.5) return 'High';
  if (score >= 0.75) return 'Moderate';
  return 'Low';
}

function vfcBiqBuildAudit_(companyName, period, base) {
  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  const latestRows = vfcBiqLatestBatch_(allRows);
  const byStatement = {};

  latestRows.forEach(function(row) {
    const payload = vfcBiqParsePayload_(
      row.possibleMcaOrLoanPayments
    );
    const header = payload && payload.headerSummary
      ? payload.headerSummary
      : {};

    const start = header.statementStartDate ||
      vfcBiqIsoDate_(row.statementStartDate);
    const end = header.statementEndDate ||
      vfcBiqIsoDate_(row.statementEndDate);

    const key = start && end
      ? start + '|' + end
      : String(row.fileName || '').toLowerCase();

    byStatement[key] = row;
  });

  const rows = Object.keys(byStatement).map(function(key) {
    return byStatement[key];
  });

  rows.sort(function(a, b) {
    return vfcBiqEffectiveDate_(a) - vfcBiqEffectiveDate_(b);
  });

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
    const payload = vfcBiqParsePayload_(
      row.possibleMcaOrLoanPayments
    );
    const header = payload && payload.headerSummary
      ? payload.headerSummary
      : {};

    const start = vfcBiqDate_(
      header.statementStartDate || row.statementStartDate
    );
    const end = vfcBiqDate_(
      header.statementEndDate || row.statementEndDate
    );

    const deposits =
      vfcBiqPositiveNumber_(header.totalDeposits) ||
      vfcBiqPositiveNumber_(row.totalDeposits);

    const withdrawals =
      vfcBiqPositiveNumber_(header.totalWithdrawals) ||
      vfcBiqPositiveNumber_(row.totalWithdrawals);

    if (start) starts.push(start);
    if (end) ends.push(end);

    totalDeposits += deposits;
    totalWithdrawals += withdrawals;
    nsfCount += Math.max(0, vfcBiqNumber_(row.nsfCount));

    if (vfcBiqTruthyFlag_(row.negativeBalanceDetected)) {
      negativeBalanceFlag = 1;
    }

    monthlyDeposits.push(deposits);
    monthlyWithdrawals.push(withdrawals);

    const monthDate = end || start;
    if (monthDate) {
      distinctMonths[
        monthDate.getUTCFullYear() +
        '-' +
        ('0' + (monthDate.getUTCMonth() + 1)).slice(-2)
      ] = true;
    }
  });

  const earliest = starts.length
    ? new Date(
      Math.min.apply(
        null,
        starts.map(function(date) { return date.getTime(); })
      )
    )
    : null;

  const latest = ends.length
    ? new Date(
      Math.max.apply(
        null,
        ends.map(function(date) { return date.getTime(); })
      )
    )
    : null;

  const spanMonths = earliest && latest
    ? Math.max(
      1,
      Math.round(
        (
          ((latest.getTime() - earliest.getTime()) / 86400000) + 1
        ) / 30.4375
      )
    )
    : 0;

  const monthCount = Object.keys(distinctMonths).length;
  const monthsCovered = Math.max(
    1,
    monthCount ||
    spanMonths ||
    rows.length ||
    vfcBiqNumber_(base.monthsCovered) ||
    1
  );

  const olderRowsIgnored = Math.max(
    0,
    allRows.length - latestRows.length
  );

  const warnings = [];
  if (olderRowsIgnored > 0) {
    warnings.push(
      'Using the latest upload batch; ' +
      olderRowsIgnored +
      ' older statement row(s) were ignored.'
    );
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

function vfcBiqReadSummaryRows_(companyName, period) {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName('PDF Summaries');

  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];

  const columns = {
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

  return values
    .slice(1)
    .map(function(row, index) {
      return {
        uploadId: row[columns.upload],
        companyName: row[columns.company],
        detectedPeriod: row[columns.period],
        fileName: String(
          row[columns.file] || 'statement.pdf'
        ),
        statementStartDate: row[columns.start],
        statementEndDate: row[columns.end],
        totalDeposits: row[columns.deposits],
        totalWithdrawals: row[columns.withdrawals],
        nsfCount: row[columns.nsf],
        negativeBalanceDetected: row[columns.negative],
        possibleMcaOrLoanPayments: row[columns.signal],
        createdAt: row[columns.created],
        rowNumber: index + 2,
        signalColumn: columns.signal + 1
      };
    })
    .filter(function(row) {
      return (
        (!companyName || sameText_(row.companyName, companyName)) &&
        (!period || sameText_(row.detectedPeriod, period))
      );
    });
}

function vfcBiqUploadMap_() {
  const sheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName('Uploads');

  if (!sheet) return {};

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return {};

  const headers = values[0];
  const uploadColumn = vfcBiqColumn_(headers, 'Upload ID');
  const fileColumn = vfcBiqColumn_(headers, 'File ID');
  const nameColumn = vfcBiqColumn_(headers, 'File Name');

  const map = {};

  values.slice(1).forEach(function(row) {
    const uploadId = String(
      row[uploadColumn] || ''
    ).trim();

    if (!uploadId) return;

    map[uploadId] = {
      fileId: String(row[fileColumn] || '').trim(),
      fileName: String(row[nameColumn] || '')
    };
  });

  return map;
}

function vfcBiqLatestBatch_(rows) {
  const out = [];
  const seenFileNames = {};
  let lastTime = null;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const fileName = String(
      row.fileName || ''
    ).trim().toLowerCase();

    const created = vfcBiqDate_(row.createdAt);

    if (out.length) {
      if (fileName && seenFileNames[fileName]) break;

      if (created && lastTime !== null) {
        const gapMinutes = Math.abs(
          lastTime - created.getTime()
        ) / 60000;

        if (
          gapMinutes >
          VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES
        ) {
          break;
        }
      }
    }

    out.push(row);

    if (fileName) seenFileNames[fileName] = true;
    if (created) lastTime = created.getTime();
  }

  return out.reverse();
}

function vfcBiqParsePayload_(value) {
  const text = String(value || '').trim();

  if (
    text.indexOf(
      VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX
    ) !== 0
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      text.substring(
        VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX.length
      )
    );

    return {
      version: vfcBiqNumber_(parsed.version),
      headerSummary: parsed.headerSummary || {},
      paymentCandidates: Array.isArray(parsed.paymentCandidates)
        ? parsed.paymentCandidates
        : [],
      financingCredits: Array.isArray(parsed.financingCredits)
        ? parsed.financingCredits
        : []
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
      vfcBiqRound_(
        vfcBiqPositiveNumber_(item.amount),
        0.01
      ),
      String(item.category || item.kind || ''),
      vfcBiqCanonicalLabel_(item)
    ].join('|').toLowerCase();

    if (seen[key]) return false;

    seen[key] = true;
    return true;
  });
}

function vfcBiqColumn_(headers, wanted) {
  const target = String(wanted || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  for (let i = 0; i < headers.length; i++) {
    const normalized = String(headers[i] || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    if (normalized === target) return i;
  }

  throw new Error(
    'Missing required column: ' + wanted
  );
}

function vfcBiqEffectiveDate_(row) {
  const payload = vfcBiqParsePayload_(
    row.possibleMcaOrLoanPayments
  );

  const header = payload && payload.headerSummary
    ? payload.headerSummary
    : {};

  return (
    vfcBiqDate_(
      header.statementEndDate ||
      row.statementEndDate ||
      header.statementStartDate ||
      row.statementStartDate
    ) ||
    new Date(0)
  );
}

function vfcBiqNormalizeRequest_(companyOrRequest, requestedPeriod) {
  let companyName = '';
  let period = requestedPeriod || '';

  if (
    companyOrRequest &&
    typeof companyOrRequest === 'object'
  ) {
    companyName =
      companyOrRequest.companyName ||
      companyOrRequest.company ||
      '';

    period =
      companyOrRequest.period ||
      companyOrRequest.detectedPeriod ||
      period;
  } else {
    companyName = companyOrRequest || '';
  }

  companyName = String(companyName || '').trim();
  period = String(period || '').trim();

  if (!companyName) {
    throw new Error('Company name is required.');
  }

  return {
    companyName: companyName,
    period: period
  };
}

function vfcBiqConfidence_(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase();

  if (text === 'high') return 'High';
  if (text === 'low') return 'Low';
  return 'Moderate';
}

function vfcBiqDate_(value) {
  if (!value) return null;

  const date = value instanceof Date
    ? value
    : new Date(value);

  return isNaN(date.getTime())
    ? null
    : date;
}

function vfcBiqIsoDate_(value) {
  const date = vfcBiqDate_(value);

  return date
    ? Utilities.formatDate(
      date,
      'UTC',
      'yyyy-MM-dd'
    )
    : '';
}

function vfcBiqNumber_(value) {
  if (typeof value === 'number') {
    return isFinite(value)
      ? value
      : 0;
  }

  const number = parseFloat(
    String(value || '')
      .replace(/[^0-9.\-]/g, '')
  );

  return isFinite(number)
    ? number
    : 0;
}

function vfcBiqPositiveNumber_(value) {
  return Math.max(
    0,
    vfcBiqNumber_(value)
  );
}

function vfcBiqTruthyFlag_(value) {
  return /^(1|true|yes|detected)$/i.test(
    String(value || '').trim()
  )
    ? 1
    : 0;
}

function vfcBiqRound_(value, step) {
  const number = vfcBiqNumber_(value);
  const increment =
    vfcBiqNumber_(step) || 1;

  return Math.round(
    number / increment
  ) * increment;
}

function vfcBiqMedian_(values) {
  const numbers = (values || [])
    .map(vfcBiqNumber_)
    .filter(function(value) {
      return value > 0;
    })
    .sort(function(a, b) {
      return a - b;
    });

  if (!numbers.length) return 0;

  const middle = Math.floor(
    numbers.length / 2
  );

  return numbers.length % 2
    ? numbers[middle]
    : (
      numbers[middle - 1] +
      numbers[middle]
    ) / 2;
}

function vfcBiqCoefficientOfVariation_(values) {
  const numbers = (values || [])
    .map(vfcBiqNumber_)
    .filter(function(value) {
      return value >= 0;
    });

  if (!numbers.length) return 1;

  const average = numbers.reduce(
    function(sum, value) {
      return sum + value;
    },
    0
  ) / numbers.length;

  if (!average) return 1;

  const variance = numbers.reduce(
    function(sum, value) {
      return sum + Math.pow(
        value - average,
        2
      );
    },
    0
  ) / numbers.length;

  return Math.sqrt(variance) / average;
}

function vfcBiqTrend_(values) {
  const numbers = (values || [])
    .map(vfcBiqNumber_);

  if (numbers.length < 2) return 0;

  const split = Math.max(
    1,
    Math.floor(numbers.length / 2)
  );

  const first = numbers.slice(0, split);
  const second = numbers.slice(split);

  const firstAverage = first.reduce(
    function(sum, value) {
      return sum + value;
    },
    0
  ) / first.length;

  const secondAverage = second.length
    ? second.reduce(
      function(sum, value) {
        return sum + value;
      },
      0
    ) / second.length
    : firstAverage;

  return firstAverage > 0
    ? (
      secondAverage - firstAverage
    ) / firstAverage
    : 0;
}
