"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {money,purchaseMoney}=require('../src/web/format');
test('reused display formatters preserve currency, rounding and special-value output',()=>{
 const values=[undefined,null,'',0,-0,1,-1,12345.5,-12345.5,'12345.67',NaN,Infinity,-Infinity,999999999999.99];
 for(let n=0;n<100;n++)values.push((n-50)*1234.567);
 for(const value of values){
  const number=Number(value||0);
  assert.equal(money(value),number.toLocaleString('en-UG',{style:'currency',currency:'UGX',currencyDisplay:'code',maximumFractionDigits:0}).replace('UGX','Ugx'));
  assert.equal(purchaseMoney(value),'Ugx '+number.toLocaleString('en-UG',{maximumFractionDigits:0}));
 }
});
test('financial display retains whole-shilling grouping and does not round stored values',()=>{
 assert.match(money(12345.67),/12,346/);assert.equal(purchaseMoney(-12345.67),'Ugx -12,346');
 const input={amount:12345.67};money(input.amount);assert.equal(input.amount,12345.67);
});
test('selling-rate display preserves six decimal places without converting the fraction to float', () => {
 const {rateMoney}=require('../src/web/format');
 assert.equal(rateMoney('1.234567'),'Ugx 1.234567');
 assert.equal(rateMoney('999999999998.999999'),'Ugx 999,999,999,998.999999');
 assert.equal(rateMoney('100.000000'),'Ugx 100');
});
