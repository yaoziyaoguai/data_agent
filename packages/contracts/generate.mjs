import { readFile, writeFile } from 'node:fs/promises';
import { quicktype, InputData, JSONSchemaInput, FetchingJSONSchemaStore } from 'quicktype-core';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const schema = await readFile(new URL('./schema.json', import.meta.url), 'utf8');
const definitions=JSON.parse(schema).$defs;
const input = new JSONSchemaInput(new FetchingJSONSchemaStore());
await input.addSource({ name: 'Boundary', schema });
const data = new InputData();
data.addInput(input);
for (const [lang, file, options] of [
  ['typescript', 'boundary.ts', { 'just-types': 'true' }],
  ['rust', 'boundary.rs', { visibility: 'public', 'derive-debug': 'true', 'density': 'dense' }],
]) {
  const result = await quicktype({ inputData: data, lang, rendererOptions: options });
  let content = '// Generated from packages/contracts/schema.json; do not edit.\n' + result.lines.join('\n') + '\n';
  if(lang==='rust') {
    // quicktype将标签分支合为可选字段；按原schema省略缺失分支，保留必填null。
    for(const [name,definition] of Object.entries(definitions)){
      if(!definition.oneOf && definition.type!=="object")continue;
      const required=definition.oneOf?definition.oneOf.reduce((set,branch)=>set.filter(field=>branch.required.includes(field)),definition.oneOf[0].required):definition.required??[];
      content=content.replace(new RegExp('(pub struct '+name+' \\{)([\\s\\S]*?)(\\n\\})'),(whole,head,body,tail)=>head+body.replace(/(\n\s*)(pub (\w+): Option<[^\n]+>)/g,(field,space,declaration,property)=>required.includes(property)?field:space+'#[serde(skip_serializing_if = "Option::is_none")]'+space+declaration)+tail);
    }
    content=execFileSync(process.env.RUSTFMT??path.join(homedir(),'.cargo/bin/rustfmt'),['--edition','2024','--emit','stdout'],{input:content,encoding:'utf8'});
  }
  const url = new URL('./generated/' + file, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== content) throw new Error(file + ' 与契约不一致');
  } else await writeFile(url, content);
}
const names = '// Generated from packages/contracts/schema.json; do not edit.\n' +
  "import type * as Boundary from './boundary.ts';\nexport interface ContractTypes {\n" +
  Object.keys(definitions).map(name => '  '+name+': Boundary.'+name+';').join('\n') + '\n}\n';
const namesUrl = new URL('./generated/names.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(namesUrl, 'utf8') !== names) throw new Error('names.ts 与契约不一致');
} else await writeFile(namesUrl, names);
