function exportFineTuneJsonlAdmin(payload) {
  validateAdminToken(payload && payload.adminToken);
  return exportFineTuneJsonlFromHistoricalCases(payload || {});
}

function exportFineTuneJsonlFromHistoricalCases(options) {
  options = options || {};
  const rows = getRows(CONFIG.HISTORICAL_CASES_TAB);
  if (!rows || rows.length <= 1) return { ok: false, error: 'No Historical Cases found.' };

  const cases = rowsToObjects(rows).filter(function(row) {
    return row.lenderName || row.decision || row.approvedAmount || row.averageMonthlyDeposits;
  });

  if (!cases.length) return { ok: false, error: 'Historical Cases tab has no usable rows.' };

  const examples = cases.map(function(row) {
    return buildFineTuneExample(row);
  }).filter(Boolean);

  if (!examples.length) return { ok: false, error: 'No usable training examples could be built.' };

  const jsonl = examples.map(function(example) {
    return JSON.stringify(example);
  }).join('\n');

  const folder = getOrCreateCaseStudyFolder();
  const fileName = 'vfc-fine-tune-training-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.jsonl';
  const file = folder.createFile(fileName, jsonl, MimeType.PLAIN_TEXT);

  return {
    ok: true,
    examples: examples.length,
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    message: 'Fine-tune JSONL export created. Review and redact before submitting to OpenAI fine-tuning.'
  };
}

function buildFineTuneExample(row) {
  const decision = normalizeDecision(row.decision || 'Unknown');
  const input = {
    business_name: row.businessName || extractFromNotes(row.notes, 'Business'),
    owner_name: row.ownerName || extractFromNotes(row.notes, 'Owner'),
    industry: row.industry || '',
    time_in_business: row.timeInBusiness || '',
    credit_score: Number(row.creditScore || 0),
    average_monthly_deposits: Number(row.averageMonthlyDeposits || 0),
    nsf_count: Number(row.nsfCount || 0),
    negative_days: Number(row.negativeDays || 0),
    existing_mca_payments: Number(row.existingMcaPayments || 0),
    revenue_trend: row.revenueTrend || 'unknown',
    requested_amount: Number(row.requestedAmount || 0)
  };

  const output = {
    lender_name: row.lenderName || 'Unknown Lender',
    decision: decision,
    funded: row.funded || 'No',
    approved_amount: Number(row.approvedAmount || 0),
    reason_approved: row.reasonApproved || '',
    reason_declined: row.reasonDeclined || '',
    conditions: row.conditions || '',
    training_note: 'Use as lender-fit pattern only. Final decision remains human reviewed.'
  };

  return {
    messages: [{
      role: 'system',
      content: 'You are a Canadian MCA underwriting assistant for Vancouver Finance Company Inc. Recommend lender fit, likely decision, amount range, and conditions from the input. Do not give a final binding approval.'
    }, {
      role: 'user',
      content: JSON.stringify(input)
    }, {
      role: 'assistant',
      content: JSON.stringify(output)
    }]
  };
}

function extractFromNotes(notes, label) {
  const regex = new RegExp(label + ':\\s*([^|]+)', 'i');
  const match = String(notes || '').match(regex);
  return match ? match[1].trim() : '';
}

function testExportFineTuneJsonlFromHistoricalCases() {
  const result = exportFineTuneJsonlFromHistoricalCases({});
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
