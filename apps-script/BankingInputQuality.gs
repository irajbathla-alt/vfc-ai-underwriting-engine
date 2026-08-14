const VFC_BANK = {
  VERSION: 'VFC-BANKING-STABLE-11.0-AUTO-REUSE',
  PREFIX: 'VFC_BANK_AUTO_V2:',
  LEGACY_PREFIXES: [
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
  MODEL: 'gpt-4.1-mini'
};

function getBankingInputQualityStatus() {
  const r = {
    modelVersion: VFC_BANK.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    bankAgnostic: true,
    usesExistingVerifiedResultsFirst: true,
    usesReconciledStoredTotalsSecond: true,
    rereadsPdfOnlyWhenNeeded: true,
    historicalTrainingFilesAreNotReprocessed: true,
    partialResults: false,
    repeatedPadDetection: true,
    sameVerifiedStatementsSameBankingInputs: true
  };
  console.log(JSON.stringify(r, null, 2));
  return r;
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const q = vfcBankReq_(companyOrRequest, requestedPeriod);
    const period = q.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(q.companyName, q.period)
      : q.period);
    const base = vfcBankBaseFeatures_(q.companyName, period);
    const rows = vfcBankSelected_(q.companyName, period);
    if (!rows.length) throw new Error('No bank statements found for this company and period.');
    const ensured = vfcBankEnsure_(q.companyName, period, rows, true);
    if (!ensured.ok) {
      return {
        ok: false,
        modelVersion: VFC_BANK.VERSION,
        companyName: q.companyName,
        period: period,
        errors: ensured.errors,
        unverifiedFiles: ensured.bad
      };
    }
    const features = vfcBankBuild_(base || {}, rows);
    return {
      ok: true,
      modelVersion: VFC_BANK.VERSION,
      companyName: q.companyName,
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
  } catch (e) {
    return { ok: false, modelVersion: VFC_BANK.VERSION, errors: [String(e && e.message || e)] };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcBankRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a, b) { return vfcBankTime_(a.createdAt) - vfcBankTime_(b.createdAt); });
  const last = rows[rows.length - 1];
  const r = refreshDebtSignalsForPeriodSafe({ companyName: last.companyName, period: last.detectedPeriod });
  console.log(JSON.stringify(r, null, 2));
  return r;
}

function diagnoseLatestBankingInputs() {
  return refreshLatestDebtSignals();
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = vfcBankBaseFeatures_(companyName, period);
  if (!base) return null;
  const rows = vfcBankSelected_(companyName, period);
  if (!rows.length) return base;

  let ensured = vfcBankEnsure_(companyName, period, rows, false);
  if (ensured.ok) return vfcBankBuild_(base, rows);

  if (vfcBankHasHistoricalOutcome_(companyName, period)) {
    return vfcBankHistoricalBase_(base);
  }

  ensured = vfcBankEnsure_(companyName, period, rows, true);
  if (!ensured.ok) {
    throw new Error('Unable to verify uploaded statement(s) automatically: ' + ensured.bad.join(', '));
  }
  return vfcBankBuild_(base, rows);
}

function vfcBankBaseFeatures_(companyName, period) {
  if (typeof buildPowerFeatures_ === 'function') return buildPowerFeatures_(companyName, period);
  if (typeof buildFeaturesForCase_ === 'function') return buildFeaturesForCase_(companyName, period);
  return null;
}

function vfcBankHistoricalBase_(base) {
  const b = Object.assign({}, base || {});
  if (b.existingMonthlyDebtService === undefined) b.existingMonthlyDebtService = 0;
  if (b.informationalRecurringMonthlyObligations === undefined) b.informationalRecurringMonthlyObligations = 0;
  if (b.estimatedOperatingMonthlyDeposits === undefined) b.estimatedOperatingMonthlyDeposits = vfcBankNum_(b.averageMonthlyDeposits);
  if (!b.debtProfile) b.debtProfile = { activeDebtObligations: [], otherRecurringObligations: [], taxGovernmentPads: [], financingCredits: [] };
  if (!b.inputQualityAudit) b.inputQualityAudit = { modelVersion: 'STORED-TRAINING-FEATURES', verified: true, statementAudit: [], warnings: ['Historical training case used stored Structured Features; old PDFs were not reprocessed.'] };
  return b;
}

function vfcBankEnsure_(company, period, rows, allowPdfRead) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('PDF Summaries');
  if (!sh) throw new Error('Missing PDF Summaries sheet.');
  const uploads = allowPdfRead ? vfcBankUploads_() : {};
  const reuse = vfcBankReuseMap_(vfcBankRows_(company, ''));
  let analyzed = 0, reused = 0, adopted = 0, skipped = 0;
  const errors = [];

  rows.forEach(function(row, index) {
    const cur = vfcBankNewPayload_(row.signal);
    if (cur) { skipped++; return; }

    const key = vfcBankKey_(row);
    if (reuse[key]) {
      vfcBankWrite_(sh, row, reuse[key]);
      reused++;
      return;
    }

    const legacy = vfcBankLegacyPayload_(row.signal, row);
    if (legacy) {
      vfcBankWrite_(sh, row, legacy);
      reuse[key] = legacy;
      adopted++;
      return;
    }

    const stored = vfcBankStoredPayload_(row);
    const isDebtLookback = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    if (stored && (!isDebtLookback || !allowPdfRead)) {
      vfcBankWrite_(sh, row, stored);
      reuse[key] = stored;
      adopted++;
      return;
    }

    if (!allowPdfRead) return;

    try {
      const upload = uploads[String(row.uploadId || '').trim()] || {};
      if (!upload.fileId) throw new Error('uploaded PDF file was not found');
      if (typeof extractTextFromPdf_ !== 'function') throw new Error('PDF text reader is unavailable');
      const text = extractTextFromPdf_(upload.fileId);
      let payload = null;

      if (stored) {
        const signals = vfcBankExtract_(text, row, true);
        payload = Object.assign({}, stored, {
          verifiedAt: new Date().toISOString(),
          paymentCandidates: vfcBankPayments_(signals.payments),
          financingCredits: vfcBankCredits_(signals.financingCredits),
          signalSource: 'PDF_STRUCTURED_SIGNALS'
        });
      } else {
        let last = '';
        for (let attempt = 0; attempt < 2 && !payload; attempt++) {
          try {
            payload = vfcBankVerifyExtract_(vfcBankExtract_(text, row, false), row);
          } catch (e) {
            last = String(e && e.message || e);
          }
        }
        if (!payload) throw new Error(last || 'statement could not be reconciled');
      }

      vfcBankWrite_(sh, row, payload);
      reuse[key] = payload;
      analyzed++;
    } catch (e) {
      errors.push(row.fileName + ': ' + String(e && e.message || e));
    }
  });

  const bad = [];
  rows.forEach(function(row) {
    if (!vfcBankPayloadAt_(row.row, row.col)) bad.push(row.fileName);
  });
  return { ok: bad.length === 0, analyzed: analyzed, reused: reused, adopted: adopted, skipped: skipped, errors: errors, bad: bad };
}

function vfcBankStoredPayload_(row) {
  const o = vfcBankNull_(row.opening), c = vfcBankNull_(row.closing), d = vfcBankNullPos_(row.totalDeposits), w = vfcBankNullPos_(row.totalWithdrawals);
  if (o === null || c === null || d === null || w === null) return null;
  const diff = Math.abs((o + d - w) - c);
  if (diff > VFC_BANK.RECONCILE_TOLERANCE) return null;
  return vfcBankMakePayload_(row, {
    bankName: row.bank || 'Unknown', openingBalance: o, closingBalance: c,
    totalDeposits: d, totalWithdrawals: w, reconciliationDifference: diff,
    totalsSource: 'STORED_SUMMARY_RECONCILED', nsfCount: row.nsfCount,
    negativeBalanceDetected: vfcBankFlag_(row.negativeBalance), paymentCandidates: [], financingCredits: []
  });
}

function vfcBankLegacyPayload_(value, row) {
  const text = String(value || '').trim();
  let prefix = '';
  for (let i = 0; i < VFC_BANK.LEGACY_PREFIXES.length; i++) {
    if (text.indexOf(VFC_BANK.LEGACY_PREFIXES[i]) === 0) { prefix = VFC_BANK.LEGACY_PREFIXES[i]; break; }
  }
  if (!prefix) return null;
  let p;
  try { p = JSON.parse(text.substring(prefix.length)); } catch (e) { return null; }
  if (!p) return null;
  const h = p.headerSummary || p;
  const o = vfcBankNull_(h.openingBalance), c = vfcBankNull_(h.closingBalance), d = vfcBankNullPos_(h.totalDeposits), w = vfcBankNullPos_(h.totalWithdrawals);
  if (o === null || c === null || d === null || w === null) return null;
  const diff = Math.abs((o + d - w) - c);
  if (diff > VFC_BANK.RECONCILE_TOLERANCE) return null;
  return vfcBankMakePayload_(row, {
    bankName: p.bankAdapter || p.bankName || row.bank || 'Unknown',
    openingBalance: o, closingBalance: c, totalDeposits: d, totalWithdrawals: w,
    reconciliationDifference: diff, totalsSource: 'ADOPTED_PRIOR_VERIFIED_RESULT',
    nsfCount: p.nsfCount !== undefined ? p.nsfCount : row.nsfCount,
    negativeBalanceDetected: p.negativeBalanceDetected !== undefined ? p.negativeBalanceDetected : vfcBankFlag_(row.negativeBalance),
    paymentCandidates: vfcBankNormalizeLegacyPayments_(p.paymentCandidates || []),
    financingCredits: vfcBankNormalizeLegacyCredits_(p.financingCredits || [])
  });
}

function vfcBankMakePayload_(row, x) {
  return {
    version: 2,
    modelVersion: VFC_BANK.VERSION,
    verified: true,
    verifiedAt: new Date().toISOString(),
    statementKey: vfcBankKey_(row),
    bankName: String(x.bankName || row.bank || 'Unknown'),
    statementStartDate: vfcBankIso_(row.start),
    statementEndDate: vfcBankIso_(row.end),
    openingBalance: vfcBankRound_(x.openingBalance, .01),
    closingBalance: vfcBankRound_(x.closingBalance, .01),
    totalDeposits: vfcBankRound_(x.totalDeposits, .01),
    totalWithdrawals: vfcBankRound_(x.totalWithdrawals, .01),
    reconciliationDifference: vfcBankRound_(x.reconciliationDifference, .01),
    totalsSource: String(x.totalsSource || ''),
    nsfCount: Math.max(0, Math.round(vfcBankNum_(x.nsfCount))),
    negativeBalanceDetected: !!x.negativeBalanceDetected,
    paymentCandidates: vfcBankPayments_(x.paymentCandidates || []),
    financingCredits: vfcBankCredits_(x.financingCredits || [])
  };
}

function vfcBankExtract_(statementText, row, signalsOnly) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY.');
  const model = props.getProperty('OPENAI_BANKING_MODEL') || (typeof VFC_CONFIG !== 'undefined' && VFC_CONFIG.OPENAI_MODEL ? VFC_CONFIG.OPENAI_MODEL : VFC_BANK.MODEL);
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      bank: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
      opening: { type: ['number','null'] }, closing: { type: ['number','null'] },
      credits: { type: ['number','null'] }, debits: { type: ['number','null'] },
      pageCredits: { type: 'array', items: { type: 'number' } },
      pageDebits: { type: 'array', items: { type: 'number' } },
      transactionCredits: { type: ['number','null'] }, transactionDebits: { type: ['number','null'] },
      nsf: { type: 'integer', minimum: 0 }, negative: { type: 'boolean' },
      payments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        date: { type: 'string' }, description: { type: 'string' }, counterparty: { type: 'string' }, amount: { type: 'number', minimum: 0 },
        category: { type: 'string', enum: ['LOAN','MCA','FINANCING','PAD','TAX','INSURANCE','CREDIT_CARD','OTHER'] },
        confidence: { type: 'string', enum: ['High','Moderate','Low'] }
      }, required: ['date','description','counterparty','amount','category','confidence'] } },
      financingCredits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        date: { type: 'string' }, description: { type: 'string' }, counterparty: { type: 'string' }, amount: { type: 'number', minimum: 0 },
        confidence: { type: 'string', enum: ['High','Moderate','Low'] }
      }, required: ['date','description','counterparty','amount','confidence'] } }
    },
    required: ['bank','start','end','opening','closing','credits','debits','pageCredits','pageDebits','transactionCredits','transactionDebits','nsf','negative','payments','financingCredits']
  };
  const instructions = [
    'Read the complete uploaded business bank statement. The bank can be any Canadian bank or credit union.',
    'Return only values explicitly supported by the statement. Never estimate or use a nearby transaction amount.',
    'Opening and closing are the first and final statement balances.',
    'Credits and debits are WHOLE-STATEMENT totals, never one page. If page subtotals are printed, return every page subtotal exactly once.',
    'Never use average balance, minimum balance, available balance, or running balances as deposits or withdrawals.',
    'Payments must be exact debits that are loan, financing, MCA, PAD/preauthorized debit, tax/government, insurance finance, credit-card payment, or another fixed recurring obligation.',
    'Do not classify fees, suppliers, payroll, fuel, purchases, ordinary transfers, e-transfers, cheques, or normal operating expenses as financing debt.',
    'A generic repeated PAD can be PAD even when the lender name is unknown.',
    'Financing credits are incoming credits only when the description explicitly proves loan/funding/financing/advance/cash-advance proceeds.',
    signalsOnly ? 'The stored statement totals already reconcile. Focus especially on exact payment candidates and financing credits.' : 'Extract totals carefully so they can be mathematically reconciled.',
    'Use YYYY-MM-DD dates. Return JSON only.'
  ].join(' ');
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({
      model: model, instructions: instructions,
      input: JSON.stringify({ file: row.fileName, knownStart: vfcBankIso_(row.start), knownEnd: vfcBankIso_(row.end), statementText: String(statementText || '').substring(0, 120000) }),
      text: { format: { type: 'json_schema', name: 'vfc_bank_statement_v11', strict: true, schema: schema } }
    }), muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (e) { throw new Error('Unreadable statement extraction response.'); }
  if (status < 200 || status >= 300 || body.error) throw new Error(body && body.error && body.error.message ? body.error.message : 'Statement extraction failed.');
  const out = vfcBankOutput_(body);
  if (!out) throw new Error('Empty statement extraction response.');
  try { return JSON.parse(out); } catch (e) { throw new Error('Statement extraction was not valid JSON.'); }
}

function vfcBankVerifyExtract_(x, row) {
  x = x || {};
  const totals = [];
  const c = vfcBankNullPos_(x.credits), d = vfcBankNullPos_(x.debits), pc = vfcBankArr_(x.pageCredits), pd = vfcBankArr_(x.pageDebits), tc = vfcBankNullPos_(x.transactionCredits), td = vfcBankNullPos_(x.transactionDebits);
  if (c !== null && d !== null) totals.push({ c: c, d: d, source: 'STATEMENT_TOTALS', rank: 1 });
  if (pc.length && pd.length) totals.push({ c: vfcBankSum_(pc), d: vfcBankSum_(pd), source: 'PAGE_SUBTOTALS', rank: 2 });
  if (tc !== null && td !== null) totals.push({ c: tc, d: td, source: 'TRANSACTION_SUM', rank: 3 });
  const balances = [];
  const eo = vfcBankNull_(x.opening), ec = vfcBankNull_(x.closing), so = vfcBankNull_(row.opening), sc = vfcBankNull_(row.closing);
  if (eo !== null && ec !== null) balances.push({ o: eo, c: ec, source: 'EXTRACTED' });
  if (so !== null && sc !== null && (so !== eo || sc !== ec)) balances.push({ o: so, c: sc, source: 'STORED' });
  let best = null;
  totals.forEach(function(t) {
    balances.forEach(function(b) {
      const diff = Math.abs((b.o + t.c - t.d) - b.c);
      if (diff <= VFC_BANK.RECONCILE_TOLERANCE) {
        const z = { o: b.o, close: b.c, dep: t.c, wd: t.d, diff: diff, source: t.source + '+' + b.source, rank: t.rank };
        if (!best || z.diff < best.diff || (Math.abs(z.diff - best.diff) < .001 && z.rank < best.rank)) best = z;
      }
    });
  });
  if (!best) throw new Error('statement totals did not reconcile');
  return vfcBankMakePayload_(row, {
    bankName: x.bank || row.bank || 'Unknown', openingBalance: best.o, closingBalance: best.close,
    totalDeposits: best.dep, totalWithdrawals: best.wd, reconciliationDifference: best.diff,
    totalsSource: best.source, nsfCount: x.nsf, negativeBalanceDetected: !!x.negative,
    paymentCandidates: x.payments || [], financingCredits: x.financingCredits || []
  });
}

function vfcBankBuild_(base, rows) {
  let dep = 0, wd = 0, nsf = 0, neg = 0, latest = null;
  const md = [], mw = [], audit = [], verifiedRows = [];
  rows.forEach(function(row) {
    const p = vfcBankPayloadAt_(row.row, row.col);
    if (!p) throw new Error('Verified statement result missing: ' + row.fileName);
    dep += p.totalDeposits; wd += p.totalWithdrawals; md.push(p.totalDeposits); mw.push(p.totalWithdrawals);
    nsf += Math.max(0, vfcBankNum_(p.nsfCount)); if (p.negativeBalanceDetected) neg = 1;
    const e = vfcBankDate_(p.statementEndDate); if (e && (!latest || e > latest)) latest = e;
    verifiedRows.push({ row: row, payload: p });
    audit.push({
      fileName: row.fileName, bank: p.bankName, statementStartDate: p.statementStartDate, statementEndDate: p.statementEndDate,
      totalDeposits: p.totalDeposits, totalWithdrawals: p.totalWithdrawals, openingBalance: p.openingBalance, closingBalance: p.closingBalance,
      reconciliationDifference: p.reconciliationDifference, totalsSource: p.totalsSource, verified: true
    });
  });
  const recent = verifiedRows.slice(Math.max(0, verifiedRows.length - VFC_BANK.DEBT_LOOKBACK));
  const debt = vfcBankDebt_(recent, latest);
  const m = verifiedRows.length, gross = dep / Math.max(1, m), operatingTotal = Math.max(0, dep - debt.financingCreditsTotal), operating = operatingTotal / Math.max(1, m);
  return Object.assign({}, base, {
    statementCount: m, monthsCovered: m, totalDeposits: vfcBankRound_(dep, .01), averageMonthlyDeposits: vfcBankRound_(gross, .01),
    totalWithdrawals: vfcBankRound_(wd, .01), depositWithdrawalRatio: wd > 0 ? vfcBankRound_(dep / wd, .01) : 0,
    nsfCount: nsf, nsfPerMonth: vfcBankRound_(nsf / Math.max(1, m), .01), negativeBalanceFlag: neg,
    mcaPaymentFlag: debt.activeDebtObligations.length ? 1 : 0, monthlyDeposits: md, monthlyWithdrawals: mw,
    depositVolatility: vfcBankRound_(vfcBankCv_(md), .01), depositTrend: vfcBankRound_(vfcBankTrend_(md), .01),
    estimatedOperatingTotalDeposits: vfcBankRound_(operatingTotal, .01), estimatedOperatingMonthlyDeposits: vfcBankRound_(operating, .01),
    detectedFinancingCredits: vfcBankRound_(debt.financingCreditsTotal, .01), existingMonthlyDebtService: vfcBankRound_(debt.confirmedMonthlyDebtService, .01),
    otherRecurringMonthlyObligations: 0, informationalRecurringMonthlyObligations: vfcBankRound_(debt.informationalMonthlyObligations, .01),
    debtServiceToDepositsRatio: gross > 0 ? vfcBankRound_(debt.confirmedMonthlyDebtService / gross, .0001) : 0,
    debtProfile: debt,
    inputQualityAudit: {
      modelVersion: VFC_BANK.VERSION, verified: true, selectedStatementRows: m,
      grossAverageMonthlyDeposits: vfcBankRound_(gross, .01), estimatedOperatingMonthlyDeposits: vfcBankRound_(operating, .01),
      statementAudit: audit, warnings: []
    }
  });
}

function vfcBankPayments_(a) {
  if (!Array.isArray(a)) return [];
  const out = [], seen = {};
  a.forEach(function(x) {
    x = x || {};
    const amount = vfcBankPos_(x.amount), desc = String(x.description || '').trim(), date = vfcBankIso_(x.date), category = vfcBankCategory_(x.category, desc);
    if (!date || !desc || amount <= 0 || !category || /\bFEE\b|SERVICE\s+CHARGE|NSF|PAYMENT\s+COVERAGE/i.test(desc)) return;
    const y = { date: date, description: desc.substring(0, 180), counterparty: String(x.counterparty || desc).trim().substring(0, 120), amount: vfcBankRound_(amount, .01), category: category, confidence: vfcBankConf_(x.confidence) };
    const k = [y.date, y.amount, y.category, vfcBankCanon_(y)].join('|');
    if (!seen[k]) { seen[k] = 1; out.push(y); }
  });
  return out;
}

function vfcBankNormalizeLegacyPayments_(a) { return vfcBankPayments_(a); }
function vfcBankNormalizeLegacyCredits_(a) { return vfcBankCredits_(a); }

function vfcBankCategory_(category, desc) {
  const c = String(category || '').toUpperCase();
  if (['LOAN','TERM_LOAN','TRUCK_FINANCE','AUTO_FINANCE','COMMERCIAL_LOAN','LOC','LEASE_FINANCE'].indexOf(c) >= 0) return 'LOAN';
  if (c === 'MCA') return 'MCA';
  if (['FINANCING','OTHER_FINANCING_PAYMENT'].indexOf(c) >= 0) return 'FINANCING';
  if (['PAD','RECURRING_PAD'].indexOf(c) >= 0) return 'PAD';
  if (['TAX','TAX_GOVERNMENT'].indexOf(c) >= 0) return 'TAX';
  if (['INSURANCE','INSURANCE_FINANCE'].indexOf(c) >= 0) return 'INSURANCE';
  if (['CREDIT_CARD','CREDIT_CARD_PAYMENT'].indexOf(c) >= 0) return 'CREDIT_CARD';
  if (['OTHER','OTHER_RECURRING'].indexOf(c) >= 0) return 'OTHER';
  const s = String(desc || '').toUpperCase();
  if (/\bCRA\b|\bCCRA\b|GST|HST|\bTAX\b|WCB|EMPTX|TXBAL/.test(s)) return 'TAX';
  if (/\bPAD\b|PRE[- ]?AUTH/.test(s)) return 'PAD';
  if (/\bLOAN\b/.test(s)) return 'LOAN';
  if (/FINANC|MCA|CASH\s+ADVANCE/.test(s)) return 'FINANCING';
  return '';
}

function vfcBankCredits_(a) {
  if (!Array.isArray(a)) return [];
  const out = [], seen = {};
  a.forEach(function(x) {
    x = x || {};
    const amount = vfcBankPos_(x.amount), date = vfcBankIso_(x.date), desc = String(x.description || '').trim(), conf = vfcBankConf_(x.confidence);
    const legacyCategory = String(x.category || '').toUpperCase();
    const proven = /LOAN|FUND|FINANC|ADVANCE|CASH\s+ADVANCE|\bMCA\b/i.test(desc) || /LOAN_ADVANCE|MCA_ADVANCE|OTHER_FINANCING_CREDIT/.test(legacyCategory);
    if (!date || !desc || amount < 5000 || conf !== 'High' || !proven) return;
    const y = { date: date, description: desc.substring(0, 180), counterparty: String(x.counterparty || desc).trim().substring(0, 120), amount: vfcBankRound_(amount, .01), confidence: conf };
    const k = [y.date, y.amount, y.description.toLowerCase()].join('|');
    if (!seen[k]) { seen[k] = 1; out.push(y); }
  });
  return out;
}

function vfcBankDebt_(verifiedRows, latest) {
  let payments = [], credits = [];
  (verifiedRows || []).forEach(function(x) {
    payments = payments.concat(x.payload.paymentCandidates || []);
    credits = credits.concat(x.payload.financingCredits || []);
  });
  const groups = {};
  payments.forEach(function(x) {
    const family = vfcBankFamily_(x.category), canonical = vfcBankCanon_(x);
    if (!canonical) return;
    const key = family + '|' + canonical;
    if (!groups[key]) groups[key] = { family: family, category: x.category, canonical: canonical, items: [] };
    groups[key].items.push(x);
  });
  const observed = Object.keys(groups).map(function(k) { return vfcBankGroup_(groups[k], latest); }).filter(Boolean);
  const active = observed.filter(function(x) { return x.active && x.recurring && (x.family === 'FINANCING' || x.family === 'PAD') && x.confidence !== 'Low'; });
  const tax = observed.filter(function(x) { return x.active && x.recurring && x.family === 'TAX'; });
  const other = observed.filter(function(x) { return x.active && x.recurring && x.family !== 'FINANCING' && x.family !== 'PAD' && x.family !== 'TAX'; });
  const seen = {};
  credits = credits.filter(function(x) { const k = [x.date, x.amount, x.description.toLowerCase()].join('|'); if (seen[k]) return false; seen[k] = 1; return true; });
  return {
    confirmedMonthlyDebtService: vfcBankRound_(active.reduce(function(s, x) { return s + x.monthlyEquivalent; }, 0), .01),
    informationalMonthlyObligations: vfcBankRound_(tax.concat(other).reduce(function(s, x) { return s + x.monthlyEquivalent; }, 0), .01),
    activeDebtObligations: active, taxGovernmentPads: tax, otherRecurringObligations: other,
    observedOnce: observed.filter(function(x) { return !x.recurring; }), allDetectedObligations: observed,
    financingCredits: credits, financingCreditsTotal: vfcBankRound_(credits.reduce(function(s, x) { return s + x.amount; }, 0), .01),
    note: 'Confirmed debt uses repeated explicit financing/loan/MCA payments or repeated PADs. Tax, insurance, cards and unclear recurring obligations are informational only.'
  };
}

function vfcBankFamily_(c) {
  c = String(c || '').toUpperCase();
  if (c === 'LOAN' || c === 'MCA' || c === 'FINANCING') return 'FINANCING';
  if (c === 'PAD') return 'PAD';
  if (c === 'TAX') return 'TAX';
  if (c === 'INSURANCE') return 'INSURANCE';
  if (c === 'CREDIT_CARD') return 'CREDIT_CARD';
  return 'OTHER';
}

function vfcBankGroup_(g, latest) {
  const seen = {}, items = (g.items || []).filter(function(x) {
    const k = x.date + '|' + vfcBankRound_(x.amount, .01); if (seen[k]) return false; seen[k] = 1; return true;
  }).sort(function(a, b) { return vfcBankDate_(a.date) - vfcBankDate_(b.date); });
  if (!items.length) return null;
  const dates = items.map(function(x) { return vfcBankDate_(x.date); }).filter(Boolean), amounts = items.map(function(x) { return x.amount; }).filter(function(x) { return x > 0; });
  const recurring = dates.length >= 2, frequency = recurring ? vfcBankFrequency_(dates) : 'Observed once', amount = vfcBankMedian_(amounts), monthly = recurring ? vfcBankMonthly_(amount, frequency) : 0;
  const last = dates[dates.length - 1], days = latest && last ? (latest - last) / 86400000 : 0, active = recurring && (!latest || (days >= -3 && days <= VFC_BANK.ACTIVE_DAYS));
  return {
    counterparty: vfcBankBest_(items), description: items[0].description || '', category: g.category, family: g.family,
    paymentAmount: vfcBankRound_(amount, .01), frequency: frequency, monthlyEquivalent: vfcBankRound_(monthly, .01), occurrences: dates.length,
    firstSeen: vfcBankIso_(dates[0]), lastSeen: vfcBankIso_(last), recurring: recurring, active: active, confidence: vfcBankGroupConf_(items), patternLabel: g.canonical
  };
}

function vfcBankCanon_(x) {
  let s = String((x && (x.counterparty || x.description)) || '').toUpperCase();
  if (x && x.category === 'TAX') {
    if (/\bCRA\b|\bCCRA\b/.test(s)) return 'CRA CCRA TAX';
    if (/GST|HST/.test(s)) return 'GST HST TAX';
    if (/WCB/.test(s)) return 'WCB';
    if (/EMPTX/.test(s)) return 'EMPLOYER TAX';
    if (/TXBAL/.test(s)) return 'TAX BALANCE';
  }
  return s.replace(/\b(?:PAYMENT|PAYMENTS|PYMT|PMT|PAD|PAA|APY|MSP|EFT|DEBIT|WITHDRAWAL|PREAUTHORIZED|PRE-AUTHORIZED)\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ').replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
}

function vfcBankFrequency_(dates) {
  const s = dates.slice().sort(function(a, b) { return a - b; }), gaps = [];
  for (let i = 1; i < s.length; i++) { const d = Math.abs((s[i] - s[i - 1]) / 86400000); if (d > 0) gaps.push(d); }
  const d = vfcBankMedian_(gaps);
  if (d <= 4) return 'Business daily';
  if (d <= 10) return 'Weekly';
  if (d <= 20) return 'Biweekly';
  if (d <= 45) return 'Monthly';
  if (d <= 75) return 'Every 2 months';
  return 'Irregular';
}
function vfcBankMonthly_(a, f) { if (f === 'Business daily') return a * 21.7; if (f === 'Weekly') return a * 4.33; if (f === 'Biweekly') return a * 2.17; if (f === 'Monthly') return a; if (f === 'Every 2 months') return a * .5; return 0; }

function vfcBankHasHistoricalOutcome_(company, period) {
  if (typeof getSheetObjects_ !== 'function') return false;
  const names = ['Training Records', 'Observed Lender Behaviour'];
  for (let i = 0; i < names.length; i++) {
    let rows = [];
    try { rows = getSheetObjects_(names[i]); } catch (e) { rows = []; }
    for (let j = 0; j < rows.length; j++) {
      const r = rows[j];
      if (vfcBankSame_(r.companyName, company) && vfcBankPeriodSame_(r.period || r.detectedPeriod, period)) return true;
    }
  }
  return false;
}

function vfcBankSelected_(company, period) {
  const rows = vfcBankRows_(company, period), map = {};
  rows.forEach(function(r) { const k = vfcBankKey_(r), old = map[k]; if (!old || vfcBankTime_(r.createdAt) >= vfcBankTime_(old.createdAt)) map[k] = r; });
  return Object.keys(map).map(function(k) { return map[k]; }).sort(function(a, b) { return (vfcBankDate_(a.end) || new Date(0)) - (vfcBankDate_(b.end) || new Date(0)); }).slice(-VFC_BANK.MAX_STATEMENTS);
}

function vfcBankRows_(company, period) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sh) return [];
  const v = sh.getDataRange().getValues(); if (v.length < 2) return [];
  const h = v[0], c = {
    upload: vfcBankCol_(h, 'Upload ID'), company: vfcBankCol_(h, 'Company Name'), period: vfcBankCol_(h, 'Detected Period'), file: vfcBankCol_(h, 'File Name'),
    bank: vfcBankColOpt_(h, 'Bank Name'), start: vfcBankCol_(h, 'Statement Start Date'), end: vfcBankCol_(h, 'Statement End Date'),
    opening: vfcBankColOpt_(h, 'Opening Balance'), closing: vfcBankColOpt_(h, 'Closing Balance'), deposits: vfcBankCol_(h, 'Total Deposits'), withdrawals: vfcBankCol_(h, 'Total Withdrawals'),
    nsf: vfcBankCol_(h, 'NSF Count'), negative: vfcBankCol_(h, 'Negative Balance Detected'), signal: vfcBankCol_(h, 'Possible MCA Or Loan Payments'), created: vfcBankCol_(h, 'Created At')
  };
  return v.slice(1).map(function(r, i) {
    return {
      uploadId: r[c.upload], companyName: r[c.company], detectedPeriod: r[c.period], fileName: String(r[c.file] || 'statement.pdf'), bank: c.bank >= 0 ? r[c.bank] : '',
      start: r[c.start], end: r[c.end], opening: c.opening >= 0 ? r[c.opening] : '', closing: c.closing >= 0 ? r[c.closing] : '',
      totalDeposits: r[c.deposits], totalWithdrawals: r[c.withdrawals], nsfCount: r[c.nsf], negativeBalance: r[c.negative], signal: r[c.signal], createdAt: r[c.created], row: i + 2, col: c.signal + 1
    };
  }).filter(function(r) { return (!company || vfcBankSame_(r.companyName, company)) && (!period || vfcBankPeriodSame_(r.detectedPeriod, period)); });
}

function vfcBankUploads_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads'); if (!sh) return {};
  const v = sh.getDataRange().getValues(); if (v.length < 2) return {};
  const h = v[0], u = vfcBankCol_(h, 'Upload ID'), f = vfcBankCol_(h, 'File ID'), out = {};
  v.slice(1).forEach(function(r) { const id = String(r[u] || '').trim(); if (id) out[id] = { fileId: String(r[f] || '').trim() }; });
  return out;
}

function vfcBankReuseMap_(rows) {
  const out = {};
  (rows || []).forEach(function(r) {
    const p = vfcBankNewPayload_(r.signal) || vfcBankLegacyPayload_(r.signal, r);
    if (p) out[vfcBankKey_(r)] = p;
  });
  return out;
}

function vfcBankNewPayload_(value) {
  const t = String(value || '').trim(); if (t.indexOf(VFC_BANK.PREFIX) !== 0) return null;
  try { const p = JSON.parse(t.substring(VFC_BANK.PREFIX.length)); return vfcBankPayloadValid_(p) ? p : null; } catch (e) { return null; }
}
function vfcBankPayloadAt_(row, col) { const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries'); return sh ? vfcBankNewPayload_(sh.getRange(row, col).getValue()) : null; }
function vfcBankPayloadValid_(p) { if (!p || !p.verified) return false; const diff = Math.abs((vfcBankNum_(p.openingBalance) + vfcBankNum_(p.totalDeposits) - vfcBankNum_(p.totalWithdrawals)) - vfcBankNum_(p.closingBalance)); return diff <= VFC_BANK.RECONCILE_TOLERANCE; }
function vfcBankWrite_(sh, row, payload) { sh.getRange(row.row, row.col).setValue(VFC_BANK.PREFIX + JSON.stringify(payload)); }
function vfcBankKey_(r) { return [String(r.companyName || '').trim().toLowerCase(), vfcBankIso_(r.start), vfcBankIso_(r.end)].join('|'); }

function vfcBankBest_(a) { const c = {}; (a || []).forEach(function(x) { const t = String(x.counterparty || x.description || '').trim(); if (t) c[t] = (c[t] || 0) + 1; }); const k = Object.keys(c).sort(function(a, b) { return c[b] !== c[a] ? c[b] - c[a] : a.length - b.length; }); return k.length ? k[0] : 'Recurring Payment'; }
function vfcBankGroupConf_(a) { if (!a || !a.length) return 'Low'; const s = a.reduce(function(t, x) { return t + (x.confidence === 'High' ? 2 : x.confidence === 'Moderate' ? 1 : 0); }, 0) / a.length; return s >= 1.5 ? 'High' : s >= .75 ? 'Moderate' : 'Low'; }
function vfcBankOutput_(b) { if (b && typeof b.output_text === 'string' && b.output_text) return b.output_text; const o = b && Array.isArray(b.output) ? b.output : []; for (let i = 0; i < o.length; i++) { const c = Array.isArray(o[i].content) ? o[i].content : []; for (let j = 0; j < c.length; j++) if (c[j] && typeof c[j].text === 'string' && c[j].text) return c[j].text; } return ''; }
function vfcBankReq_(x, p) { let company = '', period = p || ''; if (x && typeof x === 'object') { company = x.companyName || x.company || ''; period = x.period || x.detectedPeriod || period; } else company = x || ''; company = String(company || '').trim(); period = String(period || '').trim(); if (!company) throw new Error('Company name is required.'); return { companyName: company, period: period }; }
function vfcBankCol_(h, w) { const i = vfcBankColOpt_(h, w); if (i < 0) throw new Error('Missing required column: ' + w); return i; }
function vfcBankColOpt_(h, w) { const t = String(w || '').toLowerCase().replace(/[^a-z0-9]/g, ''); for (let i = 0; i < h.length; i++) if (String(h[i] || '').toLowerCase().replace(/[^a-z0-9]/g, '') === t) return i; return -1; }
function vfcBankDate_(v) { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }
function vfcBankIso_(v) { const d = vfcBankDate_(v); return d ? Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd') : ''; }
function vfcBankNull_(v) { if (v === '' || v === null || v === undefined) return null; const t = String(v).trim(); if (!t) return null; let n = vfcBankNum_(t); if (/OD$/i.test(t)) n = -Math.abs(n); return isFinite(n) ? n : null; }
function vfcBankNullPos_(v) { const n = vfcBankNull_(v); return n !== null && n >= 0 ? n : null; }
function vfcBankNum_(v) { if (typeof v === 'number') return isFinite(v) ? v : 0; const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
function vfcBankPos_(v) { return Math.max(0, vfcBankNum_(v)); }
function vfcBankArr_(v) { return Array.isArray(v) ? v.map(vfcBankPos_).filter(function(x) { return isFinite(x) && x >= 0; }) : []; }
function vfcBankRound_(v, s) { const i = vfcBankNum_(s) || 1; return Math.round(vfcBankNum_(v) / i) * i; }
function vfcBankSum_(a) { return (a || []).reduce(function(s, x) { return s + vfcBankNum_(x); }, 0); }
function vfcBankMedian_(a) { const n = (a || []).map(vfcBankNum_).filter(function(x) { return isFinite(x) && x >= 0; }).sort(function(a, b) { return a - b; }); if (!n.length) return 0; const m = Math.floor(n.length / 2); return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; }
function vfcBankCv_(a) { const n = (a || []).map(vfcBankNum_).filter(function(x) { return x >= 0; }); if (!n.length) return 1; const avg = vfcBankSum_(n) / n.length; if (!avg) return 1; return Math.sqrt(n.reduce(function(s, x) { return s + Math.pow(x - avg, 2); }, 0) / n.length) / avg; }
function vfcBankTrend_(a) { const n = (a || []).map(vfcBankNum_); if (n.length < 2) return 0; const split = Math.max(1, Math.floor(n.length / 2)), first = n.slice(0, split), second = n.slice(split), fa = vfcBankSum_(first) / first.length, sa = second.length ? vfcBankSum_(second) / second.length : fa; return fa > 0 ? (sa - fa) / fa : 0; }
function vfcBankConf_(v) { const t = String(v || '').trim().toLowerCase(); return t === 'high' ? 'High' : t === 'low' ? 'Low' : 'Moderate'; }
function vfcBankFlag_(v) { return /^(1|true|yes|detected)$/i.test(String(v || '').trim()); }
function vfcBankSame_(a, b) { return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase(); }
function vfcBankPeriodSame_(a, b) { const clean = function(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }; return clean(a) === clean(b); }
function vfcBankTime_(v) { const d = vfcBankDate_(v); return d ? d.getTime() : 0; }
