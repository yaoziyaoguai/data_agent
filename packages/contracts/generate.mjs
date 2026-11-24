import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { quicktype, InputData, JSONSchemaInput, FetchingJSONSchemaStore } from 'quicktype-core';
import { getOptionValues } from 'quicktype-core/dist/esm/RendererOptions/index.js';
import { RustRenderer, RustTargetLanguage, rustOptions } from 'quicktype-core/dist/esm/language/Rust/index.js';
import { getPreferredNamingStyle, listMatchingNamingStyles } from 'quicktype-core/dist/esm/language/Rust/utils.js';
import { TypeScriptRenderer, TypeScriptTargetLanguage, tsFlowOptions } from 'quicktype-core/dist/esm/language/TypeScriptFlow/index.js';
import { nullableFromUnion, removeNullFromUnion } from 'quicktype-core/dist/esm/Type/TypeUtils.js';

const schema = await readFile(new URL('./schema.json', import.meta.url), 'utf8');
const definitions = JSON.parse(schema).$defs;
const note = '// Generated from packages/contracts/schema.json; do not edit.\n';

// 同一协议的这些根已对外提供分支类型。quicktype 保留类型名和子字段图，
// 各分支的字段、必填项与 null 语义直接按 Schema 发射。
const tags = new Map([
  ['SemanticStructure', 'kind'],
  ['AnalysisReportView', 'status'],
  ['AnalysisReportPage', 'status'],
  ['SkillDraft', 'status'],
  ['KnowledgeSearchHit', 'record_kind'],
  ['KnowledgeReadItem', 'kind'],
  ['KnowledgeReadResult', 'state'],
]);
const referenceUnions = new Set(['EvidenceReadResult', 'SemanticResolution']);
const definitionAliases = {
  ControlDeliveryClass: 'ControlDelivery',
  FactElement: 'ControlDeliveryFact',
  RunSnapshotElement: 'RunSnapshot',
  ConditionsQuerySemanticResolution: 'SemanticResolution',
  QueryViewQuerySemanticResolution: 'SemanticResolution',
};
const openKnowledgeEntries = new Set(
  ['SourceFacts', 'Suggestion', 'HumanOverride'].flatMap(kind =>
    ['', 'Class'].map(suffix => 'KnowledgeEntry' + kind + suffix)),
);
const explicitNull = new Map([
  ['DataToolOutcome', 'control_delivery'],
  ['ControlDeliveryFact', 'confirmation_state'],
  ['RunSnapshot', 'result_query_id'],
  ...['SemanticStatement', 'PreparedStatement', 'HumanStatementInput'].map(name =>
    [name, 'supports_complete']),
]);

function resolve(property) {
  return property.$ref ? definitions[property.$ref.split('/').at(-1)] : property;
}

function nullable(property) {
  const resolved = resolve(property);
  const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
  return types.includes('null') || (resolved.anyOf ?? resolved.oneOf ?? []).some(nullable);
}

function classShape(definition) {
  const composition = !definition.type && !definition.properties && !!definition.allOf;
  const shape = { properties: {}, required: new Set(), composition };
  if (definition.oneOf) {
    const branches = definition.oneOf.map(resolve);
    const required = branches[0].required ?? [];
    shape.required = new Set(required.filter(field =>
      branches.every(branch => branch.required?.includes(field))));
    return shape;
  }
  const walk = (property) => {
    const current = resolve(property);
    if (current.allOf) {
      current.allOf.forEach(walk);
    } else {
      Object.assign(shape.properties, current.properties);
      for (const field of current.required ?? []) shape.required.add(field);
    }
  };
  if (composition) definition.allOf.forEach(walk);
  else {
    shape.properties = definition.properties ?? {};
    shape.required = new Set(definition.required);
  }
  return shape;
}

const classShapes = new Map(Object.entries(definitions)
  .filter(([, definition]) => definition.type === 'object' || definition.oneOf || definition.allOf)
  .map(([name, definition]) => [name, classShape(definition)]));
// quicktype 会按根报文生成不同的内联结构名。空值语义仍来自同一原始字段定义。
for (const [names, schema] of [
  [['FluffyChannels', 'PurpleChannels'], definitions.SearchCoverage.properties.channels],
  [['FluffyResultNotification', 'PurpleResultNotification'], definitions.WorkspaceContext.properties.result_notification],
]) {
  for (const name of names) classShapes.set(name, classShape(schema));
}

function semanticAlias(renderer, type, publicName) {
  const kind = type.getProperties().get('kind');
  return publicName !== 'SemanticStructure' && kind?.type.kind === 'enum'
    && renderer.sourcelikeToString(renderer.nameForNamedType(kind.type)) === 'SemanticStructureKind';
}

function membersOf(definition) {
  return definition.oneOf.map(branch => branch.$ref.split('/').at(-1));
}

function fieldsOf(renderer, type) {
  const fields = new Map();
  renderer.forEachClassProperty(type, 'none', (name, field, property) => {
    fields.set(field, { name, type: property.type });
  });
  return fields;
}

function variantName(tag) {
  return tag.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join('');
}

class ContractRustRenderer extends RustRenderer {
  emitSourceStructure() {
    super.emitSourceStructure();
    if (this.usesExplicitNull) {
      this.ensureBlankLine();
      this.emitMultiline(`fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    T::deserialize(deserializer).map(Some)
}`);
    }
  }

  emitOptional(distinguishNull) {
    if (distinguishNull) {
      this.usesExplicitNull = true;
      this.emitLine('#[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "Option::is_none")]');
    } else {
      this.emitLine('#[serde(skip_serializing_if = "Option::is_none")]');
    }
  }

  optionalType(type) {
    if (type.kind === 'union') {
      const [nil] = removeNullFromUnion(type);
      if (nil !== null) return true;
    }
    return type.kind === 'any' || type.kind === 'null';
  }

  nonNullableType(type) {
    if (type.kind === 'union') {
      const single = nullableFromUnion(type);
      if (single !== null) return this.breakCycle(single, true);
      const [nil] = removeNullFromUnion(type);
      if (nil !== null) {
        const name = this.nameForNamedType(type);
        return this.isCycleBreakerType(type) ? ['Box<', name, '>'] : name;
      }
    }
    if (type.kind === 'any' || type.kind === 'null') return 'serde_json::Value';
    return this.breakCycle(type, true);
  }

  emitTaggedUnion(type, name, tag) {
    const fields = fieldsOf(this, type);
    this.emitLine('#[derive(Debug, Clone, Serialize, Deserialize)]');
    this.emitLine('#[serde(tag = ', JSON.stringify(tag), ', deny_unknown_fields)]');
    this.emitBlock(['pub enum ', name], () => {
      for (const branch of definitions[name].oneOf) {
        const value = branch.properties[tag].const;
        this.emitLine('#[serde(rename = ', JSON.stringify(value), ')]');
        this.emitLine(variantName(value), ' {');
        this.indent(() => {
          for (const [field, property] of Object.entries(branch.properties)) {
            if (field === tag) continue;
            const graph = fields.get(field);
            if (!graph) throw new Error(`Missing type-graph field ${name}.${field}`);
            if (this.sourcelikeToString(graph.name) !== field)
              this.emitLine('#[serde(rename = ', JSON.stringify(field), ')]');
            const isOptional = !branch.required.includes(field);
            const allowsNull = nullable(property);
            if (isOptional) this.emitOptional(allowsNull);
            let rustType = this.nonNullableType(graph.type);
            if (allowsNull) rustType = ['Option<', rustType, '>'];
            if (isOptional) rustType = ['Option<', rustType, '>'];
            this.emitLine(graph.name, ': ', rustType, ',');
          }
        });
        this.emitLine('},');
      }
    });
  }

  emitStructDefinition(type, className) {
    const name = this.sourcelikeToString(className);
    if (semanticAlias(this, type, name)) {
      this.emitDescription(this.descriptionForType(type));
      this.emitLine('pub type ', className, ' = SemanticStructure;');
      return;
    }
    const tag = tags.get(name);
    if (tag) {
      this.emitDescription(this.descriptionForType(type));
      this.emitTaggedUnion(type, name, tag);
      return;
    }
    if (referenceUnions.has(name)) {
      this.emitDescription(this.descriptionForType(type));
      this.emitLine('#[derive(Debug, Clone, Serialize, Deserialize)]');
      this.emitLine('#[serde(untagged)]');
      this.emitBlock(['pub enum ', className], () => {
        for (const member of membersOf(definitions[name]))
          this.emitLine(member, '(', member, '),');
      });
      return;
    }

    const schemaName = definitionAliases[name] ?? name;
    const shape = classShapes.get(schemaName);
    const extensible = openKnowledgeEntries.has(name);
    this.emitDescription(this.descriptionForType(type));
    this.emitLine('#[derive(Debug, Clone, Serialize, Deserialize)]');
    const namingStyles = [...type.getProperties().keys()].flatMap(listMatchingNamingStyles);
    const style = getPreferredNamingStyle(namingStyles, 'snake_case');
    if (style !== 'snake_case') this.emitLine('#[serde(rename_all = ', JSON.stringify(style), ')]');
    this.emitBlock(['pub struct ', className], () => {
      this.forEachClassProperty(type, 'none', (fieldName, field, property) => {
        this.emitDescription(this.descriptionForClassProperty(type, field));
        this.emitRenameAttribute(fieldName, field, 'snake_case', style);
        let rustType = this.breakCycle(property.type, true);
        if (this.optionalType(property.type)) {
          const distinguishNull = field === 'source_limits'
            || (extensible && field === 'structured_value') || explicitNull.get(schemaName) === field;
          const retainNull = shape?.composition && Object.hasOwn(shape.properties, field)
            && nullable(shape.properties[field]);
          if (distinguishNull || (shape && !shape.required.has(field) && !retainNull)) {
            this.emitOptional(distinguishNull);
            if (distinguishNull) rustType = ['Option<', rustType, '>'];
          }
        }
        this.emitLine(this.visibility, fieldName, ': ', rustType, ',');
      });
      if (extensible || name === 'WorkspaceTask') {
        this.emitLine('#[serde(flatten)]');
        this.emitLine('pub extra: std::collections::BTreeMap<String, serde_json::Value>,');
      }
    });
  }
}

class ContractTypeScriptRenderer extends TypeScriptRenderer {
  emitSourceStructure(filename) {
    super.emitSourceStructure(filename);
    // 开放映射根保留 Checkpoint 中同源的具名别名。
    this.ensureBlankLine(2);
    this.emitLine('export type AuthoritySnapshot = NonNullable<Checkpoint["authority_snapshot"]>;');
  }

  emitClassBlock(type, className) {
    const name = this.sourcelikeToString(className);
    if (semanticAlias(this, type, name)) {
      this.emitLine('export type ', className, ' = SemanticStructure;');
      return;
    }
    if (referenceUnions.has(name)) {
      this.emitLine('export type ', className, ' = ', membersOf(definitions[name]).join(' | '), ';');
      return;
    }
    const tag = tags.get(name);
    if (!tag) {
      super.emitClassBlock(type, className);
      return;
    }

    const fields = fieldsOf(this, type);
    const branches = definitions[name].oneOf;
    branches.forEach((branch, index) => {
      this.emitLine(index === 0 ? ['export type ', className, ' = {'] : '} | {');
      this.indent(() => {
        for (const [field, property] of Object.entries(branch.properties)) {
          if (field === tag) {
            this.emitLine(field, ': ', JSON.stringify(property.const), ';');
            continue;
          }
          const graph = fields.get(field);
          if (!graph) throw new Error(`Missing type-graph field ${name}.${field}`);
          const type = graph.type;
          const allowsNull = nullable(property);
          let source = this.sourceFor(type).source;
          if (type.kind === 'union' && !allowsNull) {
            const [nil, members] = removeNullFromUnion(type);
            if (nil !== null) {
              source = [...members].flatMap((member, index) =>
                [index ? ' | ' : '', this.sourceFor(member).source]);
            }
          }
          this.emitLine(field, branch.required.includes(field) ? ': ' : '?: ', source, ';');
        }
      });
    });
    this.emitLine('};');
  }
}

class ContractRustLanguage extends RustTargetLanguage {
  makeRenderer(renderContext, options) {
    return new ContractRustRenderer(this, renderContext, getOptionValues(rustOptions, options));
  }
}

class ContractTypeScriptLanguage extends TypeScriptTargetLanguage {
  makeRenderer(renderContext, options) {
    return new ContractTypeScriptRenderer(this, renderContext, getOptionValues(tsFlowOptions, options));
  }
}

const input = new JSONSchemaInput(new FetchingJSONSchemaStore());
await input.addSource({ name: 'Boundary', schema });
// 具名根固定公开的定义名与两个共享匿名结构名。
await input.addSource({ name: 'ContractTypes', uris: ['Boundary#/$defs/'] });
await input.addSource({ name: 'Hints', uris: ['Boundary#/$defs/KnowledgeSearchInput/properties/hints'] });
await input.addSource({ name: 'ResponseBudget', uris: ['Boundary#/$defs/DataToolInvocation/properties/response_budget'] });
const inputData = new InputData();
inputData.addInput(input);

async function save(file, generated) {
  const url = new URL('./generated/' + file, import.meta.url);
  if (process.argv.includes('--check')) {
    if (await readFile(url, 'utf8') !== generated) throw new Error(file + ' 与契约不一致');
  } else {
    await writeFile(url, generated);
  }
}

for (const [lang, file, rendererOptions] of [
  [new ContractTypeScriptLanguage(), 'boundary.ts', { 'just-types': 'true' }],
  [new ContractRustLanguage(), 'boundary.rs', { visibility: 'public', 'derive-debug': 'true', density: 'dense' }],
]) {
  // 时间格式由共享 Schema 校验，边界类型保留 JSON 字符串。
  const { lines } = await quicktype({ inputData, lang, rendererOptions, inferDateTimes: false });
  let generated = note + lines.join('\n');
  if (file === 'boundary.rs') {
    // 同一已校验报文直接用生成类型输出，映射的键序也要稳定。
    generated = generated.replaceAll(/\bHashMap\b/g, 'BTreeMap');
    generated = execFileSync(process.env.RUSTFMT ?? path.join(homedir(), '.cargo/bin/rustfmt'),
      ['--edition', '2024', '--emit', 'stdout'], { input: generated, encoding: 'utf8' });
  }
  await save(file, generated);
}

await save('names.ts', note
  + "import type * as Boundary from './boundary.ts';\nexport interface ContractTypes {\n"
  + Object.keys(definitions).map(name =>
    '  ' + name + ': Boundary.' + ({ControlDeliveryFact: 'FactElement', ControlDelivery: 'ControlDeliveryClass'}[name] ?? name) + ';').join('\n')
  + '\n}\n');
