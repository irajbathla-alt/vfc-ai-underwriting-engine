/** RBC v1.5 — CANDIDATE / REVALIDATION REQUIRED. */
function vfcRbcBankProfile_(){return{id:'RBC',label:'RBC',status:'CANDIDATE',rulesVersion:'RBC-1.5-CANDIDATE',aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']};}

function vfcRbcExtractionRules_(){return [
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT.',
  'For RBC, freeze every visible Account Activity transaction needed for underwriting recurrence and credit analysis. Include e-Transfers, online transfers, PADs, auto payments, rent, utilities, payroll/service debits, credit-card payments, taxes, insurance, loans, mortgages, LOC/line-of-credit activity, leases, MCA activity and every visible credit. Duplicate cheque-image pages must not be extracted twice.',
  'NSF retry rule: when a debit is clearly reversed/returned by an Item returned NSF or equivalent same-amount return and then retried, do not keep the failed debit as a completed obligation payment in banking_transactions. Preserve the NSF/returned event through nsf_count/negative-balance/risk facts and keep the later successful retry. This prevents one monthly obligation from being counted twice.',
  'Preserve every completed debit containing LOAN, MORTGAGE, LOC, LINE OF CREDIT, CREDIT LINE, FINANCING, FINANCE, LEASE, LSE, MCA, AUTO PAYMENT or PAD exactly so recurrence can be tested deterministically.',
  'Any completed debit explicitly containing LOAN, MORTGAGE, LOC/LINE OF CREDIT, FINANCING, MCA or LEASE is a financing-obligation candidate. It must recur before a fixed monthly equivalent is confirmed.',
  'Same or near-identical dollar amount by itself NEVER proves debt. A recurring e-Transfer, online transfer, rent, tax, utility, payroll, card payment or unknown PAD remains informational or ignored for debt unless there is independent financing evidence.',
  'General e-Transfers, online transfers, BR TO BR transfers, ATM/cash withdrawals and ordinary cheques are frozen as statement facts but are not debt candidates merely because they repeat or use the same amount.',
  'AUTO PAYMENT describes a payment method, not automatically a loan. Treat it as financing only when the counterparty/description is finance-like and the payment recurs.',
  'A successful retry may print as MISC PAYMENT instead of AUTO PAYMENT. If the same finance-like counterparty appears, keep it under the same financing entity so the recurring obligation is not broken.',
  'A generic PAD or pre-authorized debit is a recurring-payment candidate but is NOT confirmed financing unless lender/loan/MCA/finance/lease evidence is present.',
  'A fee-related word only suppresses a line when there is no independent financing signal. A loan/financing/lease/MCA line that also contains a fee word must still be preserved for recurrence testing.',
  'Extract LOAN CREDIT, generic LOAN PAYMENT, numbered Loan payment NO.x and Loan interest NO.x.',
  'Extract CSBFL advance / CSBFL loan advance credits as financing proceeds when printed in Deposits & Credits.',
  'Preserve COMM EQUIP RENT/LSE SILVERCHEF debits exactly; treat SilverChef as recurring equipment lease financing when recurring.',
  'Preserve Business PAD BDC exactly and preserve Investment MERCH PAD / Investment MERCHANT GROWTH exactly.',
  'Journey/OnDeck aliases: JOURNEY, ONDECK and JTO. A credit memo containing TRF JTO is Journey/OnDeck financing proceeds when printed in Deposits & Credits.',
  'Business PAD JOURNEY/ONDECK may be either a CREDIT or DEBIT; direction is controlled only by the printed RBC column.',
  'Extract recurring insurance lines including ICBC, IND ALL LIFE IN, EQUITABLE LIFE and OWIC for informational analysis.',
  'Extract commercial tax / EMPTX / GST lines, credit-card payments and potential financing credits.',
  'A LOAN CREDIT printed in Deposits & Credits is always a CREDIT. Never turn it into a debit because of the word loan.',
  'A credit containing explicit LOAN/MCA/MORTGAGE/LOC wording or a trained known financing entity is a financing-credit candidate; ordinary deposits, payroll/commission credits, owner transfers and generic deposits are not financing merely because they are large or the sender name contains Finance/Financing.',
  'Do not duplicate cheque image pages.'
].join('\n');}
function vfcRbcLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}

function vfcRbcClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim();
  const s=raw.toUpperCase();
  const cp=String(t.counterparty||'').replace(/\s+/g,' ').trim();
  const hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s);
  const isFeeLine=/\bFEE\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEE|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s);
  if(isFeeLine&&!hasFinancingSignal)return null;

  let family='',entityKey='',label=cp||raw,debtJustification='';

  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){
    family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';
    debtJustification='Explicit equipment lease wording plus recurring SilverChef payments.';
  }
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){
    family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';
    debtJustification='Known MCA/funding entity plus recurring payment cadence.';
  }
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){
    family='FINANCING';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';
    debtJustification='Known financing entity plus recurring payment cadence.';
  }
  else if(/\bBDC\b/.test(s)&&(/\bPAD\b|LOAN|FINANC/.test(s))){
    family='FINANCING';entityKey='BDC';label='BDC';
    debtJustification='BDC financing/loan/PAD wording plus recurring payment cadence.';
  }
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){
    family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/INSURANCE|\bIPFS\b|PREMIUM\s+FIN/.test(s)){
    family='OTHER';
    if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}
    else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}
    else if(/IND\s+ALL\s+LIFE/.test(s)){entityKey='INSURANCE_IND_ALL_LIFE';label='Insurance IND ALL LIFE IN';}
    else if(/\bOWIC\b/.test(s)){entityKey='INSURANCE_OWIC';label='Insurance OWIC';}
    else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);
  }
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD/.test(s)){
    family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim();
    const financeLike=/\bAFS\b|FINANC|\bCREDIT\b|CAPITAL|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);
    if(financeLike){
      family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;
      debtJustification='Recurring automatic payment to a finance-like counterparty; AUTO PAYMENT alone is not sufficient, so finance-like counterparty evidence is also required.';
    }else{
      family='OTHER';entityKey='RBC_OTHER_AUTOPAY_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;
    }
  }
  else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|\bCREDIT\b|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s))){
    const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();
    family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;
    debtJustification='Recurring or retry payment to the same finance-like counterparty, even though RBC printed MISC PAYMENT instead of AUTO PAYMENT.';
  }
  else if(hasFinancingSignal){
    family='FINANCING';
    debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){
      entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';
    }else{
      const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/);
      const genericDebtNumber=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9]{6,})\b/);
      const ref=numbered||genericDebtNumber;
      if(ref){
        const n=ref[1].replace(/[^0-9]/g,'');
        if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}
        else if(/PERSONAL\s+LOAN/.test(s)){entityKey='LOAN_'+n;label='Personal Loan '+n;}
        else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}
        else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}
        else{entityKey='FINANCE_REF_'+n;label=(cp||raw)+' NO.'+n;}
      }else{
        const stable=(cp||raw).replace(/\b[0-9]{4,}\b/g,'').replace(/\s+/g,' ').trim();
        entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);label=cp||raw;
      }
    }
  }
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){
    family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){
    family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|MISC\s+PAYMENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){
    family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
  }
  else{
    return null;
  }

  if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}

function vfcRbcKnownFinancingCredit_(t){
  const s=String((t&&t.description)||'').toUpperCase();
  return /\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);
}
function vfcRbcStrongEntityKey_(key){
  return /^(BDC|MERCHANT_GROWTH|JOURNEY_ONDECK|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|RBC_OTHER_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());
}
