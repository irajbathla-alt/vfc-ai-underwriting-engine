const VFC_BMO_INTAKE = {
  VERSION: 'VFC-BMO-INTAKE-1.0',
  BANK_LABEL: 'BMO'
};

/**
 * BMO-only intake path.
 * RBC and the existing generic path continue to use uploadStatementBatch() in Code.gs.
 * This function intentionally does not change the shared underwriting or banking engines.
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

    const documentType = String(summary.document_type || '').trim().toUpperCase().replace(/\s+/g, '_');
    summary.document_type = documentType || 'BANK_STATEMENT';

    if (summary.document_type === 'BANK_STATEMENT') {
      if (!Array.isArray(summary.banking_transactions)) {
        throw new Error('Banking ledger extraction was incomplete for ' + item.fileName + '.');
      }
      if (typeof vfcBankCreateIntakePayload_ === 'function') {
        summary.possible_mca_or_loan_payments = vfcBankCreateIntakePayload_(summary, item.fileName);
      }
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
      summary: summary
    };
  });

  if (!starts.length || !ends.length) {
    throw new Error('BMO statement dates could not be verified from the uploaded statements.');
  }

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
    'Extract financing/loan/PAD/MCA/advance/funding/capital transactions, loan interest, recurring pre-authorized financing payments, equipment finance/lease, tax/government, insurance/premium finance and credit-card payments.',
    'For BMO, recurring Pre-Authorized Payment rows with lender/finance/capital/credit wording or bank service codes such as LNS/PRE or BUS/ENT are important. Preserve the exact printed payee description.',
    'Also extract incoming credits of $5,000 or more when they could plausibly be financing. Returned/NSF reversals are not financing proceeds merely because they appear in the credit column.',
    'Do not extract ordinary suppliers, payroll, customer receipts, utilities, fuel, phone or bank fees unless clearly financing/tax/insurance/equipment rent-or-lease.',
    'Do not duplicate transaction rows or cheque-image pages. If uncertain, omit the transaction.',
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

  const summaryMatch = source.match(/Summary\s+of\s+account([\s\S]{0,2500}?)Transaction\s+details/i);
  if (!summaryMatch) return out;

  const block = summaryMatch[1];
  const moneyMatches = block.match(/-?\s*\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}/g) || [];
  const numbers = moneyMatches.map(function(value){ return vfcPrintedMoney_(value); }).filter(function(value){ return value !== null; });

  // BMO summary table order is Opening, Total amounts debited, Total amounts credited, Closing.
  // Search every consecutive 4-money window and accept only arithmetic that reconciles.
  let chosen = null;
  for (let i = 0; i <= numbers.length - 4; i++) {
    const opening = numbers[i];
    const debits = Math.abs(numbers[i + 1]);
    const credits = Math.abs(numbers[i + 2]);
    const closing = numbers[i + 3];
    const diff = (opening + credits - debits) - closing;
    if (Math.abs(diff) <= 5) {
      chosen = {opening:opening, debits:debits, credits:credits, closing:closing, diff:diff};
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
