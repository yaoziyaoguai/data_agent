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
  // 边界类型描述JSON原值；时间格式由共享Schema验证，不转换为Date对象。
  const result = await quicktype({ inputData: data, lang, rendererOptions: options, inferDateTimes: false });
  let content = '// Generated from packages/contracts/schema.json; do not edit.\n' + result.lines.join('\n') + '\n';
  // 新结构采用Schema标签分支；quicktype的合并类会丢分支必填null并输出其他分支字段。
  const structured = definitions.SemanticStructure;
  if (structured?.oneOf) {
    if (lang === 'rust') {
      const merged = content.match(/pub struct SemanticStructure \{([\s\S]*?)\n\}/)?.[1];
      if (!merged) throw new Error('SemanticStructure Rust声明缺失');
      const types = new Map([...merged.matchAll(/pub (\w+): ([^\n]+),/g)].map((match) => [match[1], match[2]]));
      const variants = structured.oneOf.map((branch) => {
        const tag = branch.properties.kind.const;
        const name = tag.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join('');
        const fields = Object.entries(branch.properties).filter(([field]) => field !== 'kind').map(([field, property]) => {
          let type = types.get(field);
          if (!type) throw new Error('结构字段未生成：' + field);
          const nullable = (Array.isArray(property.type) && property.type.includes('null')) || property.anyOf?.some(branch => branch.type === 'null');
          if (branch.required.includes(field) && !nullable && type.startsWith('Option<')) type = type.slice(7, -1);
          const omit = !branch.required.includes(field) ? '        #[serde(skip_serializing_if = "Option::is_none")]\n' : '';
          return omit + '        ' + field + ': ' + type + ',';
        }).join('\n');
        return '    #[serde(rename = "' + tag + '")]\n    ' + name + ' {\n' + fields + '\n    },';
      }).join('\n');
      const declaration = '#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(tag = "kind", deny_unknown_fields)]\npub enum SemanticStructure {\n' + variants + '\n}';
      content = content.replace(/#\[derive\(Debug, Clone, Serialize, Deserialize\)\]\npub struct (\w+) \{([\s\S]*?)\n\}/g, (whole, name, body) => {
        if (!body.includes('pub kind: SemanticStructureKind,')) return whole;
        return name === 'SemanticStructure' ? declaration : 'pub type ' + name + ' = SemanticStructure;';
      });
    } else {
      const merged = content.match(/export interface SemanticStructure \{([\s\S]*?)\n\}/)?.[1];
      if (!merged) throw new Error('SemanticStructure TypeScript声明缺失');
      const types = new Map([...merged.matchAll(/(\w+)\??:\s+([^\n]+);/g)].map(match => [match[1], match[2]]));
      const branches = structured.oneOf.map(branch => '{\n' + Object.entries(branch.properties).map(([field, property]) => {
        const type = field === 'kind' ? JSON.stringify(property.const) : types.get(field);
        if (!type) throw new Error('结构字段未生成：' + field);
        return '    ' + field + (branch.required.includes(field) ? '' : '?') + ': ' + type + ';';
      }).join('\n') + '\n}').join(' | ');
      content = content.replace(/export interface (\w+) \{([\s\S]*?)\n\}/g, (whole, name, body) => {
        if (!/kind:\s+SemanticStructureKind;/.test(body)) return whole;
        return name === 'SemanticStructure' ? 'export type SemanticStructure = ' + branches + ';' : 'export type ' + name + ' = SemanticStructure;';
      });
    }
  }
  // 报告失效分支不能拥有正文；生成标签联合，让类型也保留同源Schema的状态边界。
  for (const typeName of ['AnalysisReportView', 'AnalysisReportPage', 'SkillDraft']) {
    const reportView = definitions[typeName];
    if (!reportView?.oneOf) continue;
    const nullable = property => (Array.isArray(property.type) && property.type.includes('null')) || property.anyOf?.some(branch => branch.type === 'null');
    if (lang === 'rust') {
      const merged = content.match(new RegExp('pub struct ' + typeName + ' \\{([\\s\\S]*?)\\n\\}'))?.[1];
      if (!merged) throw new Error(typeName + ' Rust声明缺失');
      const types = new Map([...merged.matchAll(/pub (\w+): ([^\n]+),/g)].map(match => [match[1], match[2]]));
      const variants = reportView.oneOf.map(branch => {
        const tag = branch.properties.status.const;
        const name = tag.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join('');
        const fields = Object.entries(branch.properties).filter(([field]) => field !== 'status').map(([field, property]) => {
          let type = types.get(field);
          if (!type) throw new Error('报告字段未生成：' + field);
          if (branch.required.includes(field) && !nullable(property) && type.startsWith('Option<')) type = type.slice(7, -1);
          return '        ' + field + ': ' + type + ',';
        }).join('\n');
        return '    #[serde(rename = "' + tag + '")]\n    ' + name + ' {\n' + fields + '\n    },';
      }).join('\n');
      content = content.replace(new RegExp('#\\[derive\\(Debug, Clone, Serialize, Deserialize\\)\\]\\npub struct ' + typeName + ' \\{[\\s\\S]*?\\n\\}'),
        '#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(tag = "status", deny_unknown_fields)]\npub enum ' + typeName + ' {\n' + variants + '\n}');
    } else {
      const merged = content.match(new RegExp('export interface ' + typeName + ' \\{([\\s\\S]*?)\\n\\}'))?.[1];
      if (!merged) throw new Error(typeName + ' TypeScript声明缺失');
      const types = new Map([...merged.matchAll(/(\w+)\??:\s+([^\n]+);/g)].map(match => [match[1], match[2]]));
      const branches = reportView.oneOf.map(branch => '{\n' + Object.entries(branch.properties).map(([field, property]) => {
        let type = field === 'status' ? JSON.stringify(property.const) : types.get(field);
        if (!type) throw new Error('报告字段未生成：' + field);
        if (!nullable(property)) type = type.replace(/\s*\|\s*null\b/g, '').replace(/\bnull\s*\|\s*/g, '');
        return '    ' + field + ': ' + type + ';';
      }).join('\n') + '\n}').join(' | ');
      content = content.replace(new RegExp('export interface ' + typeName + ' \\{[\\s\\S]*?\\n\\}'), 'export type ' + typeName + ' = ' + branches + ';');
    }
  }
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
