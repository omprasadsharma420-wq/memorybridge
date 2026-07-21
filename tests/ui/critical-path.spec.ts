import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('create project, chat, streamed decision memory, search, and reopen source', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'memorybridge-e2e-vault-'))
  const userData = await mkdtemp(join(tmpdir(), 'memorybridge-e2e-user-'))
  const application = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, MEMORYBRIDGE_E2E_VAULT: vault }
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByText('Where should we pick up?')).toBeVisible()
    await page.getByText('Workspaces').locator('..').getByRole('button', { name: '＋' }).click()
    await page.getByTestId('project-name').fill('E2E Project')
    await page.getByTestId('create-project').click()
    await page.getByTestId('new-chat').click()
    await page.getByTestId('composer').fill('We have decided to use Electron for the E2E product.')
    await page.getByTestId('send').click()
    await expect(page.getByText(/Mock response saved locally/)).toBeVisible()
    await expect(page.getByText('We have decided to use Electron for the E2E product.').last()).toBeVisible()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByPlaceholder('Search messages and memories').fill('Electron')
    await page.getByPlaceholder('Search messages and memories').press('Enter')
    await expect(page.getByText('decision').first()).toBeVisible()
    await page.getByText('decision').first().locator('..').click()
    await expect(page.getByLabel('Chat title')).toBeVisible()
  } finally {
    await application.close()
    await rm(vault, { recursive: true, force: true })
    await rm(userData, { recursive: true, force: true })
  }
})
