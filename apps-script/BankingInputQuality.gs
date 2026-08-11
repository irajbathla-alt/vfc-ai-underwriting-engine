const VFC_BANKING_INPUT_CONFIG = {
  MODEL_VERSION: 'VFC-BANKING-INPUT-QUALITY-5.0-STABLE-REUSE',
  SIGNAL_PREFIX: 'VFC_BANKING_V7:',
  LEGACY_PREFIXES: ['VFC_BANKING_V7:', 'VFC_BANKING_V6:'],
  PAYLOAD_VERSION: 7,
  ACTIVE_LOOKBACK_DAYS: 60,
  LATEST_BATCH_GAP_MINUTES: 10,
  AMOUNT_TOLERANCE_PERCENT: 0.02,
  AMOUNT_TOLERANCE_DOLLARS: 2
};

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

function getBankingInputQualityStatus() {
  const result = {
    modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
    lenderAgnostic: true,
    repeatedPaymentsOnly: true,
    reusesBestPriorExtractionForSameStatement: true,
    taxAndInsuranceDisplayOnly: true,
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
  const operatingTotalDeposits = Math.max(0, audit.totalDeposits - debtProfile.financingCreditsTotal);
  const operatingMonthlyDeposits = operatingTotalDeposits / Math.max(1, audit.monthsCovered);
  const warnings = audit.warnings.slice();
  const oldAverage = vfcBiqNumber_(base.averageMonthlyDeposits);

  if (oldAverage > 0 && grossMonthlyDeposits > 0 &&
      Math.abs(oldAverage - grossMonthlyDeposits) / grossMonthlyDeposits >= 0.05) {
    warnings.push(
      'Average monthly deposits corrected from ' +
      vfcBiqRound_(oldAverage, 1) + ' to ' +
      vfcBiqRound_(grossMonthlyDeposits, 1) +
      ' using statement-header totals.'
    );
  }

  if (debtProfile.financingCreditsTotal > 0) {
    warnings.push('High-confidence financing credits were detected and shown separately from estimated operating deposits.');
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
    otherRecurringMonthlyObligations: vfcBiqRound_(debtProfile.otherRecurringMonthlyObligations, 0.01),
    debtServiceToDepositsRatio: grossMonthlyDeposits > 0
      ? vfcBiqRound_(debtProfile.confirmedMonthlyDebtService / grossMonthlyDeposits, 0.0001)
      : 0,
    debtProfile: debtProfile,
    inputQualityAudit: {
      modelVersion: VFC_BANKING_INPUT_CONFIG.MODEL_VERSION,
      allMatchingRows: audit.allMatchingRows,
      latestBatchRows: audit.latestBatchRows,
      olderRowsIgnored: audit.olderRowsIgnored,
      validatedMonthsCovered: audit.monthsCovered,
      grossAverageMonthlyDeposits: vfcBiqRound_(grossMonthlyDeposits, 0.01),
      estimatedOperatingMonthlyDeposits: vfcBiqRound_(operatingMonthlyDeposits, 0.01),
      warnings: warnings
    }
  });
}

function vfcBiqRefresh_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const summarySheet = ss.getSheetByName('PDF Summaries');
  if (!summarySheet) throw new Error('Missing PDF Summaries sheet.');

  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  if (!allRows.length) throw new Error('No PDF Summary rows found for this company and period.');

  const rows = vfcBiqLatestBatch_(allRows);
  const uploadMap = vfcBiqUploadMap_();
  let filesAnalyzed = 0;
  let filesReused = 0;
  let filesSkipped = 0;
  const errors = [];

  rows.forEach(function(row) {
    const current = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    const reusable = vfcBiqBestReusablePayload_(row, allRows);
    const currentScore = vfcBiqPayloadScore_(current);
    const reusableScore = vfcBiqPayloadScore_(reusable);

    if (reusable && reusableScore > currentScore) {
      vfcBiqWritePayload_(summarySheet, row, reusable);
      filesReused++;
      return;
    }

    if (current && currentScore > 0) {
      filesSkipped++;
      return;
    }

    if (reusable && reusableScore > 0) {
      vfcBiqWritePayload_(summarySheet, row, reusable);
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
      const structured = vfcBiqExtractStatementWithOpenAI_(text, row);
      const payload = {
        version: VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION,
        analyzedAt: new Date().toISOString(),
        fileName: row.fileName,
        headerSummary: structured.headerSummary,
        paymentCandidates: structured.paymentCandidates,
        financingCredits: structured.financingCredits
      };
      vfcBiqWritePayload_(summarySheet, row, payload);
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
    filesReused: filesReused,
    filesSkipped: filesSkipped,
    errors: errors,
    debtProfile: features && features.debtProfile ? features.debtProfile : {},
    inputQualityAudit: features && features.inputQualityAudit ? features.inputQualityAudit : {}
  };
}

function vfcBiqBestReusablePayload_(targetRow, allRows) {
  const identity = vfcBiqStatementIdentity_(targetRow);
  if (!identity) return null;
  let best = null;
  let bestScore = 0;
  (allRows || []).forEach(function(row) {
    if (row.rowNumber === targetRow.rowNumber) return;
    if (vfcBiqStatementIdentity_(row) !== identity) return;
    const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    const score = vfcBiqPayloadScore_(payload);
    if (score > bestScore) {
      best = payload;
      bestScore = score;
    }
  });
  return best;
}

function vfcBiqStatementIdentity_(row) {
  const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
  const header = payload && payload.headerSummary ? payload.headerSummary : {};
  const start = vfcBiqIsoDate_(header.statementStartDate || row.statementStartDate);
  const end = vfcBiqIsoDate_(header.statementEndDate || row.statementEndDate);
  if (start && end) return start + '|' + end;
  return String(row.fileName || '').trim().toLowerCase();
}

function vfcBiqPayloadScore_(payload) {
  if (!payload || !payload.headerSummary ||
      !(vfcBiqPositiveNumber_(payload.headerSummary.totalDeposits) > 0)) return 0;
  let score = 100;
  const dates = {};
  (payload.paymentCandidates || []).forEach(function(item) {
    if (!item || !(vfcBiqPositiveNumber_(item.amount) > 0)) return;
    if (item.confidence === 'High') score += 12;
    else if (item.confidence === 'Moderate') score += 7;
    else score += 1;
    const d = vfcBiqIsoDate_(item.date);
    if (d) dates[d] = true;
  });
  score += Math.min(30, Object.keys(dates).length * 3);
  return score;
}

function vfcBiqWritePayload_(sheet, row, payload) {
  const normalized = {
    version: VFC_BANKING_INPUT_CONFIG.PAYLOAD_VERSION,
    analyzedAt: payload.analyzedAt || new Date().toISOString(),
    fileName: row.fileName,
    headerSummary: payload.headerSummary || {},
    paymentCandidates: Array.isArray(payload.paymentCandidates) ? payload.paymentCandidates : [],
    financingCredits: Array.isArray(payload.financingCredits) ? payload.financingCredits : []
  };
  sheet.getRange(row.rowNumber, row.signalColumn).setValue(
    VFC_BANKING_INPUT_CONFIG.SIGNAL_PREFIX + JSON.stringify(normalized)
  );
}

function vfcBiqExtractStatementWithOpenAI_(text, fallbackRow) {
  const prompt = [
    'You are a bank-statement payment extractor. Return JSON only.',
    'Return: statement_start_date, statement_end_date, total_deposits, total_withdrawals, payment_candidates, financing_credits.',
    'payment_candidates items: date, description, counterparty, amount, kind, confidence.',
    'Allowed kinds: LOAN_PAYMENT, MCA_PAYMENT, FINANCING_PAYMENT, PAD, TAX_PAD, INSURANCE_FINANCE, CREDIT_CARD_PAYMENT.',
    'financing_credits items: date, description, counterparty, amount, kind, confidence.',
    'Allowed credit kinds: LOAN_ADVANCE, MCA_ADVANCE, OTHER_FINANCING_CREDIT.',
    '',
    'Rules:',
    '1. Header totals must come from the statement summary, never by summing transactions.',
    '2. Extract each visible loan/financing/PAD debit occurrence separately.',
    '3. A PAD is a candidate even when the payee is unfamiliar. Do not require any lender name.',
    '4. TAX_PAD is for CRA/CCRA/revenue/tax/government remittances.',
    '5. INSURANCE_FINANCE is for IPFS/premium/insurance financing.',
    '6. A loan payment is LOAN_PAYMENT. A clearly labelled MCA/cash-advance repayment is MCA_PAYMENT.',
    '7. Other clearly labelled financing repayments are FINANCING_PAYMENT.',
    '8. Never attach a nearby amount to a different transaction. Use the exact debit on that row.',
    '9. Do not classify suppliers, payroll, normal card purchases, Interac, ATM, ordinary e-transfers or ordinary operating expenses as financing/PAD.',
    '10. Do not decide recurrence. Local code will decide recurrence across dates.',
    '11. Financing credits must be incoming and explicitly look like funding/loan/advance proceeds. Omit uncertain credits.',
    '12. Omit uncertain payment candidates rather than guessing.',
    '13. confidence must be High, Moderate, or Low.',
    '',
    'Fallback header values only if the statement text is unclear:',
    JSON.stringify({
      statement_start_date: fallbackRow.statementStartDate || '',
      statement_end_date: fallbackRow.statementEndDate || '',
      total_deposits: fallbackRow.totalDeposits || '',
      total_withdrawals: fallbackRow.totalWithdrawals || ''
    }),
    '',
    'STATEMENT TEXT:',
    String(text || '').substring(0, 60000)
  ].join('\n');

  const raw = callOpenAIJson_(prompt) || {};
  return {
    headerSummary: {
      statementStartDate: vfcBiqIsoDate_(raw.statement_start_date || fallbackRow.statementStartDate),
      statementEndDate: vfcBiqIsoDate_(raw.statement_end_date || fallbackRow.statementEndDate),
      totalDeposits: vfcBiqRound_(vfcBiqPositiveNumber_(raw.total_deposits) || vfcBiqPositiveNumber_(fallbackRow.totalDeposits), 0.01),
      totalWithdrawals: vfcBiqRound_(vfcBiqPositiveNumber_(raw.total_withdrawals) || vfcBiqPositiveNumber_(fallbackRow.totalWithdrawals), 0.01)
    },
    paymentCandidates: vfcBiqNormalizePaymentCandidates_(raw.payment_candidates),
    financingCredits: vfcBiqNormalizeFinancingCredits_(raw.financing_credits)
  };
}

function vfcBiqNormalizePaymentCandidates_(items) {
  if (!Array.isArray(items)) return [];
  const allowed = {
    LOAN_PAYMENT:1, MCA_PAYMENT:1, FINANCING_PAYMENT:1, PAD:1,
    TAX_PAD:1, INSURANCE_FINANCE:1, CREDIT_CARD_PAYMENT:1
  };
  return vfcBiqDedupeSignals_(items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const amount = vfcBiqPositiveNumber_(item.amount);
    if (!allowed[kind] || !(amount > 0)) return null;
    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '').trim().substring(0, 180),
      counterparty: String(item.counterparty || item.description || '').trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      kind: kind,
      category: vfcBiqCategoryFromCandidate_(kind, item),
      confidence: vfcBiqConfidence_(item.confidence)
    };
  }).filter(Boolean));
}

function vfcBiqNormalizeFinancingCredits_(items) {
  if (!Array.isArray(items)) return [];
  const allowed = { LOAN_ADVANCE:1, MCA_ADVANCE:1, OTHER_FINANCING_CREDIT:1 };
  return vfcBiqDedupeSignals_(items.map(function(item) {
    item = item || {};
    const kind = String(item.kind || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const amount = vfcBiqPositiveNumber_(item.amount);
    const text = [item.description, item.counterparty].join(' ').toLowerCase();
    if (!allowed[kind] || !(amount >= 5000) || vfcBiqConfidence_(item.confidence) !== 'High') return null;
    if (!/loan|fund|financ|advance|capital|merchant|facility|credit/.test(text)) return null;
    return {
      date: vfcBiqIsoDate_(item.date),
      description: String(item.description || '').trim().substring(0, 180),
      counterparty: String(item.counterparty || item.description || '').trim().substring(0, 100),
      amount: vfcBiqRound_(amount, 0.01),
      kind: kind,
      category: kind,
      confidence: 'High'
    };
  }).filter(Boolean));
}

function vfcBiqCategoryFromCandidate_(kind, item) {
  const text = [item && item.description, item && item.counterparty].join(' ').toLowerCase();
  if (kind === 'TAX_PAD' || /\b(cra|ccra|revenue agency|gst|hst|source deduction|tax)\b/i.test(text)) return 'TAX_GOVERNMENT';
  if (kind === 'INSURANCE_FINANCE' || /\b(ipfs|premium finance|insurance finance|insurance financing)\b/i.test(text)) return 'INSURANCE_FINANCE';
  if (kind === 'CREDIT_CARD_PAYMENT') return 'CREDIT_CARD';
  if (kind === 'MCA_PAYMENT') return 'MCA';
  if (kind === 'LOAN_PAYMENT') {
    if (/commercial\s+loan/i.test(text)) return 'COMMERCIAL_LOAN';
    if (/\bline\s+of\s+credit\b|\bloc\b/i.test(text)) return 'LOC';
    if (/\blease\b/i.test(text)) return 'LEASE_FINANCE';
    return 'TERM_LOAN';
  }
  if (kind === 'FINANCING_PAYMENT') {
    if (/commercial\s+loan/i.test(text)) return 'COMMERCIAL_LOAN';
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

  const obligations = vfcBiqGroupPayments_(payments).map(function(group) {
    return vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate);
  }).filter(Boolean).sort(function(a,b){ return b.monthlyEquivalent - a.monthlyEquivalent; });

  const debtCats = { TERM_LOAN:1, COMMERCIAL_LOAN:1, LOC:1, LEASE_FINANCE:1, MCA:1, OTHER_FINANCING_PAYMENT:1, RECURRING_PAD:1 };
  const otherCats = { INSURANCE_FINANCE:1, CREDIT_CARD:1 };

  const activeDebt = obligations.filter(function(item) {
    return item.active && item.recurring && debtCats[item.category] && item.confidence !== 'Low';
  });
  const otherRecurring = obligations.filter(function(item) {
    return item.active && item.recurring && otherCats[item.category] && item.confidence !== 'Low';
  });
  const taxPads = obligations.filter(function(item) {
    return item.active && item.recurring && item.category === 'TAX_GOVERNMENT' && item.confidence !== 'Low';
  });

  const validCredits = credits.filter(function(item) { return item.confidence === 'High'; });

  return {
    confirmedMonthlyDebtService: vfcBiqRound_(activeDebt.reduce(function(sum,item){ return sum + item.monthlyEquivalent; },0),0.01),
    otherRecurringMonthlyObligations: vfcBiqRound_(otherRecurring.reduce(function(sum,item){ return sum + item.monthlyEquivalent; },0),0.01),
    activeDebtObligations: activeDebt,
    otherRecurringObligations: otherRecurring,
    taxGovernmentPads: taxPads,
    observedOnce: obligations.filter(function(item){ return !item.recurring; }),
    allDetectedObligations: obligations,
    financingCredits: validCredits,
    financingCreditsTotal: vfcBiqRound_(validCredits.reduce(function(sum,item){ return sum + vfcBiqPositiveNumber_(item.amount); },0),0.01),
    note: 'Confirmed financing debt uses repeated financing/PAD payments only. Tax/government and insurance-finance obligations are shown separately for context and are not added to confirmed financing debt.'
  };
}

function vfcBiqGroupPayments_(payments) {
  const groups = [];
  (payments || []).slice().sort(function(a,b){
    return (vfcBiqDate_(a.date)||new Date(0)) - (vfcBiqDate_(b.date)||new Date(0));
  }).forEach(function(payment) {
    const normalized = Object.assign({}, payment, {
      label: vfcBiqCanonicalLabel_(payment),
      amount: vfcBiqPositiveNumber_(payment.amount)
    });
    let target = null;
    for (let i=0;i<groups.length;i++) {
      if (vfcBiqSamePaymentPattern_(groups[i], normalized)) { target = groups[i]; break; }
    }
    if (!target) {
      target = { category: normalized.category, label: normalized.label, referenceAmount: normalized.amount, items: [] };
      groups.push(target);
    }
    target.items.push(normalized);
    target.referenceAmount = vfcBiqMedian_(target.items.map(function(item){ return item.amount; }));
  });
  return groups;
}

function vfcBiqSamePaymentPattern_(group, payment) {
  if (!group || !payment) return false;
  if (!vfcBiqCategoryFamilyMatches_(group.category, payment.category)) return false;
  if (!vfcBiqAmountsSimilar_(group.referenceAmount, payment.amount)) return false;
  if ({TERM_LOAN:1,COMMERCIAL_LOAN:1,LOC:1,LEASE_FINANCE:1,MCA:1}[group.category]) return true;
  return vfcBiqLabelsMatch_(group.label, payment.label);
}

function vfcBiqCategoryFamilyMatches_(a,b) {
  if (a === b) return true;
  const financing = { TERM_LOAN:1, COMMERCIAL_LOAN:1, LOC:1, LEASE_FINANCE:1, MCA:1, OTHER_FINANCING_PAYMENT:1 };
  return !!(financing[a] && financing[b]);
}

function vfcBiqAmountsSimilar_(a,b) {
  a = vfcBiqPositiveNumber_(a); b = vfcBiqPositiveNumber_(b);
  if (!(a>0) || !(b>0)) return false;
  const tolerance = Math.max(VFC_BANKING_INPUT_CONFIG.AMOUNT_TOLERANCE_DOLLARS, Math.max(a,b)*VFC_BANKING_INPUT_CONFIG.AMOUNT_TOLERANCE_PERCENT);
  return Math.abs(a-b) <= tolerance;
}

function vfcBiqCanonicalLabel_(payment) {
  const text = [payment && payment.counterparty, payment && payment.description].join(' ').toLowerCase();
  const loanId = text.match(/\b(?:loan|facility|account)\s*(?:payment|no|number|#)?\s*[:#.-]?\s*([a-z0-9-]{5,})\b/i);
  if (loanId && loanId[1]) return 'loan-' + loanId[1].replace(/[^a-z0-9]/gi,'').toLowerCase();
  const cleaned = text
    .replace(/\b(?:payment|payments|pmt|business|pad|preauthorized|pre-authorized|debit|withdrawal|eft|electronic|funds|transfer|misc|investment)\b/g,' ')
    .replace(/\b\d{5,}\b/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  return cleaned ? cleaned.split(' ').filter(function(t){return t.length>1;}).slice(0,8).join(' ') : 'generic';
}

function vfcBiqLabelsMatch_(a,b) {
  a = String(a||'generic'); b = String(b||'generic');
  if (a === b || a === 'generic' || b === 'generic') return true;
  const aa = {}; const bb = {}; const union = {};
  a.split(/\s+/).forEach(function(t){ if(t){aa[t]=1;union[t]=1;} });
  b.split(/\s+/).forEach(function(t){ if(t){bb[t]=1;union[t]=1;} });
  const all = Object.keys(union); if (!all.length) return true;
  let hit = 0; all.forEach(function(t){ if(aa[t]&&bb[t]) hit++; });
  return hit/all.length >= 0.5;
}

function vfcBiqSummarizeGroup_(group, monthsCovered, latestStatementDate) {
  if (!group || !group.items || !group.items.length) return null;
  const byDate = {};
  group.items.forEach(function(item) {
    const d = vfcBiqIsoDate_(item.date); if (!d) return;
    const key = d + '|' + vfcBiqRound_(item.amount,0.01);
    if (!byDate[key]) byDate[key] = item;
  });
  const items = Object.keys(byDate).map(function(k){return byDate[k];}).sort(function(a,b){return (vfcBiqDate_(a.date)||0)-(vfcBiqDate_(b.date)||0);});
  const dates = items.map(function(i){return vfcBiqDate_(i.date);}).filter(Boolean);
  const amounts = items.map(function(i){return vfcBiqPositiveNumber_(i.amount);}).filter(function(n){return n>0;});
  if (!amounts.length) return null;
  const amount = vfcBiqMedian_(amounts);
  const distinct = {}; dates.forEach(function(d){distinct[vfcBiqIsoDate_(d)] = 1;});
  const occurrences = Object.keys(distinct).length;
  const recurring = occurrences >= 2;
  const frequency = recurring ? vfcBiqInferFrequency_(dates, occurrences, monthsCovered) : 'Observed once';
  const monthly = recurring ? vfcBiqMonthlyEquivalent_(amount, frequency, occurrences, monthsCovered) : 0;
  const lastDate = dates.length ? dates[dates.length-1] : null;
  return {
    counterparty: vfcBiqBestCounterparty_(items),
    description: items[0] ? items[0].description : '',
    category: group.category,
    paymentAmount: vfcBiqRound_(amount,0.01),
    frequency: frequency,
    monthlyEquivalent: vfcBiqRound_(monthly,0.01),
    occurrences: occurrences,
    firstSeen: dates.length ? vfcBiqIsoDate_(dates[0]) : '',
    lastSeen: lastDate ? vfcBiqIsoDate_(lastDate) : '',
    recurring: recurring,
    active: recurring ? vfcBiqIsActive_(lastDate, latestStatementDate, frequency) : false,
    confidence: vfcBiqGroupConfidence_(items),
    patternLabel: group.label
  };
}

function vfcBiqBestCounterparty_(items) {
  const values = (items||[]).map(function(i){return String(i.counterparty||'').trim();}).filter(Boolean).sort(function(a,b){return b.length-a.length;});
  return values.length ? values[0] : 'Recurring Payment';
}

function vfcBiqInferFrequency_(dates, occurrences, monthsCovered) {
  if (dates && dates.length >= 2) {
    const sorted = dates.slice().sort(function(a,b){return a-b;});
    const intervals = [];
    for (let i=1;i<sorted.length;i++) {
      const days = Math.abs((sorted[i]-sorted[i-1])/86400000);
      if (days>0) intervals.push(days);
    }
    const medianDays = vfcBiqMedian_(intervals);
    if (medianDays>0 && medianDays<=3.5) return 'Business daily';
    if (medianDays<=10) return 'Weekly';
    if (medianDays<=20) return 'Biweekly';
    if (medianDays<=45) return 'Monthly';
    if (medianDays<=75) return 'Every 2 months';
    return 'Irregular';
  }
  const perMonth = occurrences/Math.max(1,monthsCovered||1);
  if (perMonth>=3) return 'Weekly';
  if (perMonth>=1.5) return 'Biweekly';
  if (perMonth>=0.65) return 'Monthly';
  return 'Irregular';
}

function vfcBiqMonthlyEquivalent_(amount, frequency, occurrences, monthsCovered) {
  amount = vfcBiqPositiveNumber_(amount); if (!(amount>0)) return 0;
  if (frequency==='Business daily') return amount*21.7;
  if (frequency==='Weekly') return amount*4.33;
  if (frequency==='Biweekly') return amount*2.17;
  if (frequency==='Monthly') return amount;
  if (frequency==='Every 2 months') return amount*0.5;
  return amount*Math.max(1,occurrences)/Math.max(1,monthsCovered||1);
}

function vfcBiqIsActive_(lastDate, latestStatementDate, frequency) {
  if (!lastDate || !latestStatementDate) return true;
  const days = (latestStatementDate-lastDate)/86400000;
  const allowed = frequency==='Every 2 months' ? 90 : VFC_BANKING_INPUT_CONFIG.ACTIVE_LOOKBACK_DAYS;
  return days>=-3 && days<=allowed;
}

function vfcBiqGroupConfidence_(items) {
  if (!items || !items.length) return 'Low';
  const score = items.reduce(function(sum,item){return sum+(item.confidence==='High'?2:item.confidence==='Moderate'?1:0);},0)/items.length;
  return score>=1.5?'High':score>=0.75?'Moderate':'Low';
}

function vfcBiqBuildAudit_(companyName, period, base) {
  const allRows = vfcBiqReadSummaryRows_(companyName, period);
  const latestRows = vfcBiqLatestBatch_(allRows);
  const byStatement = {};
  latestRows.forEach(function(row) { byStatement[vfcBiqStatementIdentity_(row)] = row; });
  const rows = Object.keys(byStatement).map(function(k){return byStatement[k];}).sort(function(a,b){return vfcBiqEffectiveDate_(a)-vfcBiqEffectiveDate_(b);});

  let totalDeposits=0,totalWithdrawals=0,nsfCount=0,negativeBalanceFlag=0;
  const starts=[],ends=[],months={},monthlyDeposits=[],monthlyWithdrawals=[];
  rows.forEach(function(row) {
    const payload = vfcBiqParsePayload_(row.possibleMcaOrLoanPayments);
    const header = payload && payload.headerSummary ? payload.headerSummary : {};
    const start = vfcBiqDate_(header.statementStartDate || row.statementStartDate);
    const end = vfcBiqDate_(header.statementEndDate || row.statementEndDate);
    const deposits = vfcBiqPositiveNumber_(header.totalDeposits) || vfcBiqPositiveNumber_(row.totalDeposits);
    const withdrawals = vfcBiqPositiveNumber_(header.totalWithdrawals) || vfcBiqPositiveNumber_(row.totalWithdrawals);
    if(start) starts.push(start); if(end) ends.push(end);
    totalDeposits += deposits; totalWithdrawals += withdrawals;
    nsfCount += Math.max(0,vfcBiqNumber_(row.nsfCount));
    if(vfcBiqTruthyFlag_(row.negativeBalanceDetected)) negativeBalanceFlag=1;
    monthlyDeposits.push(deposits); monthlyWithdrawals.push(withdrawals);
    const md=end||start; if(md) months[md.getUTCFullYear()+'-'+('0'+(md.getUTCMonth()+1)).slice(-2)]=1;
  });
  const earliest=starts.length?new Date(Math.min.apply(null,starts.map(function(d){return d.getTime();}))):null;
  const latest=ends.length?new Date(Math.max.apply(null,ends.map(function(d){return d.getTime();}))):null;
  const span=earliest&&latest?Math.max(1,Math.round(((((latest-earliest)/86400000)+1)/30.4375))):0;
  const monthsCovered=Math.max(1,Object.keys(months).length||span||rows.length||vfcBiqNumber_(base.monthsCovered)||1);
  const older=Math.max(0,allRows.length-latestRows.length);
  const warnings=[]; if(older>0) warnings.push('Using the latest upload batch; '+older+' older statement row(s) were ignored for current banking totals.');
  return {rows:rows,allMatchingRows:allRows.length,latestBatchRows:latestRows.length,olderRowsIgnored:older,monthsCovered:monthsCovered,totalDeposits:totalDeposits,totalWithdrawals:totalWithdrawals,nsfCount:nsfCount,negativeBalanceFlag:negativeBalanceFlag,monthlyDeposits:monthlyDeposits,monthlyWithdrawals:monthlyWithdrawals,latestStatementDate:latest,warnings:warnings};
}

function vfcBiqReadSummaryRows_(companyName, period) {
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries'); if(!sheet) return [];
  const values=sheet.getDataRange().getValues(); if(values.length<2) return [];
  const h=values[0];
  const c={upload:vfcBiqColumn_(h,'Upload ID'),company:vfcBiqColumn_(h,'Company Name'),period:vfcBiqColumn_(h,'Detected Period'),file:vfcBiqColumn_(h,'File Name'),start:vfcBiqColumn_(h,'Statement Start Date'),end:vfcBiqColumn_(h,'Statement End Date'),deposits:vfcBiqColumn_(h,'Total Deposits'),withdrawals:vfcBiqColumn_(h,'Total Withdrawals'),nsf:vfcBiqColumn_(h,'NSF Count'),negative:vfcBiqColumn_(h,'Negative Balance Detected'),signal:vfcBiqColumn_(h,'Possible MCA Or Loan Payments'),created:vfcBiqColumn_(h,'Created At')};
  return values.slice(1).map(function(r,i){return{uploadId:r[c.upload],companyName:r[c.company],detectedPeriod:r[c.period],fileName:String(r[c.file]||'statement.pdf'),statementStartDate:r[c.start],statementEndDate:r[c.end],totalDeposits:r[c.deposits],totalWithdrawals:r[c.withdrawals],nsfCount:r[c.nsf],negativeBalanceDetected:r[c.negative],possibleMcaOrLoanPayments:r[c.signal],createdAt:r[c.created],rowNumber:i+2,signalColumn:c.signal+1};}).filter(function(r){return(!companyName||vfcBiqSame_(r.companyName,companyName))&&(!period||vfcBiqSame_(r.detectedPeriod,period));});
}

function vfcBiqUploadMap_() {
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads'); if(!sheet) return {};
  const values=sheet.getDataRange().getValues(); if(values.length<2) return {};
  const h=values[0],u=vfcBiqColumn_(h,'Upload ID'),f=vfcBiqColumn_(h,'File ID'),n=vfcBiqColumn_(h,'File Name'),map={};
  values.slice(1).forEach(function(r){const id=String(r[u]||'').trim();if(id)map[id]={fileId:String(r[f]||'').trim(),fileName:String(r[n]||'')};});
  return map;
}

function vfcBiqLatestBatch_(rows) {
  const out=[],seen={}; let last=null;
  for(let i=rows.length-1;i>=0;i--){const r=rows[i],name=String(r.fileName||'').trim().toLowerCase(),created=vfcBiqDate_(r.createdAt);if(out.length){if(name&&seen[name])break;if(created&&last!==null&&Math.abs(last-created.getTime())/60000>VFC_BANKING_INPUT_CONFIG.LATEST_BATCH_GAP_MINUTES)break;}out.push(r);if(name)seen[name]=1;if(created)last=created.getTime();}
  return out.reverse();
}

function vfcBiqParsePayload_(value) {
  const text=String(value||'').trim();
  let prefix='';
  VFC_BANKING_INPUT_CONFIG.LEGACY_PREFIXES.some(function(p){if(text.indexOf(p)===0){prefix=p;return true;}return false;});
  if(!prefix)return null;
  try{const p=JSON.parse(text.substring(prefix.length));return{version:vfcBiqNumber_(p.version),analyzedAt:p.analyzedAt||'',fileName:p.fileName||'',headerSummary:p.headerSummary||{},paymentCandidates:Array.isArray(p.paymentCandidates)?p.paymentCandidates:[],financingCredits:Array.isArray(p.financingCredits)?p.financingCredits:[]};}catch(e){return null;}
}

function vfcBiqDedupeSignals_(items) {
  const seen={}; return(items||[]).filter(function(item){if(!item)return false;const key=[vfcBiqIsoDate_(item.date),vfcBiqRound_(vfcBiqPositiveNumber_(item.amount),0.01),String(item.category||item.kind||''),vfcBiqCanonicalLabel_(item)].join('|').toLowerCase();if(seen[key])return false;seen[key]=1;return true;});
}

function vfcBiqColumn_(headers,wanted){const target=String(wanted||'').toLowerCase().replace(/[^a-z0-9]/g,'');for(let i=0;i<headers.length;i++){if(String(headers[i]||'').toLowerCase().replace(/[^a-z0-9]/g,'')===target)return i;}throw new Error('Missing required column: '+wanted);}
function vfcBiqEffectiveDate_(row){const p=vfcBiqParsePayload_(row.possibleMcaOrLoanPayments),h=p&&p.headerSummary?p.headerSummary:{};return vfcBiqDate_(h.statementEndDate||row.statementEndDate||h.statementStartDate||row.statementStartDate)||new Date(0);}
function vfcBiqNormalizeRequest_(companyOrRequest,requestedPeriod){let companyName='',period=requestedPeriod||'';if(companyOrRequest&&typeof companyOrRequest==='object'){companyName=companyOrRequest.companyName||companyOrRequest.company||'';period=companyOrRequest.period||companyOrRequest.detectedPeriod||period;}else companyName=companyOrRequest||'';companyName=String(companyName||'').trim();period=String(period||'').trim();if(!companyName)throw new Error('Company name is required.');return{companyName:companyName,period:period};}
function vfcBiqSame_(a,b){return String(a||'').trim().toLowerCase()===String(b||'').trim().toLowerCase();}
function vfcBiqConfidence_(v){const t=String(v||'').trim().toLowerCase();return t==='high'?'High':t==='low'?'Low':'Moderate';}
function vfcBiqDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcBiqIsoDate_(v){const d=vfcBiqDate_(v);return d?Utilities.formatDate(d,'UTC','yyyy-MM-dd'):'';}
function vfcBiqNumber_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function vfcBiqPositiveNumber_(v){return Math.max(0,vfcBiqNumber_(v));}
function vfcBiqTruthyFlag_(v){return/^(1|true|yes|detected)$/i.test(String(v||'').trim())?1:0;}
function vfcBiqRound_(v,step){const n=vfcBiqNumber_(v),inc=vfcBiqNumber_(step)||1;return Math.round(n/inc)*inc;}
function vfcBiqMedian_(values){const a=(values||[]).map(vfcBiqNumber_).filter(function(v){return v>0;}).sort(function(a,b){return a-b;});if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;}
function vfcBiqCoefficientOfVariation_(values){const a=(values||[]).map(vfcBiqNumber_).filter(function(v){return v>=0;});if(!a.length)return 1;const avg=a.reduce(function(s,v){return s+v;},0)/a.length;if(!avg)return 1;const variance=a.reduce(function(s,v){return s+Math.pow(v-avg,2);},0)/a.length;return Math.sqrt(variance)/avg;}
function vfcBiqTrend_(values){const a=(values||[]).map(vfcBiqNumber_);if(a.length<2)return 0;const split=Math.max(1,Math.floor(a.length/2)),x=a.slice(0,split),y=a.slice(split),xa=x.reduce(function(s,v){return s+v;},0)/x.length,ya=y.length?y.reduce(function(s,v){return s+v;},0)/y.length:xa;return xa>0?(ya-xa)/xa:0;}
