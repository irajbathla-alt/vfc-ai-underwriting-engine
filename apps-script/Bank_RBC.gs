/** RBC v1.1 — TRAINED / LOCKED. */
function vfcRbcBankProfile_(){return{id:'RBC',label:'RBC',status:'LOCKED',rulesVersion:'RBC-1.1-LOCKED',aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']};}

function vfcRbcExtractionRules_(){return [
  'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
  'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT.',
  'Extract LOAN CREDIT, generic LOAN PAYMENT, numbered Loan payment NO.x and Loan interest NO.x.',
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
  const s=String(t.description||'').toUpperCase().replace(/\s+/g,' ').trim();
  if(/\bFEE\b|SERVICE\s+CHARGE|NSF|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s))return null;
  if(/SUPERPASS|GAS\s+BILL|HYDRO|FORTIS|TELUS|UTILITY|PETROLEUM|FUEL/.test(s))return null;
  let family='',entityKey='',label=t.counterparty||t.description;
  if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';}
  else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){family='FINANCING';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';}
  else if(/\bBDC\b/.test(s)&&(/\bPAD\b|LOAN|FINANC/.test(s))){family='FINANCING';entityKey='BDC';label='BDC';}
  else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){family='TAX';entityKey=vfcCounterpartyKey_(t.counterparty||t.description);label=t.counterparty||t.description;}
  else if(/INSURANCE|\bIPFS\b|PREMIUM\s+FIN/.test(s)){
    family='OTHER';
    if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}
    else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}
    else if(/IND\s+ALL\s+LIFE/.test(s)){entityKey='INSURANCE_IND_ALL_LIFE';label='Insurance IND ALL LIFE IN';}
    else if(/\bOWIC\b/.test(s)){entityKey='INSURANCE_OWIC';label='Insurance OWIC';}
    else entityKey=vfcCounterpartyKey_(t.counterparty||t.description);
  }
  else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD/.test(s)){family='OTHER';entityKey=vfcCounterpartyKey_(t.counterparty||t.description);label=t.counterparty||t.description;}
  else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){family='PAD';entityKey=vfcCounterpartyKey_(t.counterparty||t.description);label=t.counterparty||t.description;}
  else if(/LOAN\s+PAYMENT|LOAN\s+PYMT|LOAN\s+PMT|LOAN\s+INTEREST|\bFINANC/.test(s)){
    family='FINANCING';
    if(/^LOAN\s+PAYMENT$/i.test(String(t.description||'').trim())){entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';}
    else{
      const loanNo=s.match(/(?:NO\.?|NUMBER)\s*([0-9-]{5,})/);
      if(loanNo){const n=loanNo[1].replace(/[^0-9]/g,'');if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}else{entityKey='LOAN_'+n;label='Loan payment NO.'+n;}}
      else entityKey=vfcCounterpartyKey_(t.counterparty||t.description);
    }
  }else return null;
  if(!entityKey)entityKey=vfcCounterpartyKey_(t.description);
  return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label});
}

function vfcRbcKnownFinancingCredit_(t){const s=String((t&&t.description)||'').toUpperCase();return /\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|GREENBOX/.test(s);}
function vfcRbcStrongEntityKey_(key){return /^(BDC|MERCHANT_GROWTH|JOURNEY_ONDECK)$/.test(String(key||'').toUpperCase());}
