function vfcPureExtractStatement_(row, upload, needTransactions) {
  let totals = vfcPureStoredTotals_(row);
  let text = '';
  if (!totals.ok || needTransactions) {
    if (!upload || !upload.fileId) throw new Error('uploaded PDF file ID not found');
    text = extractTextFromPdf_(upload.fileId);
  }

  const bankId = vfcDetectBankId_(String(row.bank||'') + '\n' + String(text||''));
  let extracted = null;
  if (needTransactions || !totals.ok) extracted = vfcPureExtractFactsWithOpenAI_(text, row, needTransactions, bankId);

  if (!totals.ok) {
    totals = vfcPureVerifiedTotals_(extracted && extracted.header ? extracted.header : {}, row);
    if (!totals.ok) throw new Error('statement header totals did not reconcile');
  }

  const transactions = needTransactions ? vfcPureNormalizeTransactions_(extracted && extracted.transactions) : [];
  return {
    version:2,
    extractionVersion:VFC_BANK_ENGINE.FACTS_VERSION,
    fileName:row.fileName,
    bankId:bankId,
    bankName:String((extracted && extracted.header && extracted.header.bankName) || row.bank || bankId || 'Unknown'),
    statementStartDate:vfcPureIso_(row.startDate || (extracted && extracted.header && extracted.header.statementStartDate)),
    statementEndDate:vfcPureIso_(row.endDate || (extracted && extracted.header && extracted.header.statementEndDate)),
    openingBalance:totals.opening,
    closingBalance:totals.closing,
    totalDeposits:totals.deposits,
    totalWithdrawals:totals.withdrawals,
    reconciliationDifference:totals.diff,
    totalsSource:totals.source,
    nsfCount:Math.max(0, vfcPureNumber_((extracted && extracted.header && extracted.header.nsfCount) || row.nsf)),
    negativeBalanceDetected:!!((extracted && extracted.header && extracted.header.negativeBalanceDetected) || row.negative),
    transactionsVerified:needTransactions,
    transactions:transactions
  };
}

function vfcPureExtractFactsWithOpenAI_(text, row, needTransactions, bankId) {
  const bankRules = vfcBankExtractionRules_(bankId);
  const prompt = [
    'Read this business bank statement as a transaction ledger. Return JSON only.',
    'Do not underwrite. Do not infer frequency. Do not infer monthly debt. Extract facts only.',
    'BANK ADAPTER: ' + bankId,
    '',
    'Return object:',
    '{',
    '  "header": {"bankName":"", "statementStartDate":"YYYY-MM-DD", "statementEndDate":"YYYY-MM-DD", "openingBalance":0, "closingBalance":0, "totalDeposits":0, "totalWithdrawals":0, "nsfCount":0, "negativeBalanceDetected":false},',
    '  "transactions": [{"date":"YYYY-MM-DD", "description":"exact statement description", "counterparty":"best short counterparty or description", "direction":"DEBIT or CREDIT", "amount":0}]',
    '}',
    '',
    'STRICT COMMON RULES:',
    '1. Use the statement Account Summary totals when printed. Do not sum transactions for header totals.',
    '2. Direction is determined ONLY by the statement debit/withdrawal column versus credit/deposit column and balance movement.',
    '3. A transaction printed in Deposits/Credits is CREDIT even if its description contains PAD, payment, loan, investment or another misleading word.',
    '4. A transaction printed in Cheques/Debits is DEBIT even if its description contains credit.',
    '5. Keep exact transaction amount. Never borrow the amount from the row above or below.',
    '6. Do not duplicate cheque-image pages when the transaction is already in the account activity ledger.',
    '7. If a field is unclear, leave it blank/zero rather than guessing.',
    '',
    'BANK-SPECIFIC EXTRACTION RULES:',
    bankRules,
    '',
    'Known sheet metadata (fallback only):',
    JSON.stringify({start:vfcPureIso_(row.startDate),end:vfcPureIso_(row.endDate),opening:row.opening,closing:row.closing,deposits:row.deposits,withdrawals:row.withdrawals}),
    '',
    needTransactions ? 'Transactions are required for this statement.' : 'Transactions may be empty; header verification is the priority.',
    '',
    'STATEMENT TEXT:',
    String(text || '').substring(0, VFC_BANK_ENGINE.MAX_TEXT_CHARS)
  ].join('\n');

  const raw = callOpenAIJson_(prompt) || {};
  return { header:raw.header || {}, transactions:Array.isArray(raw.transactions) ? raw.transactions : [] };
}

function vfcBankExtractionRules_(bankId) {
  if (bankId === 'RBC') {
    return [
      'RBC: extract every Account Activity transaction containing LOAN, PAD, MCA, MERCH, FINANC, ADVANCE, FUNDING, BDC, ONDECK, JOURNEY, TAX, GST, HST, CRA, CCRA, EMPTX, INSURANCE, IPFS, CREDIT CARD, SUPERPASS, GAS BILL, HYDRO, FORTIS.',
      'RBC: also extract any incoming credit of $5,000 or more whose description could plausibly be financing, including Investment, lender/capital/company names, or Loan BDC.',
      'RBC: LOAN CREDIT in the Deposits/Credits column is a CREDIT. Generic LOAN PAYMENT in Cheques/Debits is a DEBIT.',
      'RBC: preserve numbered loan descriptions exactly, including Loan payment NO.x and Loan interest NO.x.',
      'RBC: preserve Business PAD BDC and Investment MERCH PAD exactly.'
    ].join('\n');
  }
  return 'This bank is not trained yet. Extract facts conservatively and do not apply RBC-specific naming assumptions.';
}

function vfcPureNormalizePayload_(payload, row) {
  payload = payload || {};
  return {
    version:2,
    extractionVersion:VFC_BANK_ENGINE.FACTS_VERSION,
    fileName:String(payload.fileName || row.fileName || ''),
    bankId:String(payload.bankId || vfcDetectBankId_(payload.bankName || row.bank || '')),
    bankName:String(payload.bankName || row.bank || 'Unknown'),
    statementStartDate:vfcPureIso_(payload.statementStartDate || row.startDate),
    statementEndDate:vfcPureIso_(payload.statementEndDate || row.endDate),
    openingBalance:vfcPureNumber_(payload.openingBalance),
    closingBalance:vfcPureNumber_(payload.closingBalance),
    totalDeposits:vfcPurePositive_(payload.totalDeposits),
    totalWithdrawals:vfcPurePositive_(payload.totalWithdrawals),
    reconciliationDifference:vfcPureNumber_(payload.reconciliationDifference),
    totalsSource:String(payload.totalsSource || 'PDF_SUMMARY_RECONCILED'),
    nsfCount:Math.max(0,vfcPureNumber_(payload.nsfCount)),
    negativeBalanceDetected:!!payload.negativeBalanceDetected,
    transactionsVerified:!!payload.transactionsVerified,
    transactions:vfcPureNormalizeTransactions_(payload.transactions || [])
  };
}

function vfcPureNormalizeTransactions_(items) {
  if (!Array.isArray(items)) return [];
  const out = [], seen = {};
  items.forEach(function(item) {
    item = item || {};
    const date = vfcPureIso_(item.date);
    const description = String(item.description || '').replace(/\s+/g,' ').trim();
    const direction = String(item.direction || '').toUpperCase();
    const amount = vfcPurePositive_(item.amount);
    if (!date || !description || (direction !== 'DEBIT' && direction !== 'CREDIT') || !(amount > 0)) return;
    const t = {
      date:date,
      description:description.substring(0,220),
      counterparty:String(item.counterparty || description).replace(/\s+/g,' ').trim().substring(0,140),
      direction:direction,
      amount:vfcPureRound_(amount,.01)
    };
    const key = [t.date,t.direction,t.amount,t.description.toLowerCase()].join('|');
    if (!seen[key]) { seen[key]=1; out.push(t); }
  });

  // Critical for repeatability: always use the same ordering.
  out.sort(function(a,b) {
    const dt = vfcPureTime_(a.date) - vfcPureTime_(b.date);
    if (dt) return dt;
    if (a.direction !== b.direction) return a.direction.localeCompare(b.direction);
    if (a.amount !== b.amount) return a.amount - b.amount;
    return a.description.localeCompare(b.description);
  });
  return out;
}

function vfcDetectBankId_(text) {
  const s = String(text || '').toUpperCase();
  for (let i=0;i<VFC_BANK_ENGINE.BANKS.length;i++) {
    const b = VFC_BANK_ENGINE.BANKS[i];
    for (let j=0;j<b.aliases.length;j++) {
      if (s.indexOf(String(b.aliases[j]).toUpperCase()) >= 0) return b.id;
    }
  }
  return 'UNKNOWN';
}

/* ------------------------- deterministic classification ------------------------- */
