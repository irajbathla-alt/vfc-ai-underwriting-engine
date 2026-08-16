const VFC_BMO_INTAKE = {
  VERSION: 'VFC-BMO-INTAKE-2.0-DETERMINISTIC-RECURRING',
  BANK_LABEL: 'BMO',
  FUNDING_MINIMUM: 5000,
  CURRENT_AMOUNT_LOOKBACK_DAYS: 75,
  AMOUNT_MATCH_PERCENT: 0.05,
  AMOUNT_MATCH_DOLLARS: 3
};

/**
 * BMO-only intake path.
 * RBC and Other/Auto continue to use uploadStatementBatch() in Code.gs unchanged.
 * This file only adapts BMO statement formatting into the existing shared banking payload.
 */
function uploadStatementBatchBMO(companyName, files) {
  if (!companyName) throw new Error('Company name is required.');
  if (!files || !files.length) throw new Error('Upload at least one PDF.');

  const company = getOrCreateCompany_(companyName);
  const companyFolder = DriveApp.getFolderById(company.folderId);
  const tempFolder = getOrCreateSubFolder_(companyFolder, '_TEMP_PROCESSING');
  const staged = [];

  files.forEach(function(file){
    const fileName = file.name || 'statement.pdf';
    const blob = Utilities.newBlob(
      Utilities.base64Decode(file.base64),
      'application/pdf',
      fileName.toLowerCase().endsWith('.pdf') ? fileName : fileName + '.pdf'
    );
    const tempFile = tempFolder.createFile(blob);
    const text = extractTextFromPdf_(tempFile.getId());
    staged.push({
      uploadId: Utilities.getUuid(),
      fileName: fileName,
      fileId: tempFile.getId(),
      fileUrl: tempFile.getUrl(),
      text: text
    });
  });

  const prompts = staged.map(function(item){
    return buildBmoBankStatementPrompt_(item.text, companyName, item.fileName);
  });
  const summaries = callOpenAIJsonBatch_(prompts);
  if (summaries.length !== staged.length) throw new Error('BMO statement reader returned an incomplete batch.');

  const starts = [], ends = [];
  const processed = staged.map(function(item, index){
    let summary = summaries[index] || {};
    summary = vfcBmoLockPrintedStatementFacts_(summary, item.text, item.fileName);
    summary.bank_name = 'BMO';
    summary.nsf_count = vfcBmoCountNsf_(item.text);

    const documentType = String(summary.document_type || '').trim().toUpperCase().replace(/\s+/g, '_');
    summary.document_type = documentType || 'BANK_STATEMENT';
    if (summary.document_type === 'BANK_STATEMENT' && !Array.isArray(summary.banking_transactions)) {
      summary.banking_transactions = [];
    }

    const startDate = parseDateSafe_(summary.statement_start_date);
    const endDate = parseDateSafe_(summary.statement_end_date);
    if (startDate) starts.push(startDate);
    if (endDate) ends.push(endDate);

    return {
      uploadId: item.uploadId,
      fileName: item.fileName,
      fileId: item.fileId,
      fileUrl: item.fileUrl,
      text: item.text,
      summary: summary,
      bmoRecords: summary.document_type === 'BANK_STATEMENT'
        ? vfcBmoParseActivityRecords_(item.text, summary.statement_end_date, index)
        : []
    };
  });

  if (!starts.length || !ends.length) {
    throw new Error('BMO statement dates could not be verified from the uploaded statements.');
  }

  // Build the recurring BMO debt/funding ledger from the whole uploaded batch first.
  // This lets different printed names and old/new payment amounts resolve to one obligation.
  vfcBmoApplyDeterministicLedger_(processed);

  processed.forEach(function(item){
    if (item.summary.document_type === 'BANK_STATEMENT' && typeof vfcBankCreateIntakePayload_ === 'function') {
      item.summary.possible_mca_or_loan_payments = vfcBankCreateIntakePayload_(item.summary, item.fileName);
    }
  });

  const period = buildDetectedPeriod_(starts, ends);
  const periodFolder = getOrCreateSubFolder_(companyFolder, period.label);
  const uploadRows = [], pdfRows = [], batchInput = [], now = new Date();

  processed.forEach(function(item){
    const driveFile = DriveApp.getFileById(item.fileId);
    periodFolder.addFile(driveFile);
    tempFolder.removeFile(driveFile);

    uploadRows.push([
      item.uploadId, company.companyId, companyName, period.label, item.fileName,
      item.fileId, item.fileUrl,
      item.summary.document_type === 'BANK_STATEMENT' ? 'READ' : 'REVIEW_REQUIRED',
      now
    ]);

    pdfRows.push([
      item.uploadId, companyName, period.label, item.fileName,
      item.summary.document_type || '', 'BMO', item.summary.account_holder || '',
      item.summary.statement_start_date || '', item.summary.statement_end_date || '',
      item.summary.opening_balance || '', item.summary.closing_balance || '',
      item.summary.total_deposits || '', item.summary.total_withdrawals || '',
      item.summary.nsf_count || '', item.summary.negative_balance_detected || '',
      item.summary.possible_mca_or_loan_payments || '', item.summary.summary || '',
      item.summary.risks || '', item.summary.missing_info || '', now
    ]);

    batchInput.push({fileName:item.fileName, summary:item.summary});
  });

  appendRows_('Uploads', uploadRows);
  appendRows_('PDF Summaries', pdfRows);

  const batch = summarizeBatch_(batchInput, companyName, period.label);
  appendRow_('Batch Summaries', [
    Utilities.getUuid(), companyName, period.label, files.length,
    period.earliest || '', period.latest || '', batch.combined_summary || '',
    batch.key_findings || '', batch.risks || '', batch.missing_info || '', new Date()
  ]);

  upsertStructuredFeature_(companyName, period.label);

  return {
    ok: true,
    intakeModelVersion: VFC_BMO_INTAKE.VERSION,
    bankProfile: 'BMO',
    companyName: companyName,
    detectedPeriod: period.label,
    filesUploaded: files.length,
    companyFolderLink: company.folderLink,
    periodFolderLink: periodFolder.getUrl(),
    batchSummary: batch
  };
}

function buildBmoBankStatementPrompt_(text, companyName, fileName) {
  return [
    'You are the VFC BMO Bank Statement Fact Reader. Return JSON only.',
    'Company: ' + companyName,
    'File: ' + fileName,
    'This upload is explicitly identified as a BMO / Bank of Montreal business bank statement.',
    'Return fields: document_type, bank_name, account_holder, statement_start_date, statement_end_date, opening_balance, closing_balance, total_deposits, total_withdrawals, nsf_count, negative_balance_detected, banking_transactions, summary, risks, missing_info.',
    'banking_transactions is an array: {date:"YYYY-MM-DD",description:"exact visible description",counterparty:"short counterparty",direction:"DEBIT" or "CREDIT",amount:number}.',
    'FACT EXTRACTION ONLY. Do not underwrite.',
    'BMO HEADER RULE: Total amounts credited = total_deposits. Total amounts debited = total_withdrawals.',
    'BMO TABLE RULE: Amounts debited from your account = DEBIT. Amounts credited to your account = CREDIT. Wording never overrides the printed column.',
    'Extract loan/MCA/financing/PAD transactions, equipment finance/lease, tax/government, insurance/premium finance and credit-card payments.',
    'For BMO, preserve recurring Pre-Authorized Payment descriptions exactly. A deterministic BMO parser separately groups lender-like recurring payments and handles returned/NSF reversals.',
    'Also extract incoming credits of $5,000 or more when they could plausibly be financing. Returned/NSF reversals are not financing proceeds merely because they are credits.',
    'Do not duplicate transaction rows or cheque-image pages.',
    'The program separately locks BMO printed summary totals and verifies Opening + Credits - Debits = Closing.',
    'Use YYYY-MM-DD dates. If not a bank statement, set document_type=NOT_BANK_STATEMENT and banking_transactions=[].',
    'Document text:',
    String(text || '').substring(0, VFC_CONFIG.STATEMENT_TEXT_LIMIT)
  ].join('\n');
}

function vfcBmoLockPrintedStatementFacts_(summary, text, fileName) {
  summary = summary || {};
  const facts = vfcBmoExtractPrintedStatementFacts_(text);

  if (!facts.totalsVerified) {
    throw new Error(
      'BMO printed summary totals could not be reconciled for ' + (fileName || 'statement') +
      '. The file was not accepted rather than guessing the totals.'
    );
  }

  if (facts.startDate) summary.statement_start_date = facts.startDate;
  if (facts.endDate) summary.statement_end_date = facts.endDate;
  summary.opening_balance = facts.opening;
  summary.closing_balance = facts.closing;
  summary.total_deposits = facts.credits;
  summary.total_withdrawals = facts.debits;
  return summary;
}

function vfcBmoExtractPrintedStatementFacts_(text) {
  const source = String(text || '').replace(/\u00a0/g, ' ');
  const out = {
    startDate: '', endDate: '', opening: null, closing: null,
    debits: null, credits: null, totalsVerified: false
  };

  const endMatch = source.match(/For\s+the\s+period\s+ending\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);
  if (endMatch) out.endDate = vfcPrintedIsoDate_(endMatch[1]);

  const openingMatch = source.match(/\b([A-Za-z]{3})\s+(\d{1,2})\s+Opening\s+balance\b/i);
  if (openingMatch && out.endDate) {
    out.startDate = vfcBmoActivityIsoDate_(openingMatch[1], openingMatch[2], out.endDate);
  }

  const summaryMatch = source.match(/Summary\s+of\s+account([\s\S]{0,3000}?)Transaction\s+details/i);
  if (!summaryMatch) return out;

  const block = summaryMatch[1];
  const moneyMatches = block.match(/-?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g) || [];
  const numbers = moneyMatches
    .map(function(value){ return vfcPrintedMoney_(value); })
    .filter(function(value){ return value !== null; });

  // BMO summary table order is always:
  // Opening balance | Total amounts debited | Total amounts credited | Closing balance.
  // We do not trust a candidate window unless its arithmetic reconciles.
  let chosen = null;
  for (let i = 0; i <= numbers.length - 4; i++) {
    const opening = numbers[i];
    const debits = Math.abs(numbers[i + 1]);
    const credits = Math.abs(numbers[i + 2]);
    const closing = numbers[i + 3];
    const diff = (opening + credits - debits) - closing;
    if (Math.abs(diff) <= 5) {
      chosen = {opening:opening, debits:debits, credits:credits, closing:closing};
    }
  }

  if (!chosen) return out;

  out.opening = chosen.opening;
  out.debits = chosen.debits;
  out.credits = chosen.credits;
  out.closing = chosen.closing;
  out.totalsVerified = true;
  return out;
}

/** Parse BMO activity rows without changing any RBC parser. */
function vfcBmoParseActivityRecords_(text, endIso, fileIndex) {
  const lines = String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/);
  const rows = [];
  let current = null;

  function flush(){
    if (!current) return;
    const record = vfcBmoParseActivityRecord_(current, endIso, fileIndex);
    if (record) rows.push(record);
    current = null;
  }

  lines.forEach(function(raw){
    const line = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!line) return;

    let m = line.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(.*)$/);
    if (!m) m = line.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(.*)$/);

    if (m) {
      flush();
      if (/^[A-Za-z]{3}/.test(line)) {
        current = {month:m[1], day:m[2], body:m[3] || ''};
      } else {
        current = {month:m[2], day:m[1], body:m[3] || ''};
      }
      return;
    }

    if (current && !vfcBmoNoiseLine_(line)) {
      current.body += ' ' + line;
    }
  });
  flush();
  return rows;
}

function vfcBmoParseActivityRecord_(row, endIso, fileIndex) {
  const body = String(row.body || '').replace(/\s+/g, ' ').trim();
  if (!body || /^Opening balance\b/i.test(body)) return null;

  let type = '';
  if (/^Pre-Authorized Payment(?: No Fee)?,/i.test(body)) type = 'PREAUTH_DEBIT';
  else if (/^Direct Deposit,/i.test(body)) type = 'DIRECT_CREDIT';
  else if (/^Cheque Returned NSF\b/i.test(body)) type = 'RETURN_CREDIT';
  else if (/^Returned Item Payment Stopped\b/i.test(body)) type = 'RETURN_CREDIT';
  else return null;

  const money = body.match(/-?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g) || [];
  if (!money.length) return null;
  const amount = Math.abs(vfcPrintedMoney_(money[0]) || 0);
  if (!(amount > 0)) return null;

  const amountPos = body.indexOf(money[0]);
  const printed = body.slice(0, amountPos).replace(/\s+/g, ' ').trim().replace(/[\s,]+$/, '');
  const payee = vfcBmoPrintedPayee_(printed);
  const date = vfcBmoActivityIsoDate_(row.month, row.day, endIso);
  if (!date) return null;

  return {
    fileIndex: Number(fileIndex) || 0,
    date: date,
    type: type,
    amount: Math.round(amount * 100) / 100,
    printedDescription: printed,
    rawBody: body,
    payee: payee,
    entityKey: vfcBmoEntityKey_(payee || printed)
  };
}

function vfcBmoNoiseLine_(line) {
  return /^(Transaction details|Amounts debited|Amounts credited|Date Description|Business Account|Business Banking|continued|Page \d+|Your branch|Your Branch|For questions|Direct Banking|www\.|Your Plan|Summary of account|Opening amounts|Closing balance|Account balance)/i.test(String(line || ''));
}

function vfcBmoPrintedPayee_(printedDescription) {
  return String(printedDescription || '')
    .replace(/^Pre-Authorized Payment(?: No Fee)?,\s*/i, '')
    .replace(/^Direct Deposit,\s*/i, '')
    .replace(/^Cheque Returned NSF\b\s*/i, '')
    .replace(/^Returned Item Payment Stopped,?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converts BMO-specific recurring payment rows into the transaction format already
 * understood by BankingInputQuality.gs. No underwriting formula is changed.
 */
function vfcBmoApplyDeterministicLedger_(processed) {
  const all = [];
  (processed || []).forEach(function(item, index){
    (item.bmoRecords || []).forEach(function(record){
      record.fileIndex = index;
      all.push(record);
    });
  });

  // Debt service is an obligation, so a scheduled PAD is still retained even if BMO later
  // shows an NSF/returned-item credit. Large payoff/error attempts are excluded separately
  // by the stable-amount clustering below rather than by deleting the underlying obligation.
  const preauth = all.filter(function(r){ return r.type === 'PREAUTH_DEBIT'; });
  const directCredits = all.filter(function(r){ return r.type === 'DIRECT_CREDIT'; });
  const grouped = {};

  preauth.forEach(function(r){
    if (!r.entityKey) return;
    if (!grouped[r.entityKey]) grouped[r.entityKey] = {entityKey:r.entityKey, items:[], names:[]};
    grouped[r.entityKey].items.push(r);
    if (r.payee && grouped[r.entityKey].names.indexOf(r.payee) < 0) grouped[r.entityKey].names.push(r.payee);
  });

  const debtGroups = [];
  Object.keys(grouped).forEach(function(key){
    const group = grouped[key];
    if (!vfcBmoLenderLike_(group, directCredits)) return;
    const current = vfcBmoCurrentPaymentAmount_(group.items);
    if (!(current > 0)) return;
    group.currentAmount = current;
    group.acceptedClusters = vfcBmoAcceptedAmountClusters_(group.items, current);
    debtGroups.push(group);
  });

  const byFile = {};
  (processed || []).forEach(function(_, i){ byFile[i] = []; });

  debtGroups.forEach(function(group){
    const names = group.names.slice();
    const visible = names.join(' / ') || group.entityKey;
    const seenDate = {};
    const sorted = group.items.slice().sort(function(a,b){ return String(a.date).localeCompare(String(b.date)); });

    sorted.forEach(function(r){
      if (!vfcBmoAmountInAcceptedClusters_(r.amount, group.acceptedClusters)) return;
      const dateKey = r.fileIndex + '|' + r.date;
      if (seenDate[dateKey]) return;
      seenDate[dateKey] = true;
      byFile[r.fileIndex].push({
        date: r.date,
        description: 'BMO PAD | ' + visible,
        counterparty: visible,
        direction: 'DEBIT',
        amount: Math.round(group.currentAmount * 100) / 100,
        _aliases: names.slice()
      });
    });
  });

  // Confirm financing proceeds only when a large BMO Direct Deposit comes from an entity
  // that is also a detected recurring financing counterparty. Same-day duplicate funding
  // credits are aggregated instead of being accidentally de-duplicated later.
  const funding = {};
  directCredits.forEach(function(r){
    if (!(r.amount >= VFC_BMO_INTAKE.FUNDING_MINIMUM)) return;
    const matched = vfcBmoMatchDebtGroup_(r, debtGroups);
    if (!matched) return;
    const key = r.fileIndex + '|' + r.date + '|' + matched.entityKey;
    if (!funding[key]) funding[key] = {fileIndex:r.fileIndex,date:r.date,amount:0,group:matched,names:[]};
    funding[key].amount += r.amount;
    if (r.payee && funding[key].names.indexOf(r.payee) < 0) funding[key].names.push(r.payee);
  });

  Object.keys(funding).forEach(function(key){
    const f = funding[key];
    const names = f.names.length ? f.names : f.group.names;
    const visible = names.join(' / ') || f.group.entityKey;
    byFile[f.fileIndex].push({
      date: f.date,
      description: 'FINANCING ADVANCE BMO | ' + visible,
      counterparty: visible,
      direction: 'CREDIT',
      amount: Math.round(f.amount * 100) / 100,
      _aliases: names.slice()
    });
  });

  (processed || []).forEach(function(item, index){
    const deterministic = byFile[index] || [];
    item.summary.banking_transactions = vfcBmoMergeWithAiTransactions_(
      item.summary.banking_transactions || [], deterministic, debtGroups
    );
  });
}

function vfcBmoLenderLike_(group, directCredits) {
  const names = (group.names || []).join(' ').toUpperCase();
  const raw = (group.items || []).map(function(x){ return x.rawBody || ''; }).join(' ').toUpperCase();
  const count = (group.items || []).length;
  if (!count) return false;

  if (/\bICBC\b|CLOVER\s+(?:FEES|APP)|\bFISERV\b|FIRST\s+DATA|\bFD\d{6,}\b|\bHYDRO\b|\bFORTIS\b|\bSHAW\b|\bTELUS\b|\bROGERS\b|\bINTUIT\b/.test(names)) return false;

  if (/LNS\/PRE/.test(raw) || /\bLOAN\b|\bMCA\b|FINANC|CAPITA|\bCREDIT\b|LENDING|FUNDING|\bFUND\b|ADVANCE|CANACAP|\b2M7\b/.test(names)) return true;

  if (/BUS\/ENT/.test(names) && count >= 5 && vfcBmoStableRatio_(group.items) >= 0.70) return true;

  for (let i = 0; i < (directCredits || []).length; i++) {
    const c = directCredits[i];
    if (c.amount < VFC_BMO_INTAKE.FUNDING_MINIMUM) continue;
    if (vfcBmoKeysRelated_(group.entityKey, c.entityKey)) return true;
  }
  return false;
}

function vfcBmoCurrentPaymentAmount_(items) {
  items = (items || []).filter(function(x){ return x && x.amount > 0 && x.date; });
  if (!items.length) return 0;

  let latest = null;
  items.forEach(function(x){
    const d = new Date(x.date + 'T00:00:00');
    if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
  });
  const recent = latest ? items.filter(function(x){
    const d = new Date(x.date + 'T00:00:00');
    return !isNaN(d.getTime()) && (latest - d) / 86400000 <= VFC_BMO_INTAKE.CURRENT_AMOUNT_LOOKBACK_DAYS;
  }) : items.slice();

  const clusters = vfcBmoAmountClusters_(recent.length ? recent : items);
  if (!clusters.length) return 0;
  clusters.sort(function(a,b){
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return String(b.lastDate).localeCompare(String(a.lastDate));
  });
  return vfcBmoMedian_(clusters[0].items.map(function(x){ return x.amount; }));
}

function vfcBmoAcceptedAmountClusters_(items, currentAmount) {
  const clusters = vfcBmoAmountClusters_(items || []);
  const total = Math.max(1, (items || []).length);
  return clusters.filter(function(c){
    const median = vfcBmoMedian_(c.items.map(function(x){ return x.amount; }));
    const ratio = currentAmount ? median / currentAmount : 0;
    const established = c.items.length >= 3 || c.items.length / total >= 0.10;
    return established && ratio >= 0.50 && ratio <= 1.50;
  }).map(function(c){
    return vfcBmoMedian_(c.items.map(function(x){ return x.amount; }));
  });
}

function vfcBmoAmountClusters_(items) {
  const clusters = [];
  (items || []).slice().sort(function(a,b){ return a.amount - b.amount; }).forEach(function(item){
    let target = null;
    for (let i = 0; i < clusters.length; i++) {
      const median = vfcBmoMedian_(clusters[i].items.map(function(x){ return x.amount; }));
      if (vfcBmoAmountsClose_(median, item.amount)) { target = clusters[i]; break; }
    }
    if (!target) {
      target = {items:[],lastDate:''};
      clusters.push(target);
    }
    target.items.push(item);
    if (String(item.date) > String(target.lastDate)) target.lastDate = item.date;
  });
  return clusters;
}

function vfcBmoAmountInAcceptedClusters_(amount, clusters) {
  for (let i = 0; i < (clusters || []).length; i++) {
    if (vfcBmoAmountsClose_(amount, clusters[i])) return true;
  }
  return false;
}

function vfcBmoStableRatio_(items) {
  const clusters = vfcBmoAmountClusters_(items || []);
  if (!clusters.length || !(items || []).length) return 0;
  let max = 0;
  clusters.forEach(function(c){ if (c.items.length > max) max = c.items.length; });
  return max / items.length;
}

function vfcBmoAmountsClose_(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  const tolerance = Math.max(
    VFC_BMO_INTAKE.AMOUNT_MATCH_DOLLARS,
    Math.max(Math.abs(a), Math.abs(b)) * VFC_BMO_INTAKE.AMOUNT_MATCH_PERCENT
  );
  return Math.abs(a - b) <= tolerance;
}

function vfcBmoMatchDebtGroup_(record, groups) {
  for (let i = 0; i < (groups || []).length; i++) {
    if (vfcBmoKeysRelated_(record.entityKey, groups[i].entityKey)) return groups[i];
  }
  return null;
}

function vfcBmoMergeWithAiTransactions_(aiTransactions, deterministic, debtGroups) {
  const kept = [];
  const debtKeys = (debtGroups || []).map(function(g){ return g.entityKey; });

  (Array.isArray(aiTransactions) ? aiTransactions : []).forEach(function(tx){
    const key = vfcBmoEntityKey_(String(tx && tx.counterparty || '') + ' ' + String(tx && tx.description || ''));
    let related = false;
    for (let i = 0; i < debtKeys.length; i++) {
      if (vfcBmoKeysRelated_(key, debtKeys[i])) { related = true; break; }
    }
    if (!related) kept.push(tx);
  });

  return kept.concat(deterministic || []);
}

function vfcBmoEntityKey_(value) {
  let s = String(value || '').toUpperCase();
  s = s.replace(/^PRE[- ]AUTHORIZED PAYMENT(?: NO FEE)?,?\s*/i, '');
  s = s.replace(/^DIRECT DEPOSIT,?\s*/i, '');
  s = s.replace(/\b(?:MSP\/DIV|BUS\/ENT|LNS\/PRE|APY\/PAA|CLN\/PEE|RLS\/LOY|BPY\/FAC|INS\/ASS)\b/g, ' ');
  s = s.replace(/FINANCIALSOL/g, ' FINANCIAL ');
  s = s.replace(/\b(?:FINANCIAL|FINANCE|CAPITAL|CAPITA|CREDIT|CANADA|CA|SOLUTIONS|SOLUTION|SOL)\b/g, ' ');
  s = s.replace(/\b(?:BMO|BANK|PAYMENT|PREAUTHORIZED|PRE|AUTHORIZED|DIRECT|DEPOSIT|BUSINESS|ENT)\b/g, ' ');
  return s.replace(/[^A-Z0-9]+/g, '').substring(0, 80);
}

function vfcBmoKeysRelated_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return true;
  return false;
}

function vfcBmoMoneyKey_(amount) {
  return (Math.round((Number(amount) || 0) * 100) / 100).toFixed(2);
}

function vfcBmoMedian_(values) {
  values = (values || []).map(Number).filter(function(x){ return isFinite(x); }).sort(function(a,b){ return a-b; });
  if (!values.length) return 0;
  const m = Math.floor(values.length / 2);
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

function vfcBmoCountNsf_(text) {
  const matches = String(text || '').match(/Cheque\s+Returned\s+NSF/gi) || [];
  return matches.length;
}

function vfcBmoActivityIsoDate_(monthText, dayText, endIso) {
  const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const month = months[String(monthText || '').substring(0,3).toUpperCase()];
  const end = parseDateSafe_(endIso);
  if (month === undefined || !end) return '';
  let year = end.getFullYear();
  if (month > end.getMonth()) year -= 1;
  const date = new Date(year, month, Number(dayText));
  return formatDate_(date);
}
