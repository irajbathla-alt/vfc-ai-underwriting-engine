const VFC_BANKING_PURE = {
  VERSION: 'VFC-BANKING-PURE-2.0',
  PREFIX: 'VFC_BANK_PURE_V2:',
  LOOKBACK_STATEMENTS: 6,
  LATEST_BATCH_GAP_MINUTES: 15,
  MIN_RECURRING_OCCURRENCES: 2,
  MIN_FINANCING_CREDIT: 1000
};

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANKING_PURE.VERSION,
    automatic: true,
    manualRefreshRequired: false,
    bankAgnostic: true,
    usesIntakeHeaderTotals: true,
    transactionDirectionLocked: true,
    recurringDebtUsesObservedCashflow: true,
    revolvingSweepSeparated: true,
    historicalTrainingPdfReprocessingRequired: false
  };
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcPureRequest_(companyOrRequest, requestedPeriod);
    const period = req.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(req.companyName, req.period)
      : req.period);
    const rows = vfcPureSelectedRows_(req.companyName, period);
    if (!rows.length) throw new Error('No uploaded bank statements found for this company and period.');
    const ensured = vfcPureEnsureTransactions_(rows);
    const debtProfile = vfcPureDebtProfile_(rows);
    return {
      ok: true,
      modelVersion: VFC_BANKING_PURE.VERSION,
      companyName: req.companyName,
      period: period,
      filesAnalyzed: ensured.analyzed,
      filesReused: ensured.reused,
      errors: ensured.warnings,
      debtProfile: debtProfile
    };
  } catch (error) {
    return {
      ok: false,
      modelVersion: VFC_BANKING_PURE.VERSION,
      errors: [String(error && error.message || error)]
    };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcPureReadSummaryRows_('', '');
  if (!rows.length) throw new Error('PDF Summaries has no records.');
  rows.sort(function(a,b){ return vfcPureTime_(a.createdAt) - vfcPureTime_(b.createdAt); });
  const last = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({ companyName: last.companyName, period: last.detectedPeriod });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = typeof buildPowerFeatures_ === 'function'
    ? buildPowerFeatures_(companyName, period)
    : (typeof buildFeaturesForCase_ === 'function' ? buildFeaturesForCase_(companyName, period) : null);
  if (!base) return null;

  const rows = vfcPureSelectedRows_(companyName, period);
  if (!rows.length) return base;

  const ensured = vfcPureEnsureTransactions_(rows);
  const debt = vfcPureDebtProfile_(rows);

  const totalDeposits = rows.reduce(function(s,r){ return s + vfcPureNumber_(r.totalDeposits); },0);
  const totalWithdrawals = rows.reduce(function(s,r){ return s + vfcPureNumber_(r.totalWithdrawals); },0);
  const monthlyDeposits = rows.map(function(r){ return vfcPureNumber_(r.totalDeposits); });
  const monthlyWithdrawals = rows.map(function(r){ return vfcPureNumber_(r.totalWithdrawals); });
  const months = Math.max(1, rows.length);
  const grossMonthly = totalDeposits / months;
  const operatingTotal = Math.max(0, totalDeposits - debt.financingCreditsTotal);
  const operatingMonthly = operatingTotal / months;
  const nsfCount = rows.reduce(function(s,r){ return s + Math.max(0, vfcPureNumber_(r.nsfCount)); },0);
  const negative = rows.some(function(r){ return vfcPureFlag_(r.negativeBalanceDetected); }) ? 1 : 0;
  const warnings = ensured.warnings.slice();
  if (debt.revolvingFinancingActivity.length) {
    warnings.push('Generic loan draw/repayment sweep activity was separated from fixed recurring debt.');
  }
  if (debt.possibleFinancingCredits.length) {
    warnings.push('Possible financing credits are shown separately and are not deducted from operating deposits unless confirmed.');
  }

  return Object.assign({}, base, {
    statementCount: rows.length,
    monthsCovered: rows.length,
    totalDeposits: vfcPureRound_(totalDeposits, .01),
    averageMonthlyDeposits: vfcPureRound_(grossMonthly, .01),
    totalWithdrawals: vfcPureRound_(totalWithdrawals, .01),
    depositWithdrawalRatio: totalWithdrawals > 0 ? vfcPureRound_(totalDeposits / totalWithdrawals, .01) : 0,
    nsfCount: nsfCount,
    nsfPerMonth: vfcPureRound_(nsfCount / months, .01),
    negativeBalanceFlag: negative,
    mcaPaymentFlag: debt.activeDebtObligations.length ? 1 : 0,
    monthlyDeposits: monthlyDeposits,
    monthlyWithdrawals: monthlyWithdrawals,
    depositVolatility: vfcPureRound_(vfcPureCv_(monthlyDeposits), .01),
    depositTrend: vfcPureRound_(vfcPureTrend_(monthlyDeposits), .01),
    estimatedOperatingTotalDeposits: vfcPureRound_(operatingTotal, .01),
    estimatedOperatingMonthlyDeposits: vfcPureRound_(operatingMonthly, .01),
    detectedFinancingCredits: vfcPureRound_(debt.financingCreditsTotal, .01),
    existingMonthlyDebtService: vfcPureRound_(debt.confirmedMonthlyDebtService, .01),
    informationalRecurringMonthlyObligations: vfcPureRound_(debt.informationalMonthlyObligations, .01),
    otherRecurringMonthlyObligations: vfcPureRound_(debt.informationalMonthlyObligations, .01),
    debtServiceToDepositsRatio: grossMonthly > 0 ? vfcPureRound_(debt.confirmedMonthlyDebtService / grossMonthly, .0001) : 0,
    debtProfile: debt,
    inputQualityAudit: {
      modelVersion: VFC_BANKING_PURE.VERSION,
      verified: true,
      selectedStatementRows: rows.length,
      grossAverageMonthlyDeposits: vfcPureRound_(grossMonthly, .01),
      estimatedOperatingMonthlyDeposits: vfcPureRound_(operatingMonthly, .01),
      statementAudit: rows.map(function(r){
        return {
          fileName: r.fileName,
          bank: r.bankName,
          statementStartDate: vfcPureIso_(r.statementStartDate),
          statementEndDate: vfcPureIso_(r.statementEndDate),
          totalDeposits: vfcPureNumber_(r.totalDeposits),
          totalWithdrawals: vfcPureNumber_(r.totalWithdrawals),
          source: 'INTAKE_HEADER_TOTALS'
        };
      }),
      warnings: warnings
    }
  });
}

function vfcPureEnsureTransactions_(rows) {
  const summarySheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!summarySheet) throw new Error('Missing PDF Summaries sheet.');
  const uploadRows = vfcPureUploadRows_();
  let analyzed = 0, reused = 0;
  const warnings = [];

  rows.forEach(function(row) {
    const existing = vfcPureParsePayload_(row.signalText);
    if (existing && existing.version === 2 && Array.isArray(existing.transactions)) {
      reused++;
      return;
    }

    const upload = vfcPureResolveUpload_(row, uploadRows);
    if (!upload || !upload.fileId) {
      warnings.push(row.fileName + ': original PDF could not be resolved; intake totals remain usable but transaction-level debt signals were unavailable.');
      const fallback = vfcPureFallbackPayload_(row);
      vfcPureWritePayload_(summarySheet, row, fallback);
      return;
    }

    try {
      const text = extractTextFromPdf_(upload.fileId);
      const payload = vfcPureExtractFacts_(text, row);
      vfcPureWritePayload_(summarySheet, row, payload);
      analyzed++;
    } catch (e) {
      warnings.push(row.fileName + ': transaction extraction failed; intake totals remain usable. ' + String(e && e.message || e));
      const fallback = vfcPureFallbackPayload_(row);
      vfcPureWritePayload_(summarySheet, row, fallback);
    }
  });

  return { analyzed: analyzed, reused: reused, warnings: warnings };
}

function vfcPureExtractFacts_(text, row) {
  const prompt = [
    'You are reading a Canadian business bank statement. Return JSON only.',
    'Do NOT underwrite. Do NOT infer monthly debt. Do NOT decide recurrence.',
    'Extract only transaction facts relevant to financing and recurring obligations.',
    '',
    'Return this object:',
    '{"transactions":[{"date":"YYYY-MM-DD","description":"exact readable description","counterparty":"normalized counterparty if clear, otherwise description","direction":"DEBIT or CREDIT","amount":123.45,"kind":"FINANCING|TAX|INSURANCE|CREDIT_CARD|OPERATING|UNKNOWN","confidence":"High|Moderate|Low"}]}',
    '',
    'Rules:',
    '1. Direction is mandatory. A deposit/credit must be CREDIT. A payment/withdrawal must be DEBIT.',
    '2. Include every visible LOAN PAYMENT, LOAN CREDIT, loan advance, financing payment, MCA payment, PAD, tax/government PAD, insurance finance payment, and clearly financing-related credit.',
    '3. A transaction labelled LOAN CREDIT is CREDIT and FINANCING.',
    '4. A transaction labelled LOAN PAYMENT is DEBIT and FINANCING.',
    '5. Merchant/MCA/PAD repayment debits are FINANCING when they are clearly financing-related.',
    '6. Funding proceeds from a lender/funder are CREDIT and FINANCING.',
    '7. CRA/CCRA/GST/HST/payroll tax/government remittances are DEBIT and TAX.',
    '8. Insurance/IPFS/premium finance debits are INSURANCE.',
    '9. Gas/fuel/Superpass/Hydro/Fortis/Telus/utilities/suppliers/payroll/ordinary Interac/ATM are OPERATING, not financing.',
    '10. Never move an amount from one row to another transaction.',
    '11. If the transaction is ambiguous, use UNKNOWN instead of guessing.',
    '12. Normalize the same counterparty consistently across the statement when obvious (example: MERCH PAD and Merchant Growth -> Merchant Growth only if the relationship is clear from the text).',
    '',
    'Known statement dates: ' + vfcPureIso_(row.statementStartDate) + ' to ' + vfcPureIso_(row.statementEndDate),
    'STATEMENT TEXT:',
    String(text || '').substring(0, 90000)
  ].join('\n');

  const raw = callOpenAIJson_(prompt) || {};
  const tx = Array.isArray(raw.transactions) ? raw.transactions : [];
  return {
    version: 2,
    modelVersion: VFC_BANKING_PURE.VERSION,
    analyzedAt: new Date().toISOString(),
    fileName: row.fileName,
    statementStartDate: vfcPureIso_(row.statementStartDate),
    statementEndDate: vfcPureIso_(row.statementEndDate),
    transactions: vfcPureNormalizeTransactions_(tx)
  };
}

function vfcPureNormalizeTransactions_(items) {
  const out = [], seen = {};
  (items || []).forEach(function(item) {
    item = item || {};
    const direction = String(item.direction || '').toUpperCase();
    if (direction !== 'DEBIT' && direction !== 'CREDIT') return;
    const amount = Math.abs(vfcPureNumber_(item.amount));
    const date = vfcPureIso_(item.date);
    const description = String(item.description || '').trim();
    if (!date || !description || !(amount > 0)) return;
    let kind = String(item.kind || 'UNKNOWN').toUpperCase();
    if (['FINANCING','TAX','INSURANCE','CREDIT_CARD','OPERATING','UNKNOWN'].indexOf(kind) < 0) kind = 'UNKNOWN';

    const upper = description.toUpperCase();
    if (/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|FUEL|PETROLEUM/.test(upper)) kind = 'OPERATING';
    if (/\bCRA\b|\bCCRA\b|GST|HST|EMPTX|TXBAL|TXINS|COMMERCIAL\s+TAX/.test(upper)) kind = 'TAX';
    if (/\bINSURANCE\b|\bIPFS\b|PREMIUM\s+FIN/.test(upper)) kind = 'INSURANCE';
    if (/CREDIT\s+CARD|VISA\s+ROYAL|VISA\s+TD/.test(upper)) kind = 'CREDIT_CARD';
    if (/\bLOAN\s+CREDIT\b/.test(upper)) { kind = 'FINANCING'; }
    if (/\bLOAN\s+PAYMENT\b|LOAN\s+PYMT|\bMCA\b|MERCH\s+PAD|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bBDC\b/.test(upper) && direction === 'DEBIT') kind = 'FINANCING';

    const counterparty = vfcPureNormalizeCounterparty_(String(item.counterparty || description), description);
    const confidence = /high/i.test(String(item.confidence || '')) ? 'High' : (/moderate/i.test(String(item.confidence || '')) ? 'Moderate' : 'Low');
    const n = { date: date, description: description.substring(0,180), counterparty: counterparty.substring(0,120), direction: direction, amount: vfcPureRound_(amount,.01), kind: kind, confidence: confidence };
    const key = [n.date,n.direction,n.amount,n.description.toLowerCase()].join('|');
    if (!seen[key]) { seen[key] = 1; out.push(n); }
  });
  return out;
}

function vfcPureNormalizeCounterparty_(counterparty, description) {
  let s = String(counterparty || description || '').toUpperCase();
  s = s.replace(/INVESTMENT|BUSINESS\s+PAD|MISC\s+PAYMENT|LOAN\s+PAYMENT|LOAN\s+PYMT|LOAN\s+CREDIT|PAYMENT|PAD|DEBIT|CREDIT|NO\.?\s*\d+/g,' ');
  s = s.replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  if (/MERCH|MERCHANT\s+GROWTH/.test(s)) return 'Merchant Growth';
  if (/JOURNEY|ONDECK/.test(s)) return 'Journey/OnDeck';
  if (/\bBDC\b/.test(s)) return 'BDC';
  if (!s) return String(description || '').trim();
  return s;
}

function vfcPureDebtProfile_(rows) {
  const recent = rows.slice(Math.max(0, rows.length - VFC_BANKING_PURE.LOOKBACK_STATEMENTS));
  const statementKeys = recent.map(function(r){ return vfcPureStatementKey_(r); });
  let transactions = [];
  recent.forEach(function(row) {
    const p = vfcPureParsePayload_(row.signalText) || vfcPureFallbackPayload_(row);
    (p.transactions || []).forEach(function(t) {
      transactions.push(Object.assign({ statementKey: vfcPureStatementKey_(row) }, t));
    });
  });

  const financingCreditsRaw = transactions.filter(function(t){ return t.direction === 'CREDIT' && t.kind === 'FINANCING'; });
  const confirmedCredits = [], possibleCredits = [];
  financingCreditsRaw.forEach(function(c) {
    if (vfcPureCreditConfirmed_(c, transactions)) confirmedCredits.push(c); else possibleCredits.push(c);
  });

  const financingDebits = transactions.filter(function(t){ return t.direction === 'DEBIT' && t.kind === 'FINANCING'; });
  const taxDebits = transactions.filter(function(t){ return t.direction === 'DEBIT' && t.kind === 'TAX'; });
  const otherDebits = transactions.filter(function(t){ return t.direction === 'DEBIT' && (t.kind === 'INSURANCE' || t.kind === 'CREDIT_CARD'); });

  const groups = vfcPureGroupTransactions_(financingDebits);
  const taxGroups = vfcPureGroupTransactions_(taxDebits);
  const otherGroups = vfcPureGroupTransactions_(otherDebits);

  const hasRepeatedLoanCredits = confirmedCredits.filter(function(c){ return /\bLOAN\s+CREDIT\b/i.test(c.description); }).length >= 2;
  const active = [], revolving = [], observedOnce = [];

  groups.forEach(function(g) {
    const summary = vfcPureSummarizeGroup_(g, statementKeys);
    if (hasRepeatedLoanCredits && vfcPureGenericLoanSweep_(summary)) {
      revolving.push(summary);
    } else if (summary.recurring && summary.confidence !== 'Low') {
      active.push(summary);
    } else {
      observedOnce.push(summary);
    }
  });

  const tax = taxGroups.map(function(g){ return vfcPureSummarizeGroup_(g, statementKeys); }).filter(function(x){ return x.recurring; });
  const other = otherGroups.map(function(g){ return vfcPureSummarizeGroup_(g, statementKeys); }).filter(function(x){ return x.recurring; });

  const financingCredits = vfcPureUniqueCredits_(confirmedCredits);
  const possibleFinancingCredits = vfcPureUniqueCredits_(possibleCredits);
  const financingCreditsTotal = financingCredits.reduce(function(s,c){ return s + c.amount; },0);
  const debtTotal = active.reduce(function(s,x){ return s + x.monthlyEquivalent; },0);
  const infoTotal = tax.concat(other).reduce(function(s,x){ return s + x.monthlyEquivalent; },0);

  return {
    confirmedMonthlyDebtService: vfcPureRound_(debtTotal,.01),
    informationalMonthlyObligations: vfcPureRound_(infoTotal,.01),
    activeDebtObligations: active,
    revolvingFinancingActivity: revolving,
    taxGovernmentPads: tax,
    otherRecurringObligations: other,
    observedOnce: observedOnce,
    allDetectedObligations: active.concat(revolving, observedOnce, tax, other),
    financingCredits: financingCredits,
    possibleFinancingCredits: possibleFinancingCredits,
    financingCreditsTotal: vfcPureRound_(financingCreditsTotal,.01),
    note: 'Debt is calculated from actual observed debit cashflow. Credits never become debt payments. Generic loan sweep activity is displayed separately.'
  };
}

function vfcPureGroupTransactions_(items) {
  const map = {};
  (items || []).forEach(function(t) {
    const key = vfcPureGroupKey_(t);
    if (!key) return;
    if (!map[key]) map[key] = { key:key, items:[] };
    map[key].items.push(t);
  });
  return Object.keys(map).map(function(k){ return map[k]; });
}

function vfcPureGroupKey_(t) {
  const d = String(t.description || '').toUpperCase();
  if (/LOAN\s+PAYMENT\s+NO\.?\s*([0-9]+)/.test(d)) return 'LOANNO|' + RegExp.$1;
  if (/LOAN\s+PYMT\s+LOAN\s*([0-9]+)/.test(d)) return 'LOANNO|' + RegExp.$1;
  const c = String(t.counterparty || '').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
  if (c) return t.kind + '|' + c;
  return t.kind + '|' + d.replace(/[0-9.,$]+/g,' ').replace(/[^A-Z]+/g,' ').replace(/\s+/g,' ').trim();
}

function vfcPureSummarizeGroup_(group, statementKeys) {
  const items = (group.items || []).slice().sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
  const perStatement = {};
  items.forEach(function(i){ perStatement[i.statementKey] = (perStatement[i.statementKey] || 0) + i.amount; });
  const statementTotals = Object.keys(perStatement).map(function(k){ return perStatement[k]; });
  const occurrences = items.length;
  const recurring = occurrences >= VFC_BANKING_PURE.MIN_RECURRING_OCCURRENCES && Object.keys(perStatement).length >= 2;
  const monthlyEquivalent = recurring ? statementTotals.reduce(function(s,v){return s+v;},0) / statementTotals.length : 0;
  const amounts = items.map(function(i){return i.amount;}).sort(function(a,b){return a-b;});
  const paymentAmount = amounts.length ? amounts[Math.floor(amounts.length/2)] : 0;
  const conf = items.some(function(i){return i.confidence === 'High';}) ? 'High' : (items.some(function(i){return i.confidence === 'Moderate';}) ? 'Moderate' : 'Low');
  const first = items[0] || {}, last = items[items.length-1] || {};
  const category = first.kind === 'FINANCING' ? (/MERCH|JOURNEY|ONDECK|MCA/i.test(first.counterparty + ' ' + first.description) ? 'MCA' : 'FINANCING') : first.kind;
  return {
    counterparty: first.counterparty || first.description || 'Detected obligation',
    description: first.description || '',
    category: category,
    paymentAmount: vfcPureRound_(paymentAmount,.01),
    frequency: recurring ? 'Observed across ' + Object.keys(perStatement).length + ' statement months' : 'Observed once / insufficient history',
    monthlyEquivalent: vfcPureRound_(monthlyEquivalent,.01),
    occurrences: occurrences,
    firstSeen: first.date || '',
    lastSeen: last.date || '',
    recurring: recurring,
    active: true,
    confidence: conf,
    observedMonthlyTotals: perStatement
  };
}

function vfcPureGenericLoanSweep_(summary) {
  const d = String(summary.description || '').toUpperCase();
  const c = String(summary.counterparty || '').toUpperCase();
  return /^LOAN\s+PAYMENT$/.test(d.trim()) || (c === 'LOAN' && !/NO\.?\s*\d+/.test(d));
}

function vfcPureCreditConfirmed_(credit, allTx) {
  const d = String(credit.description || '').toUpperCase();
  if (/\bLOAN\s+CREDIT\b|LOAN\s+ADVANCE|FUNDING|FINANC|CASH\s+ADVANCE|\bMCA\b/.test(d)) return true;
  if (credit.amount < VFC_BANKING_PURE.MIN_FINANCING_CREDIT) return false;
  const c = vfcPureCanonParty_(credit.counterparty);
  if (!c) return credit.confidence === 'High';
  const relatedDebit = (allTx || []).some(function(t){
    return t.direction === 'DEBIT' && t.kind === 'FINANCING' && vfcPurePartyRelated_(c, vfcPureCanonParty_(t.counterparty));
  });
  return relatedDebit && credit.confidence !== 'Low';
}

function vfcPureCanonParty_(value) {
  return String(value || '').toUpperCase().replace(/INVESTMENT|BUSINESS|PAD|PAYMENT|CREDIT|DEBIT|FUNDING|LOAN/g,' ').replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}

function vfcPurePartyRelated_(a,b) {
  if (!a || !b) return false;
  if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  const aa = a.split(' ').filter(function(x){return x.length >= 4;});
  const bb = b.split(' ').filter(function(x){return x.length >= 4;});
  return aa.some(function(x){ return bb.indexOf(x) >= 0; });
}

function vfcPureUniqueCredits_(items) {
  const seen = {}, out = [];
  (items || []).forEach(function(c){
    const key = [c.date,vfcPureRound_(c.amount,.01),String(c.description||'').toLowerCase()].join('|');
    if (!seen[key]) { seen[key]=1; out.push(c); }
  });
  return out;
}

function vfcPureSelectedRows_(companyName, period) {
  const all = vfcPureReadSummaryRows_(companyName, period);
  if (!all.length) return [];
  all.sort(function(a,b){ return vfcPureTime_(a.createdAt) - vfcPureTime_(b.createdAt); });
  const latest = all[all.length - 1];
  const latestTime = vfcPureTime_(latest.createdAt);
  let batch = all.filter(function(r){
    const t = vfcPureTime_(r.createdAt);
    return latestTime && t && Math.abs(latestTime - t) <= VFC_BANKING_PURE.LATEST_BATCH_GAP_MINUTES * 60000;
  });
  if (batch.length < 2) batch = all;
  const byStatement = {};
  batch.forEach(function(r){
    const key = vfcPureStatementKey_(r);
    if (!byStatement[key] || vfcPureTime_(r.createdAt) >= vfcPureTime_(byStatement[key].createdAt)) byStatement[key] = r;
  });
  return Object.keys(byStatement).map(function(k){return byStatement[k];}).sort(function(a,b){
    return vfcPureDateTime_(a.statementEndDate) - vfcPureDateTime_(b.statementEndDate);
  });
}

function vfcPureReadSummaryRows_(companyName, period) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PDF Summaries');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function(h){return vfcPureHeader_(h);});
  const col = {};
  headers.forEach(function(h,i){ col[h] = i; });
  const signalCol = col.possibleMcaOrLoanPayments !== undefined ? col.possibleMcaOrLoanPayments + 1 : 16;
  return values.slice(1).map(function(v,idx){
    const r = {};
    headers.forEach(function(h,i){ r[h] = v[i]; });
    r.rowNumber = idx + 2;
    r.signalColumn = signalCol;
    r.signalText = v[signalCol-1] || '';
    return r;
  }).filter(function(r){
    if (companyName && !vfcPureSame_(r.companyName, companyName)) return false;
    if (period && !vfcPureSame_(r.detectedPeriod, period)) return false;
    return String(r.fileName || '').trim() !== '';
  });
}

function vfcPureUploadRows_() {
  if (typeof getSheetObjects_ === 'function') return getSheetObjects_('Uploads');
  return [];
}

function vfcPureResolveUpload_(row, uploads) {
  const candidates = (uploads || []).map(function(u){
    let score = 0;
    if (row.uploadId && u.uploadId && String(row.uploadId) === String(u.uploadId)) score += 100;
    if (vfcPureSame_(row.fileName,u.fileName)) score += 60;
    if (vfcPureSame_(row.companyName,u.companyName)) score += 25;
    if (vfcPureSame_(row.detectedPeriod,u.detectedPeriod)) score += 15;
    return { row:u, score:score, time:vfcPureTime_(u.createdAt) };
  }).filter(function(x){ return x.score >= 60 && x.row && x.row.fileId; });
  candidates.sort(function(a,b){ return b.score - a.score || b.time - a.time; });
  return candidates.length ? candidates[0].row : null;
}

function vfcPureWritePayload_(sheet, row, payload) {
  sheet.getRange(row.rowNumber, row.signalColumn).setValue(VFC_BANKING_PURE.PREFIX + JSON.stringify(payload));
  row.signalText = VFC_BANKING_PURE.PREFIX + JSON.stringify(payload);
}

function vfcPureParsePayload_(value) {
  const s = String(value || '');
  if (s.indexOf(VFC_BANKING_PURE.PREFIX) !== 0) return null;
  try { return JSON.parse(s.substring(VFC_BANKING_PURE.PREFIX.length)); } catch(e) { return null; }
}

function vfcPureFallbackPayload_(row) {
  return { version:2, modelVersion:VFC_BANKING_PURE.VERSION, analyzedAt:new Date().toISOString(), fileName:row.fileName,
    statementStartDate:vfcPureIso_(row.statementStartDate), statementEndDate:vfcPureIso_(row.statementEndDate), transactions:[] };
}

function vfcPureRequest_(companyOrRequest, requestedPeriod) {
  if (companyOrRequest && typeof companyOrRequest === 'object') return { companyName:String(companyOrRequest.companyName||'').trim(), period:String(companyOrRequest.period||requestedPeriod||'').trim() };
  return { companyName:String(companyOrRequest||'').trim(), period:String(requestedPeriod||'').trim() };
}

function vfcPureStatementKey_(row) {
  const a = vfcPureIso_(row.statementStartDate), b = vfcPureIso_(row.statementEndDate);
  return a && b ? a + '|' + b : String(row.fileName || '').trim().toLowerCase();
}

function vfcPureHeader_(header) {
  return String(header || '').trim().replace(/[^a-zA-Z0-9]+(.)/g,function(_,c){return c.toUpperCase();}).replace(/^[A-Z]/,function(c){return c.toLowerCase();});
}
function vfcPureSame_(a,b){ return String(a||'').trim().toLowerCase() === String(b||'').trim().toLowerCase(); }
function vfcPureNumber_(v){ if(typeof v==='number') return isFinite(v)?v:0; const n=parseFloat(String(v||'').replace(/[^0-9.\-]/g,'')); return isFinite(n)?n:0; }
function vfcPureFlag_(v){ return /yes|true|detected|negative|1/i.test(String(v||'')); }
function vfcPureRound_(v,step){ const s=step||1; return Math.round((Number(v)||0)/s)*s; }
function vfcPureTime_(v){ const d=new Date(v); return isNaN(d.getTime())?0:d.getTime(); }
function vfcPureDateTime_(v){ const d=new Date(v); return isNaN(d.getTime())?0:d.getTime(); }
function vfcPureIso_(v){ if(!v) return ''; const d=new Date(v); if(isNaN(d.getTime())) return String(v).substring(0,10); return Utilities.formatDate(d,Session.getScriptTimeZone(),'yyyy-MM-dd'); }
function vfcPureCv_(values){ const a=(values||[]).map(Number).filter(function(x){return isFinite(x)&&x>=0;}); if(a.length<2) return 0; const m=a.reduce(function(s,x){return s+x;},0)/a.length; if(!m) return 0; const variance=a.reduce(function(s,x){return s+Math.pow(x-m,2);},0)/a.length; return Math.sqrt(variance)/m; }
function vfcPureTrend_(values){ const a=(values||[]).map(Number).filter(function(x){return isFinite(x);}); if(a.length<2) return 0; const first=a.slice(0,Math.ceil(a.length/2)).reduce(function(s,x){return s+x;},0)/Math.ceil(a.length/2); const second=a.slice(Math.floor(a.length/2)).reduce(function(s,x){return s+x;},0)/(a.length-Math.floor(a.length/2)); return first ? (second-first)/first : 0; }
