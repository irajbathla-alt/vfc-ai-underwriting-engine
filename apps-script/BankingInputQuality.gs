const VFC_BANK = {
  VERSION: 'VFC-BANKING-STABLE-13.0-DIRECTIONAL-CASHFLOW',
  PREFIX: 'VFC_BANK_LOCKED_V2:',
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_DAYS: 90,
  MODEL: 'gpt-4.1-mini',
  MAX_TEXT_CHARS: 120000
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANK.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    bankAgnostic: true,
    balanceReconciliationRequired: true,
    partialResultsAllowed: false,
    directionalTransactionsRequired: true,
    repeatedPadDetection: true,
    revolvingSweepDetection: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = vfcBankBaseFeatures_(companyName, period);
  if (!base) return null;
  const rows = vfcBankSelected_(companyName, period);
  if (!rows.length) return base;
  const ensured = vfcBankEnsureCurrent_(companyName, period, rows);
  if (!ensured.ok) {
    throw new Error('Unable to verify uploaded statement(s) automatically: ' + ensured.bad.join(', ') +
      (ensured.errors.length ? '. ' + ensured.errors.join(' | ') : ''));
  }
  return vfcBankBuild_(base, rows);
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcBankReq_(companyOrRequest, requestedPeriod);
    const period = req.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(req.companyName, req.period)
      : req.period);
    const rows = vfcBankSelected_(req.companyName, period);
    if (!rows.length) throw new Error('No bank statements found for this company and period.');
    const ensured = vfcBankEnsureCurrent_(req.companyName, period, rows);
    if (!ensured.ok) return { ok: false, modelVersion: VFC_BANK.VERSION, errors: ensured.errors, unverifiedFiles: ensured.bad };
    const features = vfcBankBuild_(vfcBankBaseFeatures_(req.companyName, period) || {}, rows);
    return {
      ok: true,
      modelVersion: VFC_BANK.VERSION,
      companyName: req.companyName,
      period: period,
      errors: [],
      statementAudit: features.inputQualityAudit.statementAudit,
      debtProfile: features.debtProfile,
      bankingFeatures: {
        averageMonthlyDeposits: features.averageMonthlyDeposits,
        estimatedOperatingMonthlyDeposits: features.estimatedOperatingMonthlyDeposits,
        existingMonthlyDebtService: features.existingMonthlyDebtService,
        informationalRecurringMonthlyObligations: features.informationalRecurringMonthlyObligations,
        detectedFinancingCredits: features.detectedFinancingCredits
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
  const result = refreshDebtSignalsForPeriodSafe({ companyName: last.companyName, period: last.detectedPeriod });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseLatestBankingInputs() { return refreshLatestDebtSignals(); }

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
  const errors = [];
  rows.forEach(function(row, index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    if (vfcBankPayloadAt_(row.row, row.col, recent)) return;
    const stored = vfcBankStoredPayload_(row);
    if (!recent && stored) {
      vfcBankWrite_(sheet, row, stored);
      return;
    }
    try {
      const upload = uploads[String(row.uploadId || '').trim()] || {};
      if (!upload.fileId) throw new Error('uploaded PDF file was not found');
      if (typeof extractTextFromPdf_ !== 'function') throw new Error('PDF text reader is unavailable');
      const text = extractTextFromPdf_(upload.fileId);
      let payload;
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
          signalSource: 'PDF_DIRECTIONAL_SIGNAL_EXTRACTION'
        });
      } else {
        payload = vfcBankVerifyFullExtract_(vfcBankExtractFull_(text, row), row);
      }
      vfcBankWrite_(sheet, row, payload);
    } catch (e) {
      errors.push(row.fileName + ': ' + String(e && e.message || e));
    }
  });
  const bad = [];
  rows.forEach(function(row, index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    if (!vfcBankPayloadAt_(row.row, row.col, recent)) bad.push(row.fileName);
  });
  return { ok: bad.length === 0, errors: errors, bad: bad };
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
    bankName: row.bank || 'Unknown', openingBalance: opening, closingBalance: closing,
    totalDeposits: deposits, totalWithdrawals: withdrawals, reconciliationDifference: diff,
    totalsSource: 'STORED_SUMMARY_RECONCILED', nsfCount: row.nsfCount,
    negativeBalanceDetected: vfcBankFlag_(row.negativeBalance), paymentCandidates: [], financingCredits: [],
    signalsVerified: false, signalSource: 'NONE'
  });
}

function vfcBankMakePayload_(row, v) {
  return {
    version: 2,
    modelVersion: VFC_BANK.VERSION,
    verified: true,
    signalsVerified: !!v.signalsVerified,
    verifiedAt: new Date().toISOString(),
    statementKey: vfcBankKey_(row),
    bankName: String(v.bankName || row.bank || 'Unknown'),
    statementStartDate: vfcBankIso_(row.start),
    statementEndDate: vfcBankIso_(row.end),
    openingBalance: vfcBankRound_(v.openingBalance, .01),
    closingBalance: vfcBankRound_(v.closingBalance, .01),
    totalDeposits: vfcBankRound_(v.totalDeposits, .01),
    totalWithdrawals: vfcBankRound_(v.totalWithdrawals, .01),
    reconciliationDifference: vfcBankRound_(v.reconciliationDifference, .01),
    totalsSource: String(v.totalsSource || ''),
    signalSource: String(v.signalSource || ''),
    nsfCount: Math.max(0, Math.round(vfcBankNum_(v.nsfCount))),
    negativeBalanceDetected: !!v.negativeBalanceDetected,
    paymentCandidates: vfcBankPayments_(v.paymentCandidates || []),
    financingCredits: vfcBankCredits_(v.financingCredits || [])
  };
}

function vfcBankExtractSignals_(statementText, row) {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      bank: { type: 'string' }, nsf: { type: 'integer', minimum: 0 }, negative: { type: 'boolean' },
      payments: vfcBankPaymentSchema_(), financingCredits: vfcBankCreditSchema_()
    },
    required: ['bank', 'nsf', 'negative', 'payments', 'financingCredits']
  };
  const instructions = [
    'Read this complete business bank statement from any Canadian bank or credit union.',
    'For payments, return only transactions posted in the DEBIT/withdrawal column. Never return a credit as a payment.',
    'Return each exact debit that is clearly loan, financing, MCA, PAD/preauthorized debit, tax/government, insurance finance, credit-card payment, or another fixed recurring obligation.',
    'Do not return suppliers, payroll, fuel, gas bills, utilities, hydro, telecom, ordinary transfers, e-transfers, cheques, bank fees, NSF fees, payment coverage fees, or normal operating expenses as financing debt.',
    'For financingCredits, return only transactions posted in the CREDIT/deposit column that are explicit loan/funding/financing proceeds OR a named capital/funder credit that is strongly linked to a financing/PAD debit from the same or similar counterparty in this statement.',
    'Examples of confirmed financing credits include LOAN CREDIT, LOAN ADVANCE, FUNDING, FINANCING, MCA/CASH ADVANCE proceeds, or a named funder credit followed by its PAD repayment.',
    'If a large credit looks financing-related but is not proven, return it as POSSIBLE, not CONFIRMED.',
    'Never infer an amount from a nearby line. Use exact dates and amounts. Use YYYY-MM-DD. Return JSON only.'
  ].join(' ');
  return vfcBankOpenAIJson_(statementText, row, schema, instructions, 'vfc_bank_signals_v13');
}

function vfcBankExtractFull_(statementText, row) {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      bank: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
      opening: { type: ['number','null'] }, closing: { type: ['number','null'] },
      credits: { type: ['number','null'] }, debits: { type: ['number','null'] },
      pageCredits: { type: 'array', items: { type: 'number' } }, pageDebits: { type: 'array', items: { type: 'number' } },
      nsf: { type: 'integer', minimum: 0 }, negative: { type: 'boolean' },
      payments: vfcBankPaymentSchema_(), financingCredits: vfcBankCreditSchema_()
    },
    required: ['bank','start','end','opening','closing','credits','debits','pageCredits','pageDebits','nsf','negative','payments','financingCredits']
  };
  const instructions = [
    'Read this complete business bank statement from any Canadian bank or credit union.',
    'Opening and closing are the first and final statement balances. Credits and debits are whole-statement totals, never one page subtotal.',
    'If printed page subtotals exist, return each exactly once. Never use average, available, or running balances as statement totals.',
    'Payments must be DEBITS only. Financing credits must be CREDITS only.',
    'Do not classify fuel, gas, utilities, hydro, suppliers, payroll, ordinary transfers, cheques, bank fees or normal operating expenses as financing debt.',
    'Return confirmed financing credits for explicit loan/funding/advance/MCA proceeds and named funder credits linked to PAD repayments. Ambiguous items are POSSIBLE.',
    'Use exact values. Return JSON only.'
  ].join(' ');
  return vfcBankOpenAIJson_(statementText, row, schema, instructions, 'vfc_bank_full_v13');
}

function vfcBankPaymentSchema_() {
  return { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: {
      date: { type: 'string' }, description: { type: 'string' }, counterparty: { type: 'string' },
      amount: { type: 'number', minimum: 0 }, direction: { type: 'string', enum: ['DEBIT','CREDIT'] },
      category: { type: 'string', enum: ['LOAN','MCA','FINANCING','PAD','TAX','INSURANCE','CREDIT_CARD','OTHER'] },
      confidence: { type: 'string', enum: ['High','Moderate','Low'] }
    }, required: ['date','description','counterparty','amount','direction','category','confidence'] } };
}

function vfcBankCreditSchema_() {
  return { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: {
      date: { type: 'string' }, description: { type: 'string' }, counterparty: { type: 'string' },
      amount: { type: 'number', minimum: 0 }, direction: { type: 'string', enum: ['DEBIT','CREDIT'] },
      classification: { type: 'string', enum: ['CONFIRMED','POSSIBLE'] },
      confidence: { type: 'string', enum: ['High','Moderate','Low'] }, evidence: { type: 'string' }
    }, required: ['date','description','counterparty','amount','direction','classification','confidence','evidence'] } };
}

function vfcBankOpenAIJson_(statementText, row, schema, instructions, schemaName) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY.');
  const model = props.getProperty('OPENAI_BANKING_MODEL') ||
    (typeof VFC_CONFIG !== 'undefined' && VFC_CONFIG.OPENAI_MODEL ? VFC_CONFIG.OPENAI_MODEL : VFC_BANK.MODEL);
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({ model: model, instructions: instructions,
      input: JSON.stringify({ file: row.fileName, knownStart: vfcBankIso_(row.start), knownEnd: vfcBankIso_(row.end), statementText: String(statementText || '').substring(0, VFC_BANK.MAX_TEXT_CHARS) }),
      text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: schema } } }),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  let body;
  try { body = JSON.parse(response.getContentText()); } catch (e) { throw new Error('Unreadable statement extraction response. HTTP ' + status + '.'); }
  if (status < 200 || status >= 300 || body.error) throw new Error(body && body.error && body.error.message ? body.error.message : 'Statement extraction failed. HTTP ' + status + '.');
  const output = vfcBankOutput_(body);
  if (!output) throw new Error('Empty statement extraction response.');
  try { return JSON.parse(output); } catch (e) { throw new Error('Statement extraction was not valid JSON.'); }
}

function vfcBankVerifyFullExtract_(raw, row) {
  raw = raw || {};
  const totals = [];
  const credits = vfcBankNullPos_(raw.credits), debits = vfcBankNullPos_(raw.debits);
  if (credits !== null && debits !== null) totals.push({ credits: credits, debits: debits, source: 'STATEMENT_TOTALS' });
  const pc = vfcBankArr_(raw.pageCredits), pd = vfcBankArr_(raw.pageDebits);
  if (pc.length && pd.length) totals.push({ credits: vfcBankSum_(pc), debits: vfcBankSum_(pd), source: 'PAGE_SUBTOTALS' });
  const balances = [];
  const eo = vfcBankNull_(raw.opening), ec = vfcBankNull_(raw.closing), so = vfcBankNull_(row.opening), sc = vfcBankNull_(row.closing);
  if (eo !== null && ec !== null) balances.push({ opening: eo, closing: ec, source: 'EXTRACTED_BALANCES' });
  if (so !== null && sc !== null) balances.push({ opening: so, closing: sc, source: 'STORED_BALANCES' });
  let best = null;
  totals.forEach(function(t) { balances.forEach(function(b) {
    const diff = Math.abs((b.opening + t.credits - t.debits) - b.closing);
    if (diff <= VFC_BANK.RECONCILE_TOLERANCE && (!best || diff < best.diff)) best = { opening: b.opening, closing: b.closing, deposits: t.credits, withdrawals: t.debits, diff: diff, source: t.source + '+' + b.source };
  }); });
  if (!best) throw new Error('statement totals did not reconcile');
  return vfcBankMakePayload_(row, {
    bankName: raw.bank || row.bank || 'Unknown', openingBalance: best.opening, closingBalance: best.closing,
    totalDeposits: best.deposits, totalWithdrawals: best.withdrawals, reconciliationDifference: best.diff,
    totalsSource: best.source, nsfCount: raw.nsf, negativeBalanceDetected: !!raw.negative,
    paymentCandidates: raw.payments || [], financingCredits: raw.financingCredits || [], signalsVerified: true,
    signalSource: 'PDF_FULL_DIRECTIONAL_EXTRACTION'
  });
}

function vfcBankPayments_(items) {
  if (!Array.isArray(items)) return [];
  const out = [], seen = {};
  items.forEach(function(item) {
    item = item || {};
    if (String(item.direction || '').toUpperCase() !== 'DEBIT') return;
    const amount = vfcBankPos_(item.amount), description = String(item.description || '').trim(), date = vfcBankIso_(item.date);
    if (!date || !description || amount <= 0) return;
    if (/\bFEE\b|SERVICE\s+CHARGE|NSF|PAYMENT\s+COVERAGE/i.test(description)) return;
    if (/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|PETROLEUM|FUEL/i.test(description)) return;
    const category = vfcBankCategory_(item.category, description);
    if (!category) return;
    const n = { date: date, description: description.substring(0,180), counterparty: String(item.counterparty || description).trim().substring(0,120),
      amount: vfcBankRound_(amount,.01), direction: 'DEBIT', category: category, confidence: vfcBankConf_(item.confidence) };
    const key = [n.date,n.amount,n.category,vfcBankCanon_(n)].join('|');
    if (!seen[key]) { seen[key] = 1; out.push(n); }
  });
  return out;
}

function vfcBankCredits_(items) {
  if (!Array.isArray(items)) return [];
  const out = [], seen = {};
  items.forEach(function(item) {
    item = item || {};
    if (String(item.direction || '').toUpperCase() !== 'CREDIT') return;
    const amount = vfcBankPos_(item.amount), date = vfcBankIso_(item.date), description = String(item.description || '').trim();
    if (!date || !description || amount <= 0) return;
    const explicit = /\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|FUNDING|FINANC|CASH\s+ADVANCE|\bMCA\b/i.test(description);
    const classification = explicit ? 'CONFIRMED' : (String(item.classification || '').toUpperCase() === 'CONFIRMED' ? 'CONFIRMED' : 'POSSIBLE');
    const n = { date: date, description: description.substring(0,180), counterparty: String(item.counterparty || description).trim().substring(0,120),
      amount: vfcBankRound_(amount,.01), direction: 'CREDIT', classification: classification,
      confidence: vfcBankConf_(item.confidence), evidence: String(item.evidence || '').substring(0,220) };
    const key = [n.date,n.amount,n.description.toLowerCase()].join('|');
    if (!seen[key]) { seen[key] = 1; out.push(n); }
  });
  return out;
}

function vfcBankCategory_(category, description) {
  const s = String(description || '').toUpperCase();
  if (/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|PETROLEUM|FUEL/.test(s)) return '';
  if (/\bCRA\b|\bCCRA\b|GST|HST|\bTAX\b|WCB|EMPTX|TXBAL|TXINS/.test(s)) return 'TAX';
  if (/\bIPFS\b|PREMIUM\s+FIN|INSURANCE\s+FIN|\bINSURANCE\b/.test(s)) return 'INSURANCE';
  if (/CREDIT\s+CARD/.test(s)) return 'CREDIT_CARD';
  if (/JOURNEY|ONDECK|MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)) return 'MCA';
  if (/\bBDC\b/.test(s)) return 'FINANCING';
  if (/\bPAD\b|PRE[- ]?AUTH/.test(s)) return 'PAD';
  if (/\bMCA\b|MERCHANT\s+CASH\s+ADVANCE/.test(s)) return 'MCA';
  if (/TRUCK\s*FIN|TRUCKFIN|FORD\s+CREDIT|\bLOAN\b/.test(s)) return 'LOAN';
  if (/FINANC|CASH\s+ADVANCE/.test(s)) return 'FINANCING';
  const c = String(category || '').toUpperCase();
  if (['LOAN','MCA','FINANCING','PAD','TAX','INSURANCE','CREDIT_CARD','OTHER'].indexOf(c) >= 0) return c;
  return '';
}

function vfcBankBuild_(base, rows) {
  let deposits = 0, withdrawals = 0, nsf = 0, negative = 0, latest = null;
  const monthlyDeposits = [], monthlyWithdrawals = [], openingBalances = [], closingBalances = [], audit = [], verifiedRows = [];
  rows.forEach(function(row,index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK.DEBT_LOOKBACK);
    const p = vfcBankPayloadAt_(row.row,row.col,recent);
    if (!p) throw new Error('Verified statement result missing: ' + row.fileName);
    deposits += p.totalDeposits; withdrawals += p.totalWithdrawals; monthlyDeposits.push(p.totalDeposits); monthlyWithdrawals.push(p.totalWithdrawals);
    openingBalances.push(p.openingBalance); closingBalances.push(p.closingBalance); nsf += Math.max(0,vfcBankNum_(p.nsfCount)); if (p.negativeBalanceDetected) negative = 1;
    const end = vfcBankDate_(p.statementEndDate); if (end && (!latest || end > latest)) latest = end;
    verifiedRows.push({ row: row, payload: p });
    audit.push({ fileName: row.fileName, bank: p.bankName, statementStartDate: p.statementStartDate, statementEndDate: p.statementEndDate,
      totalDeposits: p.totalDeposits, totalWithdrawals: p.totalWithdrawals, openingBalance: p.openingBalance, closingBalance: p.closingBalance,
      reconciliationDifference: p.reconciliationDifference, totalsSource: p.totalsSource, signalSource: p.signalSource, signalsVerified: p.signalsVerified, verified: true });
  });
  const recentRows = verifiedRows.slice(Math.max(0, verifiedRows.length - VFC_BANK.DEBT_LOOKBACK));
  const debt = vfcBankDebt_(recentRows, latest);
  const months = verifiedRows.length, grossMonthly = deposits / Math.max(1,months);
  const operatingTotal = Math.max(0, deposits - debt.financingCreditsTotal), operatingMonthly = operatingTotal / Math.max(1,months);
  return Object.assign({}, base, {
    statementCount: months, monthsCovered: months, totalDeposits: vfcBankRound_(deposits,.01), averageMonthlyDeposits: vfcBankRound_(grossMonthly,.01),
    totalWithdrawals: vfcBankRound_(withdrawals,.01), depositWithdrawalRatio: withdrawals > 0 ? vfcBankRound_(deposits/withdrawals,.01) : 0,
    nsfCount: nsf, nsfPerMonth: vfcBankRound_(nsf/Math.max(1,months),.01), negativeBalanceFlag: negative,
    averageOpeningBalance: vfcBankRound_(vfcBankSum_(openingBalances)/Math.max(1,openingBalances.length),.01),
    averageClosingBalance: vfcBankRound_(vfcBankSum_(closingBalances)/Math.max(1,closingBalances.length),.01),
    mcaPaymentFlag: debt.activeDebtObligations.length ? 1 : 0, monthlyDeposits: monthlyDeposits, monthlyWithdrawals: monthlyWithdrawals,
    depositVolatility: vfcBankRound_(vfcBankCv_(monthlyDeposits),.01), depositTrend: vfcBankRound_(vfcBankTrend_(monthlyDeposits),.01),
    estimatedOperatingTotalDeposits: vfcBankRound_(operatingTotal,.01), estimatedOperatingMonthlyDeposits: vfcBankRound_(operatingMonthly,.01),
    detectedFinancingCredits: vfcBankRound_(debt.financingCreditsTotal,.01), existingMonthlyDebtService: vfcBankRound_(debt.confirmedMonthlyDebtService,.01),
    informationalRecurringMonthlyObligations: vfcBankRound_(debt.informationalMonthlyObligations,.01), otherRecurringMonthlyObligations: 0,
    debtServiceToDepositsRatio: grossMonthly > 0 ? vfcBankRound_(debt.confirmedMonthlyDebtService/grossMonthly,.0001) : 0,
    debtProfile: debt,
    inputQualityAudit: { modelVersion: VFC_BANK.VERSION, verified: true, selectedStatementRows: months,
      grossAverageMonthlyDeposits: vfcBankRound_(grossMonthly,.01), estimatedOperatingMonthlyDeposits: vfcBankRound_(operatingMonthly,.01), statementAudit: audit, warnings: [] }
  });
}

function vfcBankDebt_(verifiedRows, latest) {
  let payments = [], credits = [];
  (verifiedRows || []).forEach(function(x) { payments = payments.concat(x.payload.paymentCandidates || []); credits = credits.concat(x.payload.financingCredits || []); });
  const monthsInWindow = Math.max(1, (verifiedRows || []).length);
  const confirmedCredits = [], possibleCredits = [];
  credits.forEach(function(c) {
    if (c.classification === 'CONFIRMED' || vfcBankCreditCorrelated_(c,payments)) confirmedCredits.push(Object.assign({},c,{classification:'CONFIRMED'}));
    else possibleCredits.push(c);
  });
  const groups = {};
  payments.forEach(function(p) {
    const family = vfcBankFamily_(p.category), canonical = vfcBankCanon_(p);
    if (!canonical) return;
    const key = family + '|' + canonical;
    if (!groups[key]) groups[key] = { family: family, category: p.category, canonical: canonical, items: [] };
    groups[key].items.push(p);
  });
  const observed = Object.keys(groups).map(function(k) { return vfcBankGroup_(groups[k], latest, monthsInWindow); }).filter(Boolean);
  const hasLoanSweepCredits = confirmedCredits.filter(function(c) { return /\bLOAN\s+CREDIT\b/i.test(c.description); }).length >= 2;
  const revolving = observed.filter(function(x) { return hasLoanSweepCredits && x.family === 'FINANCING' && vfcBankIsGenericLoanSweep_(x); });
  const active = observed.filter(function(x) {
    if (revolving.indexOf(x) >= 0) return false;
    return x.active && x.recurring && (x.family === 'FINANCING' || x.family === 'PAD') && x.confidence !== 'Low';
  });
  const tax = observed.filter(function(x) { return x.active && x.recurring && x.family === 'TAX'; });
  const other = observed.filter(function(x) { return x.active && x.recurring && ['INSURANCE','CREDIT_CARD','OTHER'].indexOf(x.family) >= 0; });
  const confirmedTotal = vfcBankUniqueCreditSum_(confirmedCredits);
  return {
    confirmedMonthlyDebtService: vfcBankRound_(active.reduce(function(s,x){return s+x.monthlyEquivalent;},0),.01),
    informationalMonthlyObligations: vfcBankRound_(tax.concat(other).reduce(function(s,x){return s+x.monthlyEquivalent;},0),.01),
    activeDebtObligations: active,
    revolvingFinancingActivity: revolving,
    taxGovernmentPads: tax,
    otherRecurringObligations: other,
    observedOnce: observed.filter(function(x){return !x.recurring;}),
    allDetectedObligations: observed,
    financingCredits: vfcBankUniqueCredits_(confirmedCredits),
    possibleFinancingCredits: vfcBankUniqueCredits_(possibleCredits),
    financingCreditsTotal: vfcBankRound_(confirmedTotal,.01),
    note: 'Confirmed debt uses actual observed recurring cash outflow. Generic revolving LOAN PAYMENT/LOAN CREDIT sweep activity is shown separately and is not annualized as fixed debt. Credits and debits are direction-locked.'
  };
}

function vfcBankGroup_(group, latest, monthsInWindow) {
  const seen = {}, items = (group.items || []).filter(function(i) {
    const key = i.date + '|' + vfcBankRound_(i.amount,.01); if (seen[key]) return false; seen[key]=1; return true;
  }).sort(function(a,b){ return vfcBankDate_(a.date)-vfcBankDate_(b.date); });
  if (!items.length) return null;
  const dates = items.map(function(i){return vfcBankDate_(i.date);}).filter(Boolean);
  const amounts = items.map(function(i){return i.amount;}).filter(function(a){return a>0;});
  const recurring = dates.length >= 2;
  const first = dates[0], last = dates[dates.length-1];
  const active = recurring && (!latest || ((latest-last)/86400000 >= -3 && (latest-last)/86400000 <= VFC_BANK.ACTIVE_DAYS));
  const firstMonth = first ? new Date(first.getUTCFullYear(), first.getUTCMonth(), 1) : null;
  const latestMonth = latest ? new Date(latest.getUTCFullYear(), latest.getUTCMonth(), 1) : null;
  let exposureMonths = monthsInWindow;
  if (firstMonth && latestMonth) exposureMonths = Math.max(1, Math.min(monthsInWindow, (latestMonth.getUTCFullYear()-firstMonth.getUTCFullYear())*12 + latestMonth.getUTCMonth()-firstMonth.getUTCMonth()+1));
  const monthly = recurring ? vfcBankSum_(amounts)/Math.max(1,exposureMonths) : 0;
  return {
    counterparty: vfcBankBest_(items), description: items[0].description || '', category: group.category, family: group.family,
    paymentAmount: vfcBankRound_(vfcBankMedian_(amounts),.01), frequency: recurring ? vfcBankFrequencyLabel_(dates, exposureMonths) : 'Observed once',
    monthlyEquivalent: vfcBankRound_(monthly,.01), occurrences: dates.length, firstSeen: vfcBankIso_(first), lastSeen: vfcBankIso_(last),
    recurring: recurring, active: active, confidence: vfcBankGroupConf_(items), patternLabel: group.canonical
  };
}

function vfcBankFrequencyLabel_(dates, months) {
  const perMonth = dates.length / Math.max(1,months);
  if (perMonth >= 15) return 'Business daily / high-frequency';
  if (perMonth >= 3.2) return 'Weekly';
  if (perMonth >= 1.5) return 'Biweekly / multiple monthly';
  if (perMonth >= .75) return 'Monthly';
  return 'Irregular';
}

function vfcBankIsGenericLoanSweep_(x) {
  const text = (String(x.description||'') + ' ' + String(x.patternLabel||'')).toUpperCase();
  return /^\s*LOAN\s+PAYMENT\s*$/i.test(String(x.description||'').trim()) || /(^|\s)LOAN($|\s)/.test(text) && x.occurrences >= 4 && x.monthlyEquivalent >= 10000;
}

function vfcBankCreditCorrelated_(credit, payments) {
  if (!credit || !payments || !payments.length) return false;
  const ct = vfcBankTokens_(credit.counterparty + ' ' + credit.description);
  if (!ct.length) return false;
  return payments.some(function(p) {
    if (['LOAN','MCA','FINANCING','PAD'].indexOf(p.category) < 0) return false;
    const pt = vfcBankTokens_(p.counterparty + ' ' + p.description);
    if (!pt.length) return false;
    let common = 0;
    ct.forEach(function(t){ if (pt.indexOf(t)>=0) common++; });
    return common >= 1 && common / Math.min(ct.length,pt.length) >= .5;
  });
}

function vfcBankTokens_(text) {
  return String(text||'').toUpperCase().replace(/MERCHANT/g,'MERCH')
    .replace(/\b(?:INVESTMENT|PAYMENT|PAYMENTS|PYMT|PMT|PAD|EFT|DEBIT|CREDIT|FUNDING|FINANCE|FINANCING|CAPITAL|BUSINESS|THE|INC|LTD|CORP|CORPORATION)\b/g,' ')
    .replace(/[^A-Z0-9]+/g,' ').trim().split(/\s+/).filter(function(t){return t.length>=3;});
}

function vfcBankUniqueCredits_(items) {
  const seen = {}, out = [];
  (items||[]).forEach(function(c){ const k=[c.date,c.amount,c.description.toLowerCase()].join('|'); if(!seen[k]){seen[k]=1;out.push(c);} });
  return out;
}
function vfcBankUniqueCreditSum_(items) { return vfcBankUniqueCredits_(items).reduce(function(s,c){return s+c.amount;},0); }

function vfcBankFamily_(category) {
  const c = String(category||'').toUpperCase();
  if (c==='LOAN'||c==='MCA'||c==='FINANCING') return 'FINANCING';
  if (c==='PAD') return 'PAD'; if (c==='TAX') return 'TAX'; if (c==='INSURANCE') return 'INSURANCE'; if (c==='CREDIT_CARD') return 'CREDIT_CARD'; return 'OTHER';
}

function vfcBankCanon_(item) {
  let text = String((item && (item.counterparty || item.description)) || '').toUpperCase();
  if (item && item.category === 'TAX') {
    if (/\bCRA\b|\bCCRA\b/.test(text)) return 'CRA CCRA TAX'; if (/GST|HST/.test(text)) return 'GST HST TAX'; if (/EMPTX/.test(text)) return 'EMPLOYER TAX'; if (/TXBAL|TXINS/.test(text)) return 'TAX BALANCE';
  }
  text = text.replace(/MERCHANT/g,'MERCH');
  return text.replace(/\b(?:PAYMENT|PAYMENTS|PYMT|PMT|PAD|PAA|APY|MSP|EFT|DEBIT|WITHDRAWAL|PREAUTHORIZED|PRE-AUTHORIZED|INVESTMENT|BUSINESS)\b/g,' ')
    .replace(/\b\d{5,}\b/g,' ').replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim().split(' ').slice(0,8).join(' ');
}

function vfcBankSelected_(company, period) {
  const rows = vfcBankRows_(company, period), map = {};
  rows.forEach(function(r){ const k=vfcBankKey_(r), old=map[k]; if(!old || vfcBankTime_(r.createdAt)>=vfcBankTime_(old.createdAt)) map[k]=r; });
  return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return (vfcBankDate_(a.end)||new Date(0))-(vfcBankDate_(b.end)||new Date(0));}).slice(-VFC_BANK.MAX_STATEMENTS);
}

function vfcBankRows_(company, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues(); if (values.length<2) return [];
  const h=values[0], c={upload:vfcBankCol_(h,'Upload ID'),company:vfcBankCol_(h,'Company Name'),period:vfcBankCol_(h,'Detected Period'),file:vfcBankCol_(h,'File Name'),bank:vfcBankColOpt_(h,'Bank Name'),start:vfcBankCol_(h,'Statement Start Date'),end:vfcBankCol_(h,'Statement End Date'),opening:vfcBankColOpt_(h,'Opening Balance'),closing:vfcBankColOpt_(h,'Closing Balance'),deposits:vfcBankCol_(h,'Total Deposits'),withdrawals:vfcBankCol_(h,'Total Withdrawals'),nsf:vfcBankCol_(h,'NSF Count'),negative:vfcBankCol_(h,'Negative Balance Detected'),signal:vfcBankCol_(h,'Possible MCA Or Loan Payments'),created:vfcBankCol_(h,'Created At')};
  return values.slice(1).map(function(r,i){return {uploadId:r[c.upload],companyName:r[c.company],detectedPeriod:r[c.period],fileName:String(r[c.file]||'statement.pdf'),bank:c.bank>=0?r[c.bank]:'',start:r[c.start],end:r[c.end],opening:c.opening>=0?r[c.opening]:'',closing:c.closing>=0?r[c.closing]:'',totalDeposits:r[c.deposits],totalWithdrawals:r[c.withdrawals],nsfCount:r[c.nsf],negativeBalance:r[c.negative],signal:r[c.signal],createdAt:r[c.created],row:i+2,col:c.signal+1};}).filter(function(r){return (!company||vfcBankSame_(r.companyName,company))&&(!period||vfcBankPeriodSame_(r.detectedPeriod,period));});
}

function vfcBankUploads_() {
  const sheet=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Uploads'); if(!sheet)return{};
  const v=sheet.getDataRange().getValues(); if(v.length<2)return{}; const h=v[0],u=vfcBankCol_(h,'Upload ID'),f=vfcBankCol_(h,'File ID'),out={};
  v.slice(1).forEach(function(r){const id=String(r[u]||'').trim();if(id)out[id]={fileId:String(r[f]||'').trim()};}); return out;
}

function vfcBankNewPayload_(value, requireSignals) {
  const text=String(value||'').trim(); if(text.indexOf(VFC_BANK.PREFIX)!==0)return null;
  try{const p=JSON.parse(text.substring(VFC_BANK.PREFIX.length));return vfcBankPayloadValid_(p,requireSignals)?p:null;}catch(e){return null;}
}
function vfcBankPayloadAt_(row,col,requireSignals){const s=SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');if(!s)return null;return vfcBankNewPayload_(s.getRange(row,col).getValue(),requireSignals);}
function vfcBankPayloadValid_(p,requireSignals){if(!p||!p.verified)return false;const o=vfcBankNull_(p.openingBalance),c=vfcBankNull_(p.closingBalance),d=vfcBankNullPos_(p.totalDeposits),w=vfcBankNullPos_(p.totalWithdrawals);if(o===null||c===null||d===null||w===null)return false;if(Math.abs((o+d-w)-c)>VFC_BANK.RECONCILE_TOLERANCE)return false;if(requireSignals&&!p.signalsVerified)return false;return true;}
function vfcBankWrite_(sheet,row,p){sheet.getRange(row.row,row.col).setValue(VFC_BANK.PREFIX+JSON.stringify(p));}
function vfcBankKey_(row){return [String(row.companyName||'').trim().toLowerCase(),vfcBankIso_(row.start),vfcBankIso_(row.end)].join('|');}
function vfcBankBest_(items){const c={};(items||[]).forEach(function(i){const t=String(i.counterparty||i.description||'').trim();if(t)c[t]=(c[t]||0)+1;});const k=Object.keys(c).sort(function(a,b){return c[b]!==c[a]?c[b]-c[a]:a.length-b.length;});return k.length?k[0]:'Recurring Payment';}
function vfcBankGroupConf_(items){if(!items||!items.length)return'Low';const s=items.reduce(function(t,i){return t+(i.confidence==='High'?2:i.confidence==='Moderate'?1:0);},0)/items.length;return s>=1.5?'High':s>=.75?'Moderate':'Low';}
function vfcBankOutput_(body){if(body&&typeof body.output_text==='string'&&body.output_text)return body.output_text;const o=body&&Array.isArray(body.output)?body.output:[];for(let i=0;i<o.length;i++){const c=Array.isArray(o[i].content)?o[i].content:[];for(let j=0;j<c.length;j++)if(c[j]&&typeof c[j].text==='string'&&c[j].text)return c[j].text;}return'';}
function vfcBankReq_(value,requestedPeriod){let company='',period=requestedPeriod||'';if(value&&typeof value==='object'){company=value.companyName||value.company||'';period=value.period||value.detectedPeriod||period;}else company=value||'';company=String(company||'').trim();period=String(period||'').trim();if(!company)throw new Error('Company name is required.');return{companyName:company,period:period};}
function vfcBankCol_(h,w){const i=vfcBankColOpt_(h,w);if(i<0)throw new Error('Missing required column: '+w);return i;}
function vfcBankColOpt_(h,w){const t=String(w||'').toLowerCase().replace(/[^a-z0-9]/g,'');for(let i=0;i<h.length;i++)if(String(h[i]||'').toLowerCase().replace(/[^a-z0-9]/g,'')===t)return i;return-1;}
function vfcBankDate_(v){if(!v)return null;const d=v instanceof Date?v:new Date(v);return isNaN(d.getTime())?null:d;}
function vfcBankIso_(v){const d=vfcBankDate_(v);return d?Utilities.formatDate(d,'UTC','yyyy-MM-dd'):'';}
function vfcBankNull_(v){if(v===''||v===null||v===undefined)return null;const t=String(v).trim();if(!t)return null;let n=vfcBankNum_(t);if(/OD$/i.test(t))n=-Math.abs(n);return isFinite(n)?n:null;}
function vfcBankNullPos_(v){const n=vfcBankNull_(v);return n!==null&&n>=0?n:null;}
function vfcBankNum_(v){if(typeof v==='number')return isFinite(v)?v:0;const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,''));return isFinite(n)?n:0;}
function vfcBankPos_(v){return Math.max(0,vfcBankNum_(v));}
function vfcBankArr_(v){return Array.isArray(v)?v.map(vfcBankPos_).filter(function(n){return isFinite(n)&&n>=0;}):[];}
function vfcBankRound_(v,step){const inc=vfcBankNum_(step)||1;return Math.round(vfcBankNum_(v)/inc)*inc;}
function vfcBankSum_(items){return(items||[]).reduce(function(s,i){return s+vfcBankNum_(i);},0);}
function vfcBankMedian_(items){const n=(items||[]).map(vfcBankNum_).filter(function(x){return isFinite(x)&&x>=0;}).sort(function(a,b){return a-b;});if(!n.length)return 0;const m=Math.floor(n.length/2);return n.length%2?n[m]:(n[m-1]+n[m])/2;}
function vfcBankCv_(items){const n=(items||[]).map(vfcBankNum_).filter(function(x){return x>=0;});if(!n.length)return 1;const a=vfcBankSum_(n)/n.length;if(!a)return 1;return Math.sqrt(n.reduce(function(s,x){return s+Math.pow(x-a,2);},0)/n.length)/a;}
function vfcBankTrend_(items){const n=(items||[]).map(vfcBankNum_);if(n.length<2)return 0;const sp=Math.max(1,Math.floor(n.length/2)),f=n.slice(0,sp),s=n.slice(sp),fa=vfcBankSum_(f)/f.length,sa=s.length?vfcBankSum_(s)/s.length:fa;return fa>0?(sa-fa)/fa:0;}
function vfcBankConf_(v){const t=String(v||'').trim().toLowerCase();return t==='high'?'High':t==='low'?'Low':'Moderate';}
function vfcBankFlag_(v){return/^(1|true|yes|detected)$/i.test(String(v||'').trim());}
function vfcBankSame_(a,b){return String(a==null?'':a).trim().toLowerCase()===String(b==null?'':b).trim().toLowerCase();}
function vfcBankPeriodSame_(a,b){const c=function(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');};return c(a)===c(b);}
function vfcBankTime_(v){const d=vfcBankDate_(v);return d?d.getTime():0;}
