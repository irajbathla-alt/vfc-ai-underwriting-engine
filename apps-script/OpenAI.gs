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
    'Do not make a final lending decision. Final approval must be completed by a human underwriter.',
    'Return valid JSON only. No markdown. No extra commentary.',
    '',
    'Required JSON schema:',
    '{',
    '  "average_monthly_deposits": number,',
    '  "monthly_deposit_breakdown": [{ "month": "YYYY-MM", "total_deposits": number }],',
    '  "nsf_count": number,',
    '  "negative_days": number,',
    '  "existing_mca_payments": number,',
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
    monthly_deposit_breakdown: Array.isArray(result.monthly_deposit_breakdown) ? result.monthly_deposit_breakdown : [],
    nsf_count: Number(result.nsf_count || 0),
    negative_days: Number(result.negative_days || 0),
    existing_mca_payments: Number(result.existing_mca_payments || 0),
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
    '  "nsf_count": number,',
    '  "negative_days": number,',
    '  "existing_mca_payments": number,',
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
