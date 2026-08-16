/**
 * VFC AI Underwriting Engine — Banked Banking Input Quality Engine v2
 *
 * Drop-in replacement for BankingInputQuality_PURE_v1.gs.
 * Public entry points and the existing upload/PDF Summaries flow are preserved.
 *
 * Design goals:
 *  1) Bank-specific adapters so RBC logic never leaks into TD/Scotia/BMO/CIBC/Coast Capital.
 *  2) Stable facts cache: the same statement is not re-read by OpenAI every run.
 *  3) Deterministic post-extraction underwriting math.
 *  4) Amount + cadence obligation fingerprinting.
 *  5) Same-name / different-amount splitting and different-name / same-amount merging support.
 *  6) Financing-credit-to-payment-stream correlation.
 *  7) No fake monthly equivalents for stale / incomplete informational items.
 *  8) Bank training tabs for the next phases.
 */

const VFC_BANK_ENGINE = {
  VERSION: 'VFC-BANKING-BANKED-2.0',
  FACTS_VERSION: 'VFC-BANK-FACTS-1.0',
  RULES_VERSION: 'VFC-BANK-RULES-2.0',
  CACHE_PREFIX: 'VFC_BANK_FACTS_V1:',
  LEGACY_CACHE_PREFIXES: ['VFC_BANK_PURE_V1:'],
  MAX_STATEMENTS: 12,
  DEBT_LOOKBACK: 6,
  RECONCILE_TOLERANCE: 5,
  ACTIVE_DAYS: 75,
  MAX_TEXT_CHARS: 70000,
  BANKS: [
    { id:'RBC', label:'RBC', status:'LOCKED', aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC'] },
    { id:'TD', label:'TD', status:'READY_FOR_TRAINING', aliases:['TD CANADA TRUST','TORONTO-DOMINION','TD BANK','TD'] },
    { id:'SCOTIA', label:'Scotia', status:'READY_FOR_TRAINING', aliases:['SCOTIABANK','BANK OF NOVA SCOTIA','SCOTIA'] },
    { id:'BMO', label:'BMO', status:'READY_FOR_TRAINING', aliases:['BANK OF MONTREAL','BMO'] },
    { id:'CIBC', label:'CIBC', status:'READY_FOR_TRAINING', aliases:['CANADIAN IMPERIAL BANK OF COMMERCE','CIBC'] },
    { id:'COAST_CAPITAL', label:'Coast Capital', status:'READY_FOR_TRAINING', aliases:['COAST CAPITAL SAVINGS','COAST CAPITAL'] }
  ]
};

// Backwards-compatible constant name for any code that still references it.
const VFC_BANK_SIMPLE = VFC_BANK_ENGINE;

function getBankingInputQualityStatus() {
  return {
    modelVersion: VFC_BANK_ENGINE.VERSION,
    factsVersion: VFC_BANK_ENGINE.FACTS_VERSION,
    rulesVersion: VFC_BANK_ENGINE.RULES_VERSION,
    automatic: true,
    bankAgnostic: false,
    bankSpecificAdapters: true,
    manualRefreshRequired: false,
    partialResultsAllowed: false,
    historicalTrainingPdfReprocessingRequired: false,
    deterministicDerivedResults: true,
    stableStatementFactsCache: true,
    methodology: 'Bank-specific fact extraction + frozen statement facts + deterministic amount/cadence obligation fingerprinting',
    banks: getBankParserTabs()
  };
}

/** Returns metadata the web UI can render as bank tabs. */
function getBankParserTabs() {
  return VFC_BANK_ENGINE.BANKS.map(function(b) {
    return {
      id:b.id,
      label:b.label,
      status:b.status,
      active:b.id === 'RBC',
      rulesVersion:b.id === 'RBC' ? 'RBC-2.0' : 'UNTRAINED'
    };
  });
}

/**
 * Creates isolated Google Sheet training tabs without changing the upload flow.
 * Safe to run repeatedly: existing tab contents are preserved.
 */
function setupBankTrainingTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = [
    'Bank','Training Status','Parser / Rules Version','Statement Format Notes',
    'Debit Markers','Credit Markers','Financing Keywords','Recurring Payment Notes',
    'Test Company','Test Period','Expected Gross Deposits','Expected Operating Deposits',
    'Expected Monthly Debt','Expected Financing Credits','Last Validated','Notes'
  ];

  const created = [];
  VFC_BANK_ENGINE.BANKS.forEach(function(bank) {
    const sheetName = 'BANK_' + bank.id;
    let sh = ss.getSheetByName(sheetName);
    if (!sh) {
      sh = ss.insertSheet(sheetName);
      created.push(sheetName);
    }

    if (sh.getLastRow() === 0) {
      sh.getRange(1,1,1,headers.length).setValues([headers]);
      sh.setFrozenRows(1);
      sh.getRange(2,1,1,headers.length).setValues([[
        bank.label,
        bank.status,
        bank.id === 'RBC' ? 'RBC-2.0' : 'UNTRAINED',
        '', '', '', '', '', '', '', '', '', '', '', '',
        bank.id === 'RBC' ? 'RBC rules isolated and ready for regression testing.' : 'Reserved for bank-specific training. Do not copy RBC-specific assumptions here.'
      ]]);
      sh.autoResizeColumns(1,headers.length);
    } else {
      // Only refresh status/version cells; never overwrite training notes/data.
      sh.getRange(2,1).setValue(bank.label);
      sh.getRange(2,2).setValue(bank.status);
      sh.getRange(2,3).setValue(bank.id === 'RBC' ? 'RBC-2.0' : 'UNTRAINED');
    }
  });

  return { ok:true, created:created, tabs:getBankParserTabs() };
}

function getValidatedBankingFeatures_(companyName, period) {
  const base = vfcPureBaseFeatures_(companyName, period);
  if (!base) return null;

  const rows = vfcPureSelectedRows_(companyName, period);
  if (!rows.length) return base;

  const verified = vfcPureEnsureStatements_(rows);
  if (verified.errors.length) {
    throw new Error('Unable to verify uploaded bank statement(s): ' + verified.errors.join(' | '));
  }

  return vfcPureBuildFeatures_(base, verified.rows);
}

function refreshDebtSignalsForPeriodSafe(companyOrRequest, requestedPeriod) {
  try {
    const req = vfcPureRequest_(companyOrRequest, requestedPeriod);
    const period = req.period || (typeof resolveLatestAssessmentPeriod_ === 'function'
      ? resolveLatestAssessmentPeriod_(req.companyName, req.period)
      : req.period);
    const features = getValidatedBankingFeatures_(req.companyName, period);
    if (!features) throw new Error('No banking features found.');
    return {
      ok: true,
      modelVersion: VFC_BANK_ENGINE.VERSION,
      factsVersion: VFC_BANK_ENGINE.FACTS_VERSION,
      rulesVersion: VFC_BANK_ENGINE.RULES_VERSION,
      resultFingerprint: features.resultFingerprint || '',
      companyName: req.companyName,
      period: period,
      errors: [],
      bankTabs: getBankParserTabs(),
      debtProfile: features.debtProfile || {},
      inputQualityAudit: features.inputQualityAudit || {},
      bankingFeatures: {
        averageMonthlyDeposits: features.averageMonthlyDeposits || 0,
        estimatedOperatingMonthlyDeposits: features.estimatedOperatingMonthlyDeposits || 0,
        existingMonthlyDebtService: features.existingMonthlyDebtService || 0,
        informationalRecurringMonthlyObligations: features.informationalRecurringMonthlyObligations || 0,
        detectedFinancingCredits: features.detectedFinancingCredits || 0
      }
    };
  } catch (e) {
    return { ok:false, modelVersion:VFC_BANK_ENGINE.VERSION, errors:[String(e && e.message || e)] };
  }
}

function refreshLatestDebtSignals() {
  const rows = vfcPureSummaryRows_('', '');
  if (!rows.length) throw new Error('No bank statements found.');
  rows.sort(function(a,b){ return vfcPureTime_(a.createdAt) - vfcPureTime_(b.createdAt); });
  const last = rows[rows.length - 1];
  const result = refreshDebtSignalsForPeriodSafe({ companyName:last.companyName, period:last.period });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function diagnoseLatestBankingInputs() {
  return refreshLatestDebtSignals();
}

/* ------------------------- selection + storage ------------------------- */

function vfcPureSelectedRows_(companyName, period) {
  const all = vfcPureSummaryRows_(companyName, period);
  if (!all.length) return [];

  // Same statement uploaded more than once: keep only the newest row.
  const map = {};
  all.forEach(function(row) {
    const key = vfcPureStatementKey_(row);
    const current = map[key];
    if (!current || vfcPureTime_(row.createdAt) >= vfcPureTime_(current.createdAt)) map[key] = row;
  });

  const rows = Object.keys(map).map(function(k){ return map[k]; });
  rows.sort(function(a,b) {
    const ad = vfcPureDate_(a.endDate) || vfcPureDate_(a.startDate) || new Date(0);
    const bd = vfcPureDate_(b.endDate) || vfcPureDate_(b.startDate) || new Date(0);
    if (ad.getTime() !== bd.getTime()) return ad - bd;
    return String(a.fileName||'').localeCompare(String(b.fileName||''));
  });
  return rows.slice(Math.max(0, rows.length - VFC_BANK_ENGINE.MAX_STATEMENTS));
}

function vfcPureSummaryRows_(companyName, period) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('PDF Summaries');
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(vfcPureHeader_);
  const idx = {};
  headers.forEach(function(h,i){ idx[h]=i; });

  function val(r, name) {
    const i = idx[vfcPureHeader_(name)];
    return i === undefined ? '' : r[i];
  }

  const out = [];
  for (let i=1;i<values.length;i++) {
    const r = values[i];
    const company = String(val(r,'Company Name') || '').trim();
    const detected = String(val(r,'Detected Period') || '').trim();
    if (companyName && !vfcPureSame_(company, companyName)) continue;
    if (period && !vfcPureSame_(detected, period)) continue;
    out.push({
      rowNumber:i+1,
      signalColumn:(idx[vfcPureHeader_('Possible MCA Or Loan Payments')] === undefined ? -1 : idx[vfcPureHeader_('Possible MCA Or Loan Payments')]+1),
      uploadId:String(val(r,'Upload ID') || ''),
      companyName:company,
      period:detected,
      fileName:String(val(r,'File Name') || ''),
      bank:String(val(r,'Bank Name') || ''),
      startDate:val(r,'Statement Start Date'),
      endDate:val(r,'Statement End Date'),
      opening:vfcPureNullableNumber_(val(r,'Opening Balance')),
      closing:vfcPureNullableNumber_(val(r,'Closing Balance')),
      deposits:vfcPureNullableNumber_(val(r,'Total Deposits')),
      withdrawals:vfcPureNullableNumber_(val(r,'Total Withdrawals')),
      nsf:vfcPureNumber_(val(r,'NSF Count')),
      negative:vfcPureBool_(val(r,'Negative Balance Detected')),
      signalRaw:String(val(r,'Possible MCA Or Loan Payments') || ''),
      createdAt:val(r,'Created At')
    });
  }
  return out;
}

function vfcPureEnsureStatements_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('PDF Summaries');
  const uploadMap = vfcPureUploadMap_();
  const reusable = vfcPureReusableMap_(rows[0] ? rows[0].companyName : '', rows[0] ? rows[0].period : '');
  const out = [], errors = [];

  rows.forEach(function(row, index) {
    const recent = index >= Math.max(0, rows.length - VFC_BANK_ENGINE.DEBT_LOOKBACK);
    let payload = vfcPureParseCache_(row.signalRaw);

    if (!vfcPurePayloadUsable_(payload, recent)) {
      const prior = reusable[vfcPureStatementKey_(row)];
      if (vfcPurePayloadUsable_(prior, recent)) payload = prior;
    }

    if (!vfcPurePayloadUsable_(payload, recent)) {
      try {
        payload = vfcPureExtractStatement_(row, uploadMap[row.uploadId], recent);
      } catch (e) {
        errors.push(row.fileName + ': ' + String(e && e.message || e));
        return;
      }
    }

    // Normalize/migrate once. Classification/rules updates do not force statement re-reading.
    payload = vfcPureNormalizePayload_(payload, row);
    if (row.signalColumn > 0) {
      const stableValue = VFC_BANK_ENGINE.CACHE_PREFIX + JSON.stringify(payload);
      if (String(row.signalRaw || '') !== stableValue) sh.getRange(row.rowNumber, row.signalColumn).setValue(stableValue);
    }

    out.push({ row:row, payload:payload });
  });

  return { rows:out, errors:errors };
}

function vfcPureReusableMap_(companyName, period) {
  const all = vfcPureSummaryRows_(companyName, period);
  const map = {};
  all.forEach(function(row) {
    const p = vfcPureParseCache_(row.signalRaw);
    if (!vfcPurePayloadUsable_(p, false)) return;
    const k = vfcPureStatementKey_(row);
    const old = map[k];
    if (!old || vfcPurePayloadScore_(p) > vfcPurePayloadScore_(old)) map[k] = p;
  });
  return map;
}

function vfcPureUploadMap_() {
  const rows = typeof getSheetObjects_ === 'function' ? getSheetObjects_('Uploads') : [];
  const map = {};
  rows.forEach(function(r) {
    const id = String(r.uploadId || r['Upload ID'] || '').trim();
    if (!id) return;
    map[id] = { fileId:String(r.fileId || r['File ID'] || '').trim(), fileName:String(r.fileName || r['File Name'] || '') };
  });
  return map;
}

/* ------------------------- extraction ------------------------- */
