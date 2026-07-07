function analyzeStatementTextWithOpenAI(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties');

  const prompt = buildUnderwritingAnalysisPrompt(input || {});

  const payload = {
    model: 'gpt-4.1-mini',
    input: prompt,
    temperature: 0.1
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI request failed: ' + response.getContentText());
  }

  const text = extractResponseText(body);
  return normalizeUnderwritingJson(JSON.parse(stripCodeFences(text)));
}

function buildUnderwritingAnalysisPrompt(input) {
  return [
    'You are an MCA underwriting document-analysis assistant for Vancouver Finance Company Inc.',
    'Analyze only the supplied application context and bank statement text.',
    'Do not invent numbers. If a field cannot be determined, use 0, unknown, or an empty array.',
    'Calculate deposits, withdrawals, NSFs, negative days, cash inflow, cash outflow, MCA payments, and affordability from the statements.',
    'Do not make a final lending decision. Final approval must be completed by a human underwriter.',
    'Return valid JSON only. No markdown. No extra commentary.',
    '',
    'Required JSON schema:',
    '{',
    '  "average_monthly_deposits": number,',
    '  "average_monthly_withdrawals": number,',
    '  "total_deposits": number,',
    '  "total_withdrawals": number,',
    '  "statement_months_reviewed": number,',
    '  "monthly_deposit_breakdown": [{ "month": "YYYY-MM", "total_deposits": number }],',
    '  "nsf_count": number,',
    '  "negative_days": number,',
    '  "existing_mca_payments": number,',
    '  "average_daily_balance": number,',
    '  "lowest_balance": number,',
    '  "large_deposits_to_verify": [{ "date": "YYYY-MM-DD", "amount": number, "description": "string" }],',
    '  "revenue_trend": "increasing|stable|declining|unknown",',
    '  "cash_flow_strength": "strong|moderate|weak|unknown",',
    '  "risk_flags": ["string"],',
    '  "risk_grade": "A|B|C|D",',
    '  "underwriter_notes": "string"',
    '}',
    '',
    'Application context:',
    'Business name: ' + (input.businessName || 'unknown'),
    'Owner name: ' + (input.ownerName || 'unknown'),
    'Credit score: ' + (input.creditScore || 'unknown'),
    'Time in business: ' + (input.timeInBusiness || 'unknown'),
    'Industry: ' + (input.industry || 'unknown'),
    '',
    'Bank statement text:',
    input.statementText || ''
  ].join('\n');
}

function normalizeUnderwritingJson(result) {
  result = result || {};
  return {
    average_monthly_deposits: Number(result.average_monthly_deposits || 0),
    average_monthly_withdrawals: Number(result.average_monthly_withdrawals || 0),
    total_deposits: Number(result.total_deposits || 0),
    total_withdrawals: Number(result.total_withdrawals || 0),
    statement_months_reviewed: Number(result.statement_months_reviewed || 0),
    monthly_deposit_breakdown: Array.isArray(result.monthly_deposit_breakdown) ? result.monthly_deposit_breakdown : [],
    nsf_count: Number(result.nsf_count || 0),
    negative_days: Number(result.negative_days || 0),
    existing_mca_payments: Number(result.existing_mca_payments || 0),
    average_daily_balance: Number(result.average_daily_balance || 0),
    lowest_balance: Number(result.lowest_balance || 0),
    large_deposits_to_verify: Array.isArray(result.large_deposits_to_verify) ? result.large_deposits_to_verify : [],
    revenue_trend: result.revenue_trend || 'unknown',
    cash_flow_strength: result.cash_flow_strength || 'unknown',
    risk_flags: Array.isArray(result.risk_flags) ? result.risk_flags : [],
    risk_grade: result.risk_grade || 'D',
    underwriter_notes: result.underwriter_notes || ''
  };
}

function extractResponseText(body) {
  if (body.output_text) return body.output_text;
  const chunks = [];
  (body.output || []).forEach(item => {
    (item.content || []).forEach(content => {
      if (content.text) chunks.push(content.text);
    });
  });
  return chunks.join('\n');
}

function stripCodeFences(text) {
  return String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function testOpenAIUnderwritingPromptShape() {
  const prompt = buildUnderwritingAnalysisPrompt({
    businessName: 'ABC Pizza Ltd',
    ownerName: 'John Smith',
    creditScore: 680,
    timeInBusiness: '3 years',
    industry: 'Restaurant',
    statementText: 'January deposits 71000. February deposits 73500. NSF fee Feb 12. Account negative for 2 days.'
  });
  Logger.log(prompt);
  return prompt;
}


function analyzeApplicationStatementFilesWithOpenAI(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties');

  input = input || {};
  const files = input.files || [];
  if (!files.length) throw new Error('No bank statement files found in the application Drive folder.');

  const content = [{
    type: 'input_text',
    text: buildUnderwritingAnalysisPrompt(input)
  }];

  files.forEach(file => {
    content.push({
      type: 'input_file',
      filename: file.fileName || 'bank-statement.pdf',
      file_data: 'data:' + (file.mimeType || 'application/pdf') + ';base64,' + file.base64Data
    });
  });

  const payload = {
    model: 'gpt-4.1-mini',
    input: [{ role: 'user', content }],
    temperature: 0.1
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI statement file request failed: ' + response.getContentText());
  }

  const text = extractResponseText(body);
  return normalizeUnderwritingJson(JSON.parse(stripCodeFences(text)));
}


function analyzeTrainingFileWithOpenAI(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties');

  const prompt = buildTrainingFilePrompt(input || {});
  const payload = {
    model: 'gpt-4.1-mini',
    input: prompt,
    temperature: 0.1
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI training-file request failed: ' + response.getContentText());
  }

  const text = extractResponseText(body);
  return JSON.parse(stripCodeFences(text));
}

function buildTrainingFilePrompt(input) {
  return [
    'You convert historical MCA underwriting files into one structured training row for Vancouver Finance Company Inc.',
    'Use only the supplied file text. Do not invent missing values.',
    'If a value cannot be determined, use 0, unknown, or an empty string.',
    'Return valid JSON only. No markdown. No extra commentary.',
    '',
    'Required JSON schema:',
    '{',
    '  "case_id": "string",',
    '  "lender_name": "Journey Capital|Merchant Growth|iCapital|Canacap Funding|Sheaves Capital|unknown",',
    '  "decision": "Approved|Declined|Unknown",',
    '  "funded": "Yes|No",',
    '  "approved_amount": number,',
    '  "requested_amount": number,',
    '  "industry": "string",',
    '  "time_in_business": "string",',
    '  "credit_score": number,',
    '  "average_monthly_deposits": number,',
    '  "average_monthly_withdrawals": number,',
    '  "total_deposits": number,',
    '  "total_withdrawals": number,',
    '  "statement_months_reviewed": number,',
    '  "nsf_count": number,',
    '  "negative_days": number,',
    '  "existing_mca_payments": number,',
    '  "average_daily_balance": number,',
    '  "lowest_balance": number,',
    '  "revenue_trend": "increasing|stable|declining|unknown",',
    '  "reason_approved": "string",',
    '  "reason_declined": "string",',
    '  "conditions": ["string"],',
    '  "statement_months_reviewed": number,',
    '  "decision_date": "YYYY-MM-DD or empty string",',
    '  "notes": "string"',
    '}',
    '',
    'File name: ' + (input.fileName || 'unknown'),
    'File URL: ' + (input.fileUrl || 'unknown'),
    '',
    'Training file text:',
    input.trainingText || ''
  ].join('\n');
}


function analyzeTrainingFileUploadWithOpenAI(input) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties');
  if (!input || !input.base64Data) throw new Error('Missing uploaded file data for OpenAI training parse');

  const prompt = buildTrainingFilePrompt({
    fileName: input.fileName,
    fileUrl: 'uploaded from admin portal',
    trainingText: buildTrainingMetadataText(input.metadata || {})
  });
  const mimeType = input.mimeType || 'application/pdf';
  const payload = {
    model: 'gpt-4.1-mini',
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: prompt
      }, {
        type: 'input_file',
        filename: input.fileName || 'historical-bank-statement.pdf',
        file_data: 'data:' + mimeType + ';base64,' + input.base64Data
      }]
    }],
    temperature: 0.1
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = JSON.parse(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI uploaded-file request failed: ' + response.getContentText());
  }

  const text = extractResponseText(body);
  return JSON.parse(stripCodeFences(text));
}

function buildTrainingMetadataText(metadata) {
  metadata = metadata || {};
  return [
    'Admin-entered case metadata, if provided:',
    'Lender: ' + (metadata.lenderName || 'unknown'),
    'Decision: ' + (metadata.decision || 'unknown'),
    'Approved amount: ' + (metadata.approvedAmount || 'unknown'),
    'Requested amount: ' + (metadata.requestedAmount || 'unknown'),
    'Industry: ' + (metadata.industry || 'unknown'),
    'Time in business: ' + (metadata.timeInBusiness || 'unknown'),
    'Credit score: ' + (metadata.creditScore || 'unknown'),
    'Average monthly deposits: ' + (metadata.averageMonthlyDeposits || 'unknown'),
    'NSF count: ' + (metadata.nsfCount || 'unknown'),
    'Negative days: ' + (metadata.negativeDays || 'unknown'),
    'Existing MCA payments: ' + (metadata.existingMcaPayments || 'unknown'),
    'Revenue trend: ' + (metadata.revenueTrend || 'unknown'),
    'Reason approved: ' + (metadata.reasonApproved || ''),
    'Reason declined: ' + (metadata.reasonDeclined || ''),
    'Conditions: ' + (metadata.conditions || ''),
    'Statement months reviewed: ' + (metadata.statementMonthsReviewed || 'unknown')
  ].join('\n');
}

function testOpenAIApiKeyConnection() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY in Apps Script Properties');

  const payload = {
    model: 'gpt-4.1-mini',
    input: 'Return exactly this JSON: {"ok":true,"message":"OpenAI API key works"}',
    temperature: 0
  };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const responseText = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI API key test failed: ' + responseText);
  }

  const body = JSON.parse(responseText);
  const text = extractResponseText(body);
  const result = {
    ok: true,
    status: status,
    message: 'OpenAI API key is working.',
    model: body.model || payload.model,
    outputText: text
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function testOpenAIHistoricalTrainingParse() {
  const result = analyzeTrainingFileWithOpenAI({
    fileName: 'sample-historical-case.txt',
    fileUrl: 'Apps Script diagnostic test',
    trainingText: [
      'Case ID: CASE-DIAGNOSTIC-001',
      'Lender Name: Journey Capital',
      'Decision: Approved',
      'Funded: Yes',
      'Approved Amount: 50000',
      'Requested Amount: 60000',
      'Industry: Restaurant',
      'Time in Business: 3 years',
      'Credit Score: 680',
      'Average Monthly Deposits: 70000',
      'NSF Count: 2',
      'Negative Days: 3',
      'Existing MCA Payments: 0',
      'Revenue Trend: stable',
      'Reason Approved: Strong deposits and stable cash flow',
      'Conditions: 6 months bank statements, void cheque, ID',
      'Statement Months Reviewed: 6',
      'Decision Date: 2026-01-01'
    ].join('\n')
  });

  const normalized = normalizeTrainingCase(result, 'sample-historical-case.txt');
  Logger.log(JSON.stringify(normalized, null, 2));
  return normalized;
}
