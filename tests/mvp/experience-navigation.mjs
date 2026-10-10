// 使用正式页面入口；这些助手只表达用户动作，不改变应用状态或接口响应。
export async function discardEditor(page) {
  await page.keyboard.press('Escape');
  const confirmation = page.getByRole('dialog', {name:'保留刚才的修改吗？', exact:true});
  if (await confirmation.isVisible()) await confirmation.getByRole('button', {name:'放弃修改', exact:true}).click();
}
export async function expandAsset(card) {
  const details = card.locator('.asset-full-content');
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}
export async function navigateWorkspace(page, name) {
  await page.locator('.workspace').waitFor();
  const menu = page.getByRole('button', {name:'展开导航', exact:true});
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', {name:'主导航', exact:true}).getByRole('button', {name:new RegExp(name)}).click();
}
export async function logoutWorkspace(page) {
  await page.locator('.workspace').waitFor();
  const menu = page.getByRole('button', {name:'展开导航', exact:true});
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', {name:'退出', exact:true}).click();
  await page.getByLabel('演示登录凭据').waitFor();
}
