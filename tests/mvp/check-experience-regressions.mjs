import {spawnSync} from 'node:child_process';
const cases = [
  'asset-editor-browser', 'asset-mutation-browser', 'asset-dependencies-browser',
  'workspace-feedback-browser', 'semantic-role-boundaries-browser',
  'creator-ownership-browser', 'semantic-governance-browser',
  'related-knowledge-browser', 'management-buttons',
  'browser', 'query-boundaries', 'knowledge-experience-browser', 'asset-experience-browser', 'evidence-return-browser',
];
const failed = [], passed = [];
for (const name of (process.argv.length > 2 ? process.argv.slice(2) : cases)) {
  console.log(`Regression: ${name}`);
  const result = spawnSync(process.execPath, [`tests/mvp/check-${name}.mjs`], {stdio:'inherit',timeout:180000});
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    failed.push(name);
  } else {
    passed.push(name);
  }
}
console.log(JSON.stringify({passed,failed,officialRequests:0}));
if(failed.length) process.exit(1);
