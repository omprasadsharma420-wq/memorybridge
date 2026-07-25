import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('onboard, inspect storage, import demo, search evidence, and reopen the vault', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'memorybridge-e2e-vault-'))
  const disconnectedVault = `${vault}-offline`
  const userData = await mkdtemp(join(tmpdir(), 'memorybridge-e2e-user-'))
  let application = await launch(vault, userData)
  try {
    let page = await application.firstWindow()
    await expect(page.getByText('Your vault is ready.')).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByTestId('demo-mode').click()
    await page.getByTestId('load-demo').click()
    await expect(page.getByText('Your first import is ready.')).toBeVisible()
    await expect(page.getByText('Validation: passed')).toBeVisible()
    await page.getByTestId('finish-setup').click()

    await expect(page.getByText('Where should we pick up?')).toBeVisible()
    await page.getByRole('button', { name: 'Vault storage' }).click()
    await expect(page.getByRole('heading', { name: 'Vault storage' })).toBeVisible()
    await expect(page.getByText('Raw transcripts')).toBeVisible()

    await page.getByRole('button', { name: /Storage decision/ }).click()
    await expect(page.getByText(/internal storage by default/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    const sourceButton = page.getByRole('button', { name: /Open exact source/ }).first()
    await expect(sourceButton).toBeVisible()
    await sourceButton.click()
    await expect(page.locator('.message.source-highlight')).toBeVisible()

    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByPlaceholder('Search messages and memories').fill('internal storage')
    await page.getByPlaceholder('Search messages and memories').press('Enter')
    await expect(page.locator('.search-results > button').first()).toBeVisible()

    await application.close()
    application = await launch(vault, userData)
    page = await application.firstWindow()
    await expect(page.getByText('Storage decision')).toBeVisible()
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByPlaceholder('Search messages and memories').fill('परीक्षण')
    await page.getByPlaceholder('Search messages and memories').press('Enter')
    await expect(page.locator('.search-results > button').first()).toBeVisible()

    await application.close()
    await rename(vault, disconnectedVault)
    application = await launch(vault, userData, false)
    page = await application.firstWindow()
    await expect(page.getByText('Vault disconnected')).toBeVisible()
    await expect(page.getByText(/nothing is saved elsewhere/i)).toBeVisible()
    await rename(disconnectedVault, vault)
    await expect(page.getByText('Vault disconnected')).not.toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Storage decision')).toBeVisible()
  } finally {
    await application.close()
    await rm(vault, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    await rm(disconnectedVault, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    })
    await rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

async function launch(vault: string, userData: string, createVault = true) {
  const packagedExecutable = process.env.MEMORYBRIDGE_PACKAGED_EXE
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  if (createVault) env.MEMORYBRIDGE_E2E_VAULT = vault
  else delete env.MEMORYBRIDGE_E2E_VAULT
  return electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: [...(packagedExecutable ? [] : ['.']), `--user-data-dir=${userData}`],
    env
  })
}
