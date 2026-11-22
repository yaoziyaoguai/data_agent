import { createSyntheticSourceInfo, type Skill } from '@earendil-works/pi-coding-agent';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelAssetPreview } from '../../../packages/contracts/generated/boundary.ts';

// Pi 接收已选用的虚拟资源。正文和附件仍通过 Rust 的受控 read 读取。
export function selectedSkillResources(selected: ModelAssetPreview[]): Skill[] {
  return selected.map(asset => {
    const filePath = asset.native_path;
    if (!filePath || !/^\/skills\/[A-Za-z0-9_-]+\/[1-9][0-9]*\/SKILL\.md$/.test(filePath)) throw new Error('invalid_skill_resource');
    const baseDir = dirname(filePath);
    return {
      name: 'skill-' + createHash('sha256').update(asset.id).digest('hex').slice(0, 40),
      description: `${asset.name} — ${asset.scope}`,
      filePath, baseDir, disableModelInvocation: false,
      sourceInfo: createSyntheticSourceInfo(filePath, {source: 'inline', baseDir}),
    };
  });
}
