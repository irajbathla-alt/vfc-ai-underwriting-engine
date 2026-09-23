/**
 * RBC BANK ENGINE v2.1.1 — LOCKED
 * ONE PERMANENT RBC FILE.
 * Contains RBC extraction, deterministic printed-fact locking, debit/debt classification,
 * financing credits, returns, internal transfers, duplicate preservation and RBC self-tests.
 * Shared recurrence math and frozen-fact storage remain in BankingCore.gs.
 */
function vfcRbcBankProfile_(){
return{
id:'RBC',
label:'RBC',
status:'LOCKED',
rulesVersion:'RBC-2.1.1-LOCKED',
intakeContract:'BANK_MATCHED_FROZEN_LEDGER_V2',
aliases:['ROYAL BANK OF CANADA','RBC ROYAL BANK','RBC']
};
}
function vfcRbcExtractionRules_(){
return[
'RBC Account Summary: Total deposits & credits is total_deposits; Total cheques & debits is total_withdrawals.',
'RBC Account Activity: Cheques & Debits = DEBIT and Deposits & Credits = CREDIT.',
'RBC printed opening balance, closing balance, deposits and withdrawals must reconcile to the cent before the statement is saved. Printed Item returned NSF rows and visible negative running balances are also locked deterministically.',
'For RBC, preserve every visible Account Activity row needed for underwriting recurrence and credit analysis. Include e-Transfers, online transfers, BR TO BR transfers, PADs, auto payments, rent, utilities, payroll/service debits, credit-card payments, taxes, insurance, loans, mortgages, LOC/line-of-credit activity, leases, MCA activity and every visible credit. Duplicate cheque-image pages must not be extracted twice.',
'NSF/retry rule: preserve the original debit, the returned/NSF or reversal credit, and any later successful retry as separate printed facts. Do not delete the failed debit during extraction. The deterministic Banking Core nets a demonstrably reversed financing debit out of debt-service recurrence while retaining the NSF/return as a risk fact.',
'Preserve every visible debit containing LOAN, MORTGAGE, LOC, LINE OF CREDIT, CREDIT LINE, FINANCING, FINANCE, LEASE, LSE, MCA, AUTO PAYMENT or PAD exactly so recurrence can be tested deterministically.',
'Any debit explicitly containing LOAN, MORTGAGE, LOC/LINE OF CREDIT, FINANCING, MCA or LEASE is a financing-obligation candidate. It must recur before a fixed monthly equivalent is confirmed.',
'Same or near-identical dollar amount by itself NEVER proves debt. A recurring e-Transfer, online transfer, rent, tax, utility, payroll, card payment or unknown PAD remains informational or ignored for debt unless there is independent financing evidence.',
'General e-Transfers, online transfers, BR TO BR transfers, ATM/cash withdrawals and ordinary cheques are frozen as statement facts but are not debt candidates merely because they repeat or use the same amount.',
'For operating-deposit analysis, explicit BR TO BR credits and explicit TRANSFER FROM ACCOUNT credits are internal-account transfers unless the same credit is independently identified as financing proceeds. Generic customer e-Transfers are not excluded.',
'AUTO PAYMENT describes a payment method, not automatically a loan. Treat it as financing only when the counterparty/description is finance-like and the payment recurs.',
'A successful retry may print as MISC PAYMENT instead of AUTO PAYMENT. If the same finance-like counterparty appears, keep it under the same financing entity so the recurring obligation is not broken.',
'A generic PAD or pre-authorized debit is a recurring-payment candidate but is NOT confirmed financing unless lender/loan/MCA/finance/lease evidence is present.',
'A fee-related word only suppresses a line when there is no independent financing signal. A loan/financing/lease/MCA line that also contains a fee word must still be preserved for recurrence testing.',
'PAY-FILE FEE / PAY-FILE FEES and ordinary bank/service/transaction fees are fees only and must not become recurring obligations.',
'AFFIRM CANADA is a financing counterparty. Preserve AFFIRM CANADA debits exactly; recurring AFFIRM debits are confirmed financing debt, while a single observation remains unconfirmed.',
'Explicit PREMIUM FINANCE, PREMIUM FINANCING and IPFS payment wording is financing when recurring. Ordinary ICBC/life/insurance premium descriptions without financing wording remain informational.',
'Extract LOAN CREDIT, generic LOAN PAYMENT, numbered Loan payment NO.x and Loan interest NO.x.',
'Generic unnumbered LOAN PAYMENT with no lender, account number, loan number or identifiable counterparty is not a fixed debt obligation by itself. Preserve it as informational/revolving loan activity unless independent evidence links it to a specific financing obligation. Amount recurrence alone must never promote it to confirmed monthly debt.',
'Extract CSBFL advance / CSBFL loan advance credits as financing proceeds when printed in Deposits & Credits.',
'Preserve COMM EQUIP RENT/LSE SILVERCHEF debits exactly; treat SilverChef as recurring equipment lease financing when recurring.',
'Preserve Business PAD BDC exactly and preserve Investment MERCH PAD / Investment MERCHANT GROWTH exactly.',
'Journey/OnDeck aliases: JOURNEY, ONDECK and JTO. A credit memo containing TRF JTO is Journey/OnDeck financing proceeds when printed in Deposits & Credits.',
'Business PAD JOURNEY/ONDECK may be either a CREDIT or DEBIT; direction is controlled only by the printed RBC column.',
'Journey/OnDeck, Merchant Growth, Canacap and Greenbox are MCA-style exposures for stacking analysis when recurring. iCapital remains general financing unless the statement itself identifies an MCA.',
'Known financing entities for RBC recurrence include Canacap, iCapital, Greenbox and Affirm Canada in addition to the trained entities above; a debit still has to recur before it becomes fixed monthly debt.',
'Extract recurring insurance lines including ICBC, IND ALL LIFE IN, EQUITABLE LIFE and OWIC for informational analysis.',
'Extract commercial tax / EMPTX / GST lines, credit-card payments and potential financing credits.',
'A LOAN CREDIT printed in Deposits & Credits is always a CREDIT. Never turn it into a debit because of the word loan.',
'A credit containing explicit LOAN/MCA/MORTGAGE/LOC wording or a trained known financing entity is a financing-credit candidate; ordinary deposits, payroll/commission credits, owner transfers and generic deposits are not financing merely because they are large or the sender name contains Finance/Financing.',
'Do not duplicate cheque image pages.'
].join('\n');
}
function vfcRbcLockFacts_(summary,text,fileName){
const facts=vfcExtractPrintedStatementFacts_(text);
const name=String(fileName||'statement');
if(!facts.startDate||!facts.endDate||facts.opening===null||facts.closing===null||facts.deposits===null||facts.withdrawals===null){
throw new Error('RBC printed Account Summary could not be fully verified for '+name+'. Upload was stopped before saving incomplete statement totals.');
}
const diff=Math.abs((facts.opening+facts.deposits-facts.withdrawals)-facts.closing);
if(diff>.05){
throw new Error('RBC printed Account Summary does not reconcile for '+name+'. Difference: $'+vfcRound_(diff,.01)+'.');
}
const locked=Object.assign({},summary||{});
locked.statement_start_date=facts.startDate;
locked.statement_end_date=facts.endDate;
locked.opening_balance=facts.opening;
locked.closing_balance=facts.closing;
locked.total_deposits=facts.deposits;
locked.total_withdrawals=facts.withdrawals;
locked.nsf_count=vfcRbcCountNsf_(text);
locked.negative_balance_detected=vfcRbcNegativeBalanceFlag_(text,facts);
return locked;
}
function vfcRbcCountNsf_(text){
return(String(text||'').match(/ITEM\s+RETURNED\s+NSF|RETURNED\s+ITEM\s+NSF/gi)||[]).length;
}
function vfcRbcNegativeBalanceFlag_(text,facts){
if((facts&&facts.opening<0)||(facts&&facts.closing<0))return true;
return/(?:^|\s)-[0-9][0-9,]*\.\d{2}(?:\s|$)/m.test(String(text||''));
}
function vfcRbcClassifyDebit_(t){
const raw=String(t.description||'').replace(/\s+/g,' ').trim();
const s=raw.toUpperCase();
const cp=String(t.counterparty||'').replace(/\s+/g,' ').trim();
const hasFinancingSignal=/\bLOAN\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bFINANC(?:E|ING)?\b|\bMCA\b|\bLEASE\b|\bLSE\b/.test(s);
const isFeeLine=/\bFEES?\b|SERVICE\s+CHARGE|NSF\s+ITEM\s+FEES?|OVERDRAFT\s+INTEREST|PAYMENT\s+COVERAGE/.test(s);
if(isFeeLine&&!hasFinancingSignal)return null;
let family='';
let entityKey='';
let label=cp||raw;
let debtJustification='';
if(/COMM\s+EQUIP\s+RENT\/LSE\s+SILVERCHEF|\bSILVERCHEF\b/.test(s)){
family='FINANCING';entityKey='SILVERCHEF_EQUIPMENT_LEASE';label='SilverChef Equipment Lease';
debtJustification='Explicit equipment lease wording plus recurring SilverChef payments.';
}else if(/MERCH\s+PAD|MERCHANT\s+GROWTH/.test(s)){
family='MCA';entityKey='MERCHANT_GROWTH';label='Merchant Growth';
debtJustification='Known MCA/funding entity plus recurring payment cadence.';
}else if(/JOURNEY|ONDECK|\bJTO\b/.test(s)){
family='MCA';entityKey='JOURNEY_ONDECK';label='Journey / OnDeck';
debtJustification='Known MCA-style business financing entity plus recurring payment cadence.';
}else if(/\bBDC\b/.test(s)&&(/\bPAD\b|LOAN|FINANC/.test(s))){
family='FINANCING';entityKey='BDC';label='BDC';
debtJustification='BDC financing/loan/PAD wording plus recurring payment cadence.';
}else if(/\bAFFIRM(?:\s+CANADA)?\b/.test(s)){
family='FINANCING';entityKey='RBC_AFFIRM_CANADA';label='Affirm Canada';
debtJustification='Affirm Canada is a financing counterparty; recurring observed payments are treated as financing debt.';
}else if(/\bCANACAP\b/.test(s)){
family='MCA';entityKey='CANACAP';label='Canacap';
debtJustification='Known MCA-style business financing counterparty plus recurring observed payment cadence.';
}else if(/\bGREENBOX\b/.test(s)){
family='MCA';entityKey='GREENBOX';label='Greenbox';
debtJustification='Known MCA-style business financing counterparty plus recurring observed payment cadence.';
}else if(/\bICAPITAL\b/.test(s)){
family='FINANCING';entityKey='ICAPITAL';label='iCapital';
debtJustification='Known financing counterparty plus recurring observed payment cadence; iCapital is not assumed to be MCA without explicit MCA evidence.';
}else if(/\bIPFS\b|PREMIUM\s+FINANC/.test(s)){
family='FINANCING';entityKey='RBC_PREMIUM_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||'Premium Finance';
debtJustification='Explicit premium-finance wording plus recurring observed payment cadence.';
}else if(/\bCRA\b|\bCCRA\b|GST|HST|COMMERCIAL\s+TAXES|EMPTX|TXINS|TXBAL|\bTAX\b/.test(s)){
family='TAX';entityKey='RBC_OTHER_TAX_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
}else if(/INSURANCE/.test(s)){
family='OTHER';
if(/ICBC/.test(s)){entityKey='INSURANCE_ICBC';label='Auto Insurance ICBC';}
else if(/EQUITABLE\s+LIFE/.test(s)){entityKey='INSURANCE_EQUITABLE_LIFE';label='Insurance EQUITABLE LIFE';}
else if(/IND\s+ALL\s+LIFE/.test(s)){entityKey='INSURANCE_IND_ALL_LIFE';label='Insurance IND ALL LIFE IN';}
else if(/\bOWIC\b/.test(s)){entityKey='INSURANCE_OWIC';label='Insurance OWIC';}
else entityKey='RBC_OTHER_INSURANCE_'+vfcCounterpartyKey_(cp||raw);
}else if(/CREDIT\s+CARD|VISA\s+(ROYAL|TD|BNS)|RBC\s+CREDIT\s+CARD|MASTERCARD|AMERICAN\s+EXPRESS|\bAMEX\b|CAPITAL\s+ONE|\bMBNA\b/.test(s)){
family='OTHER';entityKey='RBC_OTHER_CARD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
}else if(/^AUTO\s+PAYMENT\b/.test(s)){
const clean=raw.replace(/^AUTO\s+PAYMENT\s*/i,'').trim();
const financeLike=/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b|CAPITAL\s+(?:LENDING|FINANCE|FUNDING)|CREDIT\s+(?:CORP|FINANCE|LENDING)/.test(s);
if(financeLike){
family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;
debtJustification='Recurring automatic payment to a finance-like counterparty; AUTO PAYMENT alone is not sufficient, so finance-like counterparty evidence is also required.';
}else{
family='OTHER';entityKey='RBC_OTHER_AUTOPAY_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;
}
}else if(/^MISC\s+PAYMENT\b/.test(s)&&(/\bAFS\b|FINANC|LEASE|LENDING|DEALER\s+ADVANTAGE|AUTO\s+FINANCE|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE|\bCANACAP\b|\bICAPITAL\b|\bGREENBOX\b|CAPITAL\s+(?:LENDING|FINANCE|FUNDING)|CREDIT\s+(?:CORP|FINANCE|LENDING)/.test(s))){
const clean=raw.replace(/^MISC\s+PAYMENT\s*/i,'').trim();
family='FINANCING';entityKey='AUTO_PAYMENT_FINANCE_'+vfcCounterpartyKey_(clean||cp||raw);label=clean||cp||raw;
debtJustification='Recurring or retry payment to the same finance-like counterparty, even though RBC printed MISC PAYMENT instead of AUTO PAYMENT.';
}else if(/^LOAN\s+PAYMENT$/i.test(raw)){
family='OTHER';entityKey='RBC_OTHER_GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';
}else if(hasFinancingSignal){
family='FINANCING';
debtJustification='Explicit loan/mortgage/LOC/financing/lease/MCA wording plus recurring observed cadence.';
if(/^LOAN\s+PAYMENT$/i.test(raw)){
entityKey='GENERIC_LOAN_PAYMENT';label='Generic LOAN PAYMENT';
}else{
const numbered=s.match(/(?:NO\.?|NUMBER|#)\s*([0-9-]{5,})/);
const genericDebtNumber=s.match(/\b(?:LOAN|MORTGAGE|LOC)\b[^0-9]{0,30}([0-9][0-9-]{5,})\b/);
const ref=numbered||genericDebtNumber;
if(ref){
const n=ref[1].replace(/[^0-9]/g,'');
if(/LOAN\s+INTEREST/.test(s)){entityKey='LOAN_INTEREST_'+n;label='Loan interest NO.'+n;}
else if(/PERSONAL\s+LOAN/.test(s)){entityKey='LOAN_'+n;label='Personal Loan '+n;}
else if(/\bLOAN\b/.test(s)){entityKey='LOAN_'+n;label='Loan payment NO.'+n;}
else if(/\bLEASE\b|\bLSE\b/.test(s)){entityKey='LEASE_'+n;label='Lease payment NO.'+n;}
else{entityKey='FINANCE_REF_'+n;label=(cp||raw)+' NO.'+n;}
}else{
const stable=(cp||raw).replace(/\b[0-9][0-9-]{4,}\b/g,'').replace(/\s+/g,' ').trim();
entityKey='RBC_FINANCE_'+vfcCounterpartyKey_(stable||cp||raw);label=cp||raw;
}
}
}else if(/\bPAD\b|PRE[- ]?AUTH/.test(s)){
family='OTHER';entityKey='RBC_OTHER_PAD_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
}else if(/\bCAPITAL\b|\bFUNDING\b|\bFACTOR(?:ING)?\b/.test(s)){
family='OTHER';entityKey='RBC_OTHER_POSSIBLE_FINANCE_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
}else if(/COMMERCIAL\s+RENT|\bRENT\b|HYDRO|FORTIS|TELUS|UTILITY|SUPERPASS|PETROLEUM|\bFUEL\b|EQUIPMENT\s+RENT|MISC\s+PAYMENT|PAY\s+EMPLOYEE|PAYROLL/.test(s)){
family='OTHER';entityKey='RBC_OTHER_BUSINESS_'+vfcCounterpartyKey_(cp||raw);label=cp||raw;
}else{
return null;
}
if(!entityKey)entityKey='RBC_OTHER_'+vfcCounterpartyKey_(raw);
return Object.assign({},t,{family:family,entityKey:entityKey,key:entityKey,label:label,debtJustification:debtJustification});
}
function vfcRbcIsReturnedFinancingCredit_(t){
const s=String(t&&t.description||'').toUpperCase();
return/ITEM\s+RETURNED\s+NSF|RETURNED\s+ITEM|RETURNED\s+PAYMENT|RETURNED\s+UNPAID|PAYMENT\s+RETURNED|\bREVERSAL\b/.test(s);
}
function vfcRbcIsNonOperatingTransferCredit_(t){
if(String(t&&t.direction||'').toUpperCase()!=='CREDIT')return false;
const s=String(t&&t.description||'').toUpperCase();
if(/E-TRANSFER|INTERAC/.test(s))return false;
return/\bBR\s+TO\s+BR\b|\bTRANSFER\s+FROM\s+(?:ACCOUNT|A\/C|ACCT)\b|\bINTERNAL\s+TRANSFER\b/.test(s);
}
function vfcRbcKnownFinancingCredit_(t){
const s=String((t&&t.description)||'').toUpperCase();
if(vfcRbcIsReturnedFinancingCredit_(t))return false;
return/\bBDC\b|MERCHANT\s+GROWTH|JOURNEY|ONDECK|\bJTO\b|CANACAP|\bICAPITAL\b|GREENBOX|\bCSBFL\b|\bLOAN\b|\bMCA\b|\bMORTGAGE\b|\bLOC\b|LINE\s+OF\s+CREDIT|CREDIT\s+LINE/.test(s);
}
function vfcRbcPreservePrintedDuplicate_(t){
const direction=String(t&&t.direction||'').toUpperCase();
if(direction!=='CREDIT')return false;
return vfcRbcKnownFinancingCredit_(t)||vfcRbcIsReturnedFinancingCredit_(t)||vfcRbcIsNonOperatingTransferCredit_(t);
}
function vfcRbcStrongEntityKey_(key){
return/^(RBC_AFFIRM_CANADA|RBC_PREMIUM_FINANCE_|BDC|MERCHANT_GROWTH|JOURNEY_ONDECK|CANACAP|ICAPITAL|GREENBOX|SILVERCHEF_EQUIPMENT_LEASE|AUTO_PAYMENT_FINANCE_|RBC_FINANCE_|RBC_OTHER_|INSURANCE_|LEASE_[0-9]|FINANCE_REF_[0-9])/.test(String(key||'').toUpperCase());
}
function runRbcBankingSelfTests(){
const results=[];
function tx(date,description,direction,amount,counterparty){return{date:date,description:description,counterparty:counterparty||description,direction:direction,amount:amount};}
function row(end,transactions){return{payload:{statementEndDate:end,bankId:'RBC',transactions:transactions||[]}};}
function close(actual,expected,tol,label){tol=tol==null?.02:tol;if(Math.abs(Number(actual||0)-Number(expected||0))>tol)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
function equal(actual,expected,label){if(actual!==expected)throw new Error((label||'value')+' expected '+expected+' but got '+actual);}
function truthy(value,label){if(!value)throw new Error((label||'value')+' expected truthy');}
function test(name,fn){try{const detail=fn()||'';results.push({name:name,pass:true,detail:String(detail||'')});}catch(e){results.push({name:name,pass:false,detail:String(e&&e.message||e)});}}
test('RBC printed NSF count and negative balance flag are deterministic',function(){
equal(vfcRbcCountNsf_('Item returned NSF 2375.88\nItem returned NSF 419.40'),2,'NSF count');
truthy(vfcRbcNegativeBalanceFlag_('Balance -1,915.48',{opening:462.40,closing:35606.52}),'negative running balance');
equal(vfcRbcNegativeBalanceFlag_('Balance 1,915.48',{opening:462.40,closing:35606.52}),false,'positive-only statement');
return'nsf=2, negative=true';
});
test('RBC BR TO BR credit is internal transfer but customer e-Transfer is not',function(){
truthy(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-14','BR TO BR - 0212','CREDIT',15000)),'BR TO BR transfer');
equal(vfcRbcIsNonOperatingTransferCredit_(tx('2026-01-15','e-Transfer received CUSTOMER A','CREDIT',15000)),false,'customer e-transfer');
return'transfers separated';
});
test('RBC CSBFL BR TO BR advance remains financing, not transfer exclusion',function(){
const printed=vfcNormalizeTransactions_([tx('2026-03-10','BR TO BR - Credit Memo 7512 CSBFL advance Loan: 09530611-001','CREDIT',13775,'CSBFL')],'RBC');
const d=vfcDebtProfile_([row('2026-03-31',printed)]);
const transfers=vfcNonOperatingTransferCredits_(printed.map(function(t){return Object.assign({bankId:'RBC'},t);}));
close(d.financingCreditsTotal,13775,.02,'financing credit');
equal(transfers.length,0,'transfer exclusions');
return'financing='+d.financingCreditsTotal;
});
test('RBC recurring Affirm Canada is confirmed financing debt',function(){
const d=vfcDebtProfile_([
row('2026-02-20',[tx('2026-02-06','Misc Payment AFFIRM CANADA REF-DA34122F93D','DEBIT',66.62,'AFFIRM CANADA')]),
row('2026-03-20',[tx('2026-03-06','Misc Payment AFFIRM CANADA REF-724FB64C7B5','DEBIT',66.62,'AFFIRM CANADA')]),
row('2026-04-22',[tx('2026-04-09','Misc Payment AFFIRM CANADA REF-C57E487D0BD','DEBIT',66.62,'AFFIRM CANADA')]),
row('2026-05-22',[tx('2026-05-07','Misc Payment AFFIRM CANADA REF-84B25583A57','DEBIT',66.62,'AFFIRM CANADA')]),
row('2026-06-22',[tx('2026-06-08','Misc Payment AFFIRM CANADA REF-267B24CD695','DEBIT',66.62,'AFFIRM CANADA')]),
row('2026-07-22',[tx('2026-07-08','Misc Payment AFFIRM CANADA REF-9DFC7780243','DEBIT',66.62,'AFFIRM CANADA')])
]);
close(d.confirmedMonthlyDebtService,66.62,.02,'Affirm debt');
equal(d.activeDebtObligations.length,1,'Affirm obligation count');
equal(d.activeDebtObligations[0].entityKey,'RBC_AFFIRM_CANADA','Affirm identity');
return'debt='+d.confirmedMonthlyDebtService;
});
test('RBC single Affirm Canada observation is not fabricated into monthly debt',function(){
const d=vfcDebtProfile_([row('2026-02-20',[tx('2026-02-06','Misc Payment AFFIRM CANADA REF-ONE','DEBIT',66.62,'AFFIRM CANADA')])]);
close(d.confirmedMonthlyDebtService,0,.001,'single Affirm debt');
equal(d.observedOnce.length,1,'single Affirm observed once');
return'observed once';
});
test('RBC PAY-FILE FEES are suppressed as fees',function(){
equal(vfcRbcClassifyDebit_(tx('2026-06-01','Misc Payment PAY-FILE FEES','DEBIT',2,'PAY-FILE FEES')),null,'PAY-FILE FEES');
equal(vfcRbcClassifyDebit_(tx('2026-06-01','Monthly fee','DEBIT',6,'Monthly fee')),null,'monthly fee');
return'fees excluded';
});
test('RBC MCA-style funders and iCapital use correct families',function(){
equal(vfcRbcClassifyDebit_(tx('2026-01-03','JOURNEY/ONDECK BUS','DEBIT',900,'JOURNEY')).family,'MCA','Journey');
equal(vfcRbcClassifyDebit_(tx('2026-01-03','CANACAP Funding payment','DEBIT',900,'CANACAP')).family,'MCA','Canacap');
equal(vfcRbcClassifyDebit_(tx('2026-01-03','GREENBOX CAPITAL','DEBIT',900,'GREENBOX')).family,'MCA','Greenbox');
equal(vfcRbcClassifyDebit_(tx('2026-01-03','ICAPITAL payment','DEBIT',900,'ICAPITAL')).family,'FINANCING','iCapital');
return'families correct';
});
test('RBC premium finance is financing while ordinary insurance remains informational',function(){
equal(vfcRbcClassifyDebit_(tx('2026-01-16','PREMIUM FINANCE PAYMENT','DEBIT',366.73,'PREMIUM FINANCE')).family,'FINANCING','premium finance');
equal(vfcRbcClassifyDebit_(tx('2026-01-16','ICBC INSURANCE','DEBIT',366.73,'ICBC')).family,'OTHER','ordinary insurance');
return'insurance separated';
});
test('RBC six-statement deposit profile retains severe decline signal',function(){
const deposits=[20723.05,69571.19,48623.43,547.73,2152,700];
close(deposits.reduce(function(a,b){return a+b;},0),142317.40,.02,'total deposits');
close(deposits.reduce(function(a,b){return a+b;},0)/6,23719.5667,.02,'six-statement average');
close((547.73+2152+700)/3,1133.2433,.02,'latest three average');
truthy(vfcTrend_(deposits)<-.95,'severe decline');
return'avg=23719.57, recent3=1133.24';
});
test('Personal loan is confirmed monthly debt',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)]),
row('2026-02-28',[tx('2026-02-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)]),
row('2026-03-31',[tx('2026-03-05','Personal Loan SPL 000329209037884','DEBIT',1322.82)])
]);
close(d.confirmedMonthlyDebtService,1322.82,.02,'personal loan monthly debt');
equal(d.activeDebtObligations.length,1,'personal loan obligation count');
if(!/Explicit loan|financing/i.test(d.activeDebtObligations[0].debtJustification||''))throw new Error('missing debt justification');
return d.activeDebtObligations[0].counterparty+' '+d.confirmedMonthlyDebtService;
});
test('Lincoln NSF plus retry counts once',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')]),
row('2026-02-28',[tx('2026-02-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA'),tx('2026-02-05','Item returned NSF','CREDIT',1367.54,'Item returned NSF'),tx('2026-02-09','Misc Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')]),
row('2026-03-31',[tx('2026-03-05','Auto Payment LINCOLN AFS CA','DEBIT',1367.54,'LINCOLN AFS CA')])
]);
close(d.confirmedMonthlyDebtService,1367.54,.02,'Lincoln monthly debt');
equal(d.returnedFinanceDebitsSuppressed,1,'returned financing debit suppression');
return'monthly='+d.confirmedMonthlyDebtService+', suppressed='+d.returnedFinanceDebitsSuppressed;
});
test('Generic unnumbered LOAN PAYMENT remains informational even when recurring',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-10','LOAN PAYMENT','DEBIT',4500,'LOAN PAYMENT')]),
row('2026-02-28',[tx('2026-02-10','LOAN PAYMENT','DEBIT',5500,'LOAN PAYMENT')]),
row('2026-03-31',[tx('2026-03-10','LOAN PAYMENT','DEBIT',8750,'LOAN PAYMENT')])
]);
close(d.confirmedMonthlyDebtService,0,.001,'generic loan payment debt');
truthy(d.informationalMonthlyObligations>=0,'generic loan payment informational');
return'confirmed debt=0';
});
test('Same-dollar e-Transfers never become debt',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')]),
row('2026-02-28',[tx('2026-02-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')]),
row('2026-03-31',[tx('2026-03-10','e-Transfer sent JOHN DOE','DEBIT',1000,'JOHN DOE')])
]);
close(d.confirmedMonthlyDebtService,0,.001,'e-Transfer debt');
return'confirmed debt=0';
});
test('Unknown recurring PAD is informational, not debt',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),
row('2026-02-28',[tx('2026-02-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')]),
row('2026-03-31',[tx('2026-03-12','Business PAD ABC SERVICES','DEBIT',500,'ABC SERVICES')])
]);
close(d.confirmedMonthlyDebtService,0,.001,'unknown PAD debt');
close(d.informationalMonthlyObligations,500,.02,'unknown PAD informational amount');
return'informational='+d.informationalMonthlyObligations;
});
test('RBC Visa payments are informational, not fixed debt',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')]),
row('2026-02-28',[tx('2026-02-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')]),
row('2026-03-31',[tx('2026-03-13','Online Banking payment VISA ROYAL BNK','DEBIT',8000,'VISA ROYAL BNK')])
]);
close(d.confirmedMonthlyDebtService,0,.001,'Visa debt');
close(d.informationalMonthlyObligations,8000,.02,'Visa informational amount');
return'informational='+d.informationalMonthlyObligations;
});
test('CCRA weekly cadence is informational tax',function(){
const items1=[
tx('2026-01-06','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),
tx('2026-01-13','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),
tx('2026-01-20','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),
tx('2026-01-27','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA')
];
const items2=[
tx('2026-02-03','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),
tx('2026-02-10','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),
tx('2026-02-17','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA'),
tx('2026-02-24','PAD CCRA CANADA','DEBIT',768.71,'CCRA CANADA')
];
const d=vfcDebtProfile_([row('2026-01-31',items1),row('2026-02-28',items2)]);
close(d.confirmedMonthlyDebtService,0,.001,'CCRA debt');
close(d.informationalMonthlyObligations,768.71*52/12,.05,'CCRA monthly equivalent');
return'tax monthly='+d.informationalMonthlyObligations;
});
test('CSBFL advance is financing credit and numbered loan is debt',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-08','Loan payment NO.09530611 001','DEBIT',3232.33,'Loan payment NO.09530611 001')]),
row('2026-02-28',[tx('2026-02-08','Loan payment NO.09530611 001','DEBIT',3232.33,'Loan payment NO.09530611 001')]),
row('2026-03-31',[tx('2026-03-08','Loan payment NO.09530611 001','DEBIT',3232.33,'Loan payment NO.09530611 001'),tx('2026-03-10','BR TO BR - Credit Memo 7512 CSBFL advance Loan: 09530611-001','CREDIT',13775,'CSBFL')])
]);
close(d.confirmedMonthlyDebtService,3232.33,.02,'CSBFL loan payment');
close(d.financingCreditsTotal,13775,.02,'CSBFL financing credit');
return'debt='+d.confirmedMonthlyDebtService+', financing credit='+d.financingCreditsTotal;
});
test('iCapital large credit is financing; generic DLCI EFT is not',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-10','Credit Memo ICAPITAL FINANCING','CREDIT',50000,'ICAPITAL')]),
row('2026-02-28',[tx('2026-02-10','Misc Payment DLCI EFT','CREDIT',50000,'DLCI EFT')])
]);
close(d.financingCreditsTotal,50000,.02,'iCapital financing credit');
equal(d.financingCredits.length,1,'confirmed financing-credit count');
return'confirmed financing credit='+d.financingCreditsTotal;
});
test('Mortgage and LOC recurring payments are financing debt',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-05','Mortgage payment 123456789','DEBIT',2200,'Mortgage 123456789'),tx('2026-01-15','LOC payment 987654321','DEBIT',900,'LOC 987654321')]),
row('2026-02-28',[tx('2026-02-05','Mortgage payment 123456789','DEBIT',2200,'Mortgage 123456789'),tx('2026-02-15','LOC payment 987654321','DEBIT',900,'LOC 987654321')]),
row('2026-03-31',[tx('2026-03-05','Mortgage payment 123456789','DEBIT',2200,'Mortgage 123456789'),tx('2026-03-15','LOC payment 987654321','DEBIT',900,'LOC 987654321')])
]);
close(d.confirmedMonthlyDebtService,3100,.02,'mortgage plus LOC debt');
equal(d.activeDebtObligations.length,2,'mortgage/LOC obligation count');
return'confirmed debt='+d.confirmedMonthlyDebtService;
});
test('Loan line containing fee wording is not discarded',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-20','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456')]),
row('2026-02-28',[tx('2026-02-20','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456')]),
row('2026-03-31',[tx('2026-03-20','Loan payment service fee NO.123456','DEBIT',250,'Loan NO.123456')])
]);
close(d.confirmedMonthlyDebtService,250,.02,'loan-fee recurring debt');
return'confirmed debt='+d.confirmedMonthlyDebtService;
});
test('Capital One auto payment remains card/informational',function(){
const d=vfcDebtProfile_([
row('2026-01-31',[tx('2026-01-18','Auto Payment CAPITAL ONE MASTERCARD','DEBIT',700,'CAPITAL ONE')]),
row('2026-02-28',[tx('2026-02-18','Auto Payment CAPITAL ONE MASTERCARD','DEBIT',700,'CAPITAL ONE')]),
row('2026-03-31',[tx('2026-03-18','Auto Payment CAPITAL ONE MASTERCARD','DEBIT',700,'CAPITAL ONE')])
]);
close(d.confirmedMonthlyDebtService,0,.001,'Capital One debt');
close(d.informationalMonthlyObligations,700,.02,'Capital One informational amount');
return'informational='+d.informationalMonthlyObligations;
});
test('Known funders with same amount stay separate obligations',function(){
const rows=[];
['2026-01','2026-02','2026-03'].forEach(function(m,i){
const day=i===0?'31':i===1?'28':'31';
rows.push(row(m+'-'+day,[
tx(m+'-07','CANACAP Funding payment','DEBIT',1000,'CANACAP'),
tx(m+'-17','ICAPITAL payment','DEBIT',1000,'ICAPITAL')
]));
});
const d=vfcDebtProfile_(rows);
close(d.confirmedMonthlyDebtService,2000,.02,'same-amount known-funder debt');
equal(d.activeDebtObligations.length,2,'known-funder obligation count');
return'obligations='+d.activeDebtObligations.length;
});
test('Ambiguous same-day NSF does not suppress the wrong lender',function(){
const debits=[
Object.assign({bankId:'RBC'},tx('2026-01-10','CANACAP Funding payment','DEBIT',1000,'CANACAP')),
Object.assign({bankId:'RBC'},tx('2026-01-10','ICAPITAL payment','DEBIT',1000,'ICAPITAL'))
];
const credits=[Object.assign({bankId:'RBC'},tx('2026-01-10','Item returned NSF','CREDIT',1000,'Item returned NSF'))];
const kept=vfcSuppressReturnedFinanceDebits_(debits,credits);
equal(kept.length,2,'ambiguous return kept debit count');
return'kept='+kept.length;
});
const failed=results.filter(function(x){return!x.pass;});
return{
ok:failed.length===0,
coreVersion:VFC_BANK_ENGINE.VERSION,
rbcRulesVersion:vfcRbcBankProfile_().rulesVersion,
total:results.length,
passed:results.length-failed.length,
failed:failed.length,
results:results
};
}
function runBankingStabilitySelfTests(){return runRbcBankingSelfTests();}
