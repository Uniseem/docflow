import { expect, test } from './helpers'

test('窗口标题为 DocFlow', async ({ launch }) => {
  const { page } = await launch({ mock: false })
  await expect(page).toHaveTitle('DocFlow')
})
