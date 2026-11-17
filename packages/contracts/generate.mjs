import { readFile, writeFile } from 'node:fs/promises';
import { quicktype, InputData, JSONSchemaInput, FetchingJSONSchemaStore } from 'quicktype-core';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const schema = await readFile(new URL('./schema.json', import.meta.url), 'utf8');
const definitions=JSON.parse(schema).$defs;
const input = new JSONSchemaInput(new FetchingJSONSchemaStore());
await input.addSource({ name: 'Boundary', schema });
// 新旧条件交集可使quicktype改用消费者字段命名；同一Schema的定义作为具名根，
// 与下方ContractTypes按全部$defs导出的既有约定一致，不复制或修改Schema。
await input.addSource({ name: 'ContractTypes', uris: ['Boundary#/$defs/'] });
// 两个匿名结构已被Rust/TS作为公开类型复用，沿原位置为其固定名字。
await input.addSource({ name: 'Hints', uris: ['Boundary#/$defs/KnowledgeSearchInput/properties/hints'] });
await input.addSource({ name: 'ResponseBudget', uris: ['Boundary#/$defs/DataToolInvocation/properties/response_budget'] });
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
  // 标签联合保留分支必填、空值与正文边界，避免合并类型丢失unknown。
  for (const [typeName, discriminator] of [['AnalysisReportView', 'status'], ['AnalysisReportPage', 'status'], ['SkillDraft', 'status'], ['KnowledgeSearchHit', 'record_kind'], ['KnowledgeReadItem', 'kind'], ['KnowledgeReadResult', 'state']]) {
    const reportView = definitions[typeName];
    if (!reportView?.oneOf) continue;
    const nullable = property => (Array.isArray(property.type) && property.type.includes('null')) || property.anyOf?.some(branch => branch.type === 'null');
    if (lang === 'rust') {
      const merged = content.match(new RegExp('pub struct ' + typeName + ' \\{([\\s\\S]*?)\\n\\}'))?.[1];
      if (!merged) throw new Error(typeName + ' Rust声明缺失');
      const types = new Map([...merged.matchAll(/pub (\w+): ([^\n]+),/g)].map(match => [match[1], match[2]]));
      const variants = reportView.oneOf.map(branch => {
        const tag = branch.properties[discriminator].const;
        const name = tag.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join('');
        const fields = Object.entries(branch.properties).filter(([field]) => field !== discriminator).map(([field, property]) => {
          const generatedField = field === 'ref' ? typeName.replace(/[A-Z]/g, (letter, index) => (index ? '_' : '') + letter.toLowerCase()) + '_ref' : field;
          let type = types.get(generatedField);
          if (!type) throw new Error(typeName + '字段未生成：' + field);
          if (branch.required.includes(field) && !nullable(property) && type.startsWith('Option<')) type = type.slice(7, -1);
          const rename = generatedField !== field ? '        #[serde(rename = ' + JSON.stringify(field) + ')]\n' : '';
          const optionalNullable = !branch.required.includes(field) && nullable(property);
          if (optionalNullable) type = 'Option<' + type + '>';
          const omit = optionalNullable
            ? '        #[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]\n'
            : !branch.required.includes(field) ? '        #[serde(skip_serializing_if = "Option::is_none")]\n' : '';
          return rename + omit + '        ' + generatedField + ': ' + type + ',';
        }).join('\n');
        return '    #[serde(rename = "' + tag + '")]\n    ' + name + ' {\n' + fields + '\n    },';
      }).join('\n');
      content = content.replace(new RegExp('#\\[derive\\(Debug, Clone, Serialize, Deserialize\\)\\]\\npub struct ' + typeName + ' \\{[\\s\\S]*?\\n\\}'),
        '#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(tag = ' + JSON.stringify(discriminator) + ', deny_unknown_fields)]\npub enum ' + typeName + ' {\n' + variants + '\n}');
    } else {
      const merged = content.match(new RegExp('export interface ' + typeName + ' \\{([\\s\\S]*?)\\n\\}'))?.[1];
      if (!merged) throw new Error(typeName + ' TypeScript声明缺失');
      const types = new Map([...merged.matchAll(/(\w+)\??:\s+([^\n]+);/g)].map(match => [match[1], match[2]]));
      const branches = reportView.oneOf.map(branch => '{\n' + Object.entries(branch.properties).map(([field, property]) => {
        let type = field === discriminator ? JSON.stringify(property.const) : types.get(field);
        if (!type) throw new Error(typeName + '字段未生成：' + field);
        if (!nullable(property)) type = type.replace(/\s*\|\s*null\b/g, '').replace(/\bnull\s*\|\s*/g, '');
        return '    ' + field + (branch.required.includes(field) ? '' : '?') + ': ' + type + ';';
      }).join('\n') + '\n}').join(' | ');
      content = content.replace(new RegExp('export interface ' + typeName + ' \\{[\\s\\S]*?\\n\\}'), 'export type ' + typeName + ' = ' + branches + ';');
    }
  }
  // 引用联合复用已修正的分支类型，避免再次合并丢失分支必填null。
  for (const typeName of ['EvidenceReadResult', 'SemanticResolution']) {
    const referenceUnion = definitions[typeName];
    if (!referenceUnion?.oneOf) continue;
    const variants = referenceUnion.oneOf.map(branch => branch.$ref.split('/').at(-1));
    if (lang === 'rust') {
      content = content.replace(new RegExp('#\\[derive\\(Debug, Clone, Serialize, Deserialize\\)\\]\\npub struct ' + typeName + ' \\{[\\s\\S]*?\\n\\}'),
        '#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(untagged)]\npub enum ' + typeName + ' {\n' +
        variants.map(name => '    ' + name + '(' + name + '),').join('\n') + '\n}');
    } else {
      content = content.replace(new RegExp('export interface ' + typeName + ' \\{[\\s\\S]*?\\n\\}'),
        'export type ' + typeName + ' = ' + variants.join(' | ') + ';');
    }
  }
  if (lang === 'typescript' && !/export (?:type|interface) AuthoritySnapshot\b/.test(content)) {
    // 开放映射根在TS不自动具名；从同源生成字段派生，保留全部扩展属性。
    content += '\nexport type AuthoritySnapshot = NonNullable<Checkpoint["authority_snapshot"]>;\n';
  }
  if(lang==='rust') {
    // quicktype将标签分支合为可选字段；按原schema省略缺失分支，保留必填null。
    // allOf被quicktype摊平为单结构；分支$ref解析后合并，required取并集，
    // 字段省略与否按该属性在schema中是否可空——可空字段保留显式null，不可空才省略。
    const resolveRef = (branch) => branch?.$ref?.startsWith('#/$defs/') ? definitions[branch.$ref.slice(8)] ?? {} : branch;
    const nullableProperty = (property) => {
      const resolved = resolveRef(property);
      const variants = resolved.anyOf ?? resolved.oneOf ?? [];
      return (Array.isArray(resolved.type) && resolved.type.includes('null'))
        || variants.some(variant => {
          const candidate = resolveRef(variant);
          return candidate.type === 'null' || (Array.isArray(candidate.type) && candidate.type.includes('null'));
        });
    };
    for(const [name,definition] of Object.entries(definitions)){
      if(!definition.oneOf && definition.type!=="object" && !definition.allOf)continue;
      let required,properties=definition.properties??{};
      const composition=!!(definition.allOf&&!definition.properties&&!definition.type);
      if(definition.oneOf){
        required=definition.oneOf.reduce((set,branch)=>set.filter(field=>(branch.required??[]).includes(field)),definition.oneOf[0].required??[]);
      } else if(definition.allOf && !definition.properties && !definition.type){
        required=[];properties={};
        const walk=(branch)=>{
          const resolved=resolveRef(branch);
          if(resolved.allOf){resolved.allOf.forEach(walk);return;}
          Object.assign(properties,resolved.properties??{});
          required=required.concat(resolved.required??[]);
        };
        definition.allOf.forEach(walk);
        required=[...new Set(required)];
      } else required=definition.required??[];
      const generatedName = {ControlDelivery: 'ControlDeliveryClass', ControlDeliveryFact: 'FactElement'}[name] ?? name;
      content=content.replace(new RegExp('(pub struct '+generatedName+' \\{)([\\s\\S]*?)(\\n\\})'),(whole,head,body,tail)=>head+body.replace(/(\n\s*)(pub (\w+): Option<[^\n]+>)/g,(field,space,declaration,property)=>required.includes(property)||(composition&&properties[property]&&nullableProperty(properties[property]))?field:space+'#[serde(skip_serializing_if = "Option::is_none")]'+space+declaration)+tail);
    }
    // 支持完整性的历史缺失与显式null均可解码，序列化仍保留各自原值。
    for (const name of ['SemanticStatement', 'PreparedStatement', 'HumanStatementInput']) {
      if (!definitions[name]?.properties?.supports_complete) continue;
      content = content.replace(new RegExp('(pub struct ' + name + ' \\{[\\s\\S]*?)#\\[serde\\(skip_serializing_if = "Option::is_none"\\)\\]\\s+pub supports_complete: Option<bool>,'),
        '$1#[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]\n    pub supports_complete: Option<Option<bool>>,');
    }
    if (content.includes('deserialize_with = "deserialize_present"'))
      content += '\nfn deserialize_present<\'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>\nwhere D: serde::Deserializer<\'de>, T: Deserialize<\'de> {\n    T::deserialize(deserializer).map(Some)\n}\n';
    content=execFileSync(process.env.RUSTFMT??path.join(homedir(),'.cargo/bin/rustfmt'),['--edition','2024','--emit','stdout'],{input:content,encoding:'utf8'});
  }
  const url = new URL('./generated/' + file, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== content) throw new Error(file + ' 与契约不一致');
  } else await writeFile(url, content);
}
const names = '// Generated from packages/contracts/schema.json; do not edit.\n' +
  "import type * as Boundary from './boundary.ts';\nexport interface ContractTypes {\n" +
  // quicktype会为与同名属性冲突的定义追加后缀；映射回实际导出的类型名。
  Object.keys(definitions).map(name => '  '+name+': Boundary.'+({ControlDeliveryFact:'FactElement',ControlDelivery:'ControlDeliveryClass'}[name]??name)+';').join('\n') + '\n}\n';
const namesUrl = new URL('./generated/names.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(namesUrl, 'utf8') !== names) throw new Error('names.ts 与契约不一致');
} else await writeFile(namesUrl, names);
