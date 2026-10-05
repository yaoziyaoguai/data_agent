import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {validateContract} from '../../packages/contracts/validate.ts';
const cases=JSON.parse(await readFile(new URL('./cases.json',import.meta.url),'utf8'));
const rust=JSON.parse(execFileSync('target/debug/validate_contracts',[],{input:JSON.stringify(cases),encoding:'utf8'}));
for(const [index,test] of cases.entries()){
 let valid=true;try{validateContract(test.schema,test.value);}catch{valid=false;}
 assert.equal(valid,test.valid,test.name+' JS');assert.equal(rust[index].valid,test.valid,test.name+' Rust');
 if(valid&&test.roundtrip){
  assert.deepEqual(rust[index].roundtrip,test.roundtrip_value??test.value,test.name+' exact roundtrip');
  validateContract(test.schema,rust[index].roundtrip);
  assert.equal(rust[index].roundtrip_valid,true,test.name+' Rust roundtrip remains valid');
 }
}
console.log(JSON.stringify({passed:cases.length,source:'shared JSON Schema',rust:true,typescript:true}));
