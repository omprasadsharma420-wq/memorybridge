import { app, BrowserWindow, shell, session } from 'electron'
import { join } from 'node:path'
import { AppService } from './app-service'
import { registerIpc, unregisterIpc } from './ipc'

let mainWindow: BrowserWindow | null = null
let service: AppService | null = null
let vaultPoller: NodeJS.Timeout | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1060,
    minHeight: 680,
    show: false,
    backgroundColor: '#0e1110',
    title: 'MemoryBridge',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

void app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  service = new AppService()
  await service.initialize()
  const e2eVault = process.env.MEMORYBRIDGE_E2E_VAULT
  if (e2eVault && !(await service.bootstrap()).vault.connected) {
    await service.createVault(e2eVault)
  }
  registerIpc(service)
  mainWindow = createWindow()
  service.setWindow(mainWindow)
  vaultPoller = setInterval(() => void service?.pollVaultStatus(), 3_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      service?.setWindow(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (vaultPoller) clearInterval(vaultPoller)
  unregisterIpc()
  service?.close()
})
