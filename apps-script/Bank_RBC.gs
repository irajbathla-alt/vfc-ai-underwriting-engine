/** RBC v1.3 — TRAINED / LOCKED. */
function vfcRbcBankProfile_(){return{id:'RBC',label:'RBC',status:'LOCKED',rulesVersion:'RBC-1.3-LOCKED',aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']};}

function vfcRbcExtractionRules_(){return [
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT.',
  'Preserve every debit containing LOAN, FINANCING, FINANCE, LEASE, LSE, MCA, AUTO PAYMENT or PAD so recurrence can be tested deterministically.',
  'Any debit explicitly containing LOAN is a financing-obligation candidate. If the same loan/payment recurs with the same or near-identical amount and regular cadence, include its monthly equivalent in confirmed debt.',
  'AUTO PAYMENT debits are financing-obligation candidates when recurring. A returned NSF/reversal followed by a retry does not create a second monthly obligation.',
  'Extract LOAN CREDIT, generic LOAN PAYMENT, numbered Loan payment NO.x and Loan interest NO.x.',
  'Extract CSBFL advance / CSBFL loan advance credits as financing proceeds when printed in Deposits & Credits.',
  'Preserve COMM EQUIP RENT/LSE SILVERCHEF debits exactly; treat SilverChef as recurring equipment lease financing when recurring.',
  'Preserve Business PAD BDC exactly and preserve Investment MERCH PAD / Investment MERCHANT GROWTH exactly.',
  'Journey/OnDeck aliases: JOURNEY, ONDECK and JTO. A credit memo containing TRF JTO is Journey/OnDeck financing proceeds when printed in Deposits & Credits.',
  'Business PAD JOURNEY/ONDECK may be either a CREDIT or DEBIT; direction is controlled only by the printed RBC column.',
  'Extract recurring insurance lines including ICBC, IND ALL LIFE IN, EQUITABLE LIFE and OWIC for informational analysis.',
  'Extract commercial tax / EMPTX / GST lines, credit-card payments and potential financing credits.',
  'A LOAN CREDIT printed in Deposits & Credits is always a CREDIT. Never turn it into a debit because of the word loan.',
  'Do not duplicate cheque image pages.'
].join('\n');}
function vfcRbcLockFacts_(summary,text,fileName){return vfcLockPrintedStatementFacts_(summary,text);}

function vfcRbcClassifyDebit_(t){
  const raw=String(t.description||'').replace(/\s+/g,' ').trim();
  const s=raw.toUpperCase();
  if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s))return null;
  if(/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|PETROLEUM|FUEL/.test(s))return null;
  let family='',entityKey='',label=t.counterparty||t.description;

  if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){
    family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';
  }
  else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){
    family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';
  }
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){
    family='FINANCING';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';
  }
  else if(/\bBDC\b/.test(s)&&(/\bPAD\b|LOAN|FINANC/.test(s))){
    family='FINANCING';entityKey='BDC';label='BDC';
  }
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){
    family='TAX';entityKey=vfcCounterpartyKey_(t.counterparty||t.description);label=t.counterparty||t.description;
  }
  else if(/INSURANCE|\bIPFS\b|PREMIUM\s+FIN/.test(s)){
    family='OTHER';
    if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}
    else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}
    else if(/IND\s+ALL\s+LIFE/.test(s)){entityKey='INSURANCE_IND_ALL_LIFE';label='Insurance IND ALL LIFE IN';}
    else if(/\bOWIC\b/.test(s)){entityKey='INSURANCE_OWIC';label='Insurance OWIC';}
    else entityKey=vfcCounterpartyKey_(t.counterparty||t.description);
  }
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD/.test(s)){
    family='OTHER';entityKey=vfcCounterpartyKey_(t.counterparty||t.description);label=t.counterparty||t.description;
  }
  else if(/^AUTO\s+PAYMENT\b/.test(s)){
    family='FINANCING';
    const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim();
    entityKey='AUTO_PAYMENT_'+vfcCounterpartyKey_(clean||raw);
    label=clean||raw;
  }
  else if(/\bLOAN\b|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s)){
    family='FINANCING';
    if(/^LOAN\s+PAYMENT$/i.test(raw)){
      entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';
    }else{
      const numbered=s.match(/(?:NO\.?|NUMBER)\s*([0-9-]{5,})/);
      const genericLoanNumber=s.match(/\bLOAN\b[^0-9]{0,30}([0-9]{6,})\b/);
      const loanNo=numbered||genericLoanNumber;
      if(loanNo){
        const n=loanNo[1].replace(/[^0-9]/g,'');
        if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}
        else if(/PERSONAL\s+LOAN/.test(s)){entityKey='LOAN_'+n;label='Personal Loan '+n;}
        else{entityKey='LOAN_'+n;label='Loan payment NO.'+n;}
      }else{
        entityKey=vfcCounterpartyKey_(t.counterparty||t.description);
        label=t.counterparty||t.description;
      }
    }
  }
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){
    family='PAD';entityKey=vfcCounterpartyKey_(t.counterparty||t.description);label=t.counterparty||t.description;
  }
  else return null;

  if(!entityKey)entityKey=vfcCounterpartyKey_(t.description);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label});
}

function vfcRbcKnownFinancingCredit_(t){const s=String((t&&t.description)||'').toUpperCase();return /\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|GREENBOX|\bCSBFL\b/.test(s);}
function vfcRbcStrongEntityKey_(key){return /^(BDC|MERCHANT_GROWTH|JOURNEY_ONDECK|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_)/.test(String(key||'').toUpperCase());}
