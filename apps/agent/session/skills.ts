import { loadSkills, type Skill } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelAssetPreview } from '../../../packages/contracts/generated/boundary.ts';

// 只让 SDK 解析已授权的元信息；正文每次经 Rust 读取，临时文件不保存正文或附件。
export function selectedSkillResources(selected: ModelAssetPreview[]): Skill[] {
  if (!selected.length) return [];
  const directory = mkdtempSync(join(tmpdir(), 'data-agent-skills-'));
  try {
    const paths = new Map<string, string>();
    for (const asset of selected) {
      if (!asset.native_path || !/^\/skills\/[A-Za-z0-9_-]+\/[1-9][0-9]*\/SKILL\.md$/.test(asset.native_path)) throw new Error('invalid_skill_resource');
      const name = 'skill-' + createHash('sha256').update(asset.id).digest('hex').slice(0, 40);
      const root = join(directory, name);
      mkdirSync(root, {mode: 0o700});
      writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(`${asset.name} — ${asset.scope}`)}\n---\n`, {mode: 0o600});
      paths.set(name, asset.native_path);
    }
    const parsed = loadSkills({cwd: directory, agentDir: directory, skillPaths: [directory], includeDefaults: false});
    if (parsed.diagnostics.length || parsed.skills.length !== selected.length) throw new Error('invalid_skill_resource');
    return parsed.skills.map(skill => {
      const filePath = paths.get(skill.name)!;
      return {...skill, filePath, baseDir: dirname(filePath)};
    });
  } finally { rmSync(directory, {recursive: true, force: true}); }
}
