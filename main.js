const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

let mainWindow
let isAlwaysOnTop = true
let foraging = false

// 「吞进肚子」的暂存目录:应用 userData/stomach/
const STOMACH_DIR = path.join(app.getPath('userData'), 'stomach')

// 桌面目录(用户 + 公共),用于校验/吐出
function getDesktopDirs() {
  const dirs = []
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, 'Desktop'))
  if (process.env.PUBLIC) dirs.push(path.join(process.env.PUBLIC, 'Desktop'))
  return dirs.filter(d => fs.existsSync(d))
}

// 同名冲突时加 _2、_3 后缀
function uniqueTarget(dir, filename) {
  let target = path.join(dir, filename)
  if (!fs.existsSync(target)) return target
  const ext = path.extname(filename)
  const base = path.basename(filename, ext)
  let i = 2
  while (fs.existsSync(path.join(dir, `${base}_${i}${ext}`))) i++
  return path.join(dir, `${base}_${i}${ext}`)
}

// 找 scripts/get-desktop-icons.ps1:开发态在 __dirname,打包后(asarUnpack)在 resourcesPath
function resolvePsScript() {
  const candidates = [
    path.join(__dirname, 'scripts', 'get-desktop-icons.ps1'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'get-desktop-icons.ps1'),
    path.join(process.resourcesPath, 'scripts', 'get-desktop-icons.ps1')
  ]
  return candidates.find(p => fs.existsSync(p)) || null
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea

  // 整个屏幕工作区铺满透明窗口,蟑螂在窗口内用 CSS transform 移动,
  // 窗口本身永不 setPosition,彻底避开 DWM 透明窗口缩放 bug
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    transparent: true,
    thickFrame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })

  // 默认点击穿透,鼠标进入蟑螂区域时由渲染进程动态关掉
  mainWindow.setIgnoreMouseEvents(true, { forward: true })

  mainWindow.loadFile('index.html')

  // 把窗口(=工作区)尺寸发给渲染进程,作为蟑螂移动的边界
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('screen-bounds', {
      width: workArea.width,
      height: workArea.height
    })
  })

  // 切换点击穿透:ignore=true 鼠标穿透到桌面,ignore=false 接收鼠标事件
  ipcMain.on('set-passthrough', (e, ignore) => {
    mainWindow.setIgnoreMouseEvents(!!ignore, { forward: true })
  })

  ipcMain.on('toggle-topmost', () => {
    isAlwaysOnTop = !isAlwaysOnTop
    mainWindow.setAlwaysOnTop(isAlwaysOnTop)
  })

  // ===== 拿桌面图标坐标 =====
  ipcMain.handle('get-desktop-icons', async () => {
    const psPath = resolvePsScript()
    if (!psPath) return { ok: false, reason: 'ps-not-found', items: [] }

    return new Promise(resolve => {
      const ps = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-NoProfile',
        '-File', psPath
      ])
      let stdout = ''
      let stderr = ''
      ps.stdout.on('data', d => { stdout += d.toString('utf8') })
      ps.stderr.on('data', d => { stderr += d.toString('utf8') })
      ps.on('close', code => {
        if (code !== 0) {
          resolve({ ok: false, reason: 'ps-exit-' + code, stderr, items: [] })
          return
        }
        let raw
        try { raw = JSON.parse(stdout) }
        catch (e) { resolve({ ok: false, reason: 'bad-json', raw: stdout, items: [] }); return }

        const disp = screen.getPrimaryDisplay()
        const sf = disp.scaleFactor || 1
        const wa = disp.workArea
        const items = []
        for (const it of raw) {
          if (!it || typeof it.x !== 'number' || typeof it.y !== 'number') continue
          // 过滤空路径 / 非 .lnk
          if (!it.path || path.extname(it.path).toLowerCase() !== '.lnk') continue
          // 过滤拿不到坐标的(Win11 偶发 0,0)
          if (it.x === 0 && it.y === 0) continue
          // 物理像素 → 相对工作区左上角的逻辑像素
          // PowerShell 返回的坐标已经是相对于 ListView(即工作区)的,只需 DPI 转换
          const lx = it.x / sf
          const ly = it.y / sf
          // 过滤掉主屏工作区外的图标(任务栏区/副屏)
          if (lx < 0 || ly < 0 || lx > wa.width || ly > wa.height) continue
          items.push({ name: it.name, path: it.path, x: lx, y: ly })
        }
        resolve({ ok: true, items })
      })
    })
  })

  // ===== 吞下:把 .lnk 搬进 stomach =====
  ipcMain.handle('eat-icon', async (e, filePath) => {
    try {
      if (!filePath || path.extname(filePath).toLowerCase() !== '.lnk')
        return { ok: false, reason: 'not-lnk' }
      const desktopDirs = getDesktopDirs()
      const inDesktop = desktopDirs.some(d =>
        path.resolve(filePath).toLowerCase().startsWith(path.resolve(d).toLowerCase()))
      if (!inDesktop) return { ok: false, reason: 'not-on-desktop' }
      if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' }

      const target = uniqueTarget(STOMACH_DIR, path.basename(filePath))
      fs.renameSync(filePath, target)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: 'io', message: err.message }
    }
  })

  // ===== 列出肚子里 =====
  ipcMain.handle('list-stomach', async () => {
    try {
      if (!fs.existsSync(STOMACH_DIR)) return []
      return fs.readdirSync(STOMACH_DIR).filter(f => f.toLowerCase().endsWith('.lnk'))
    } catch { return [] }
  })

  // ===== 吐出:把 .lnk 搬回用户桌面 =====
  ipcMain.handle('spit-icon', async (e, filename) => {
    try {
      const src = path.join(STOMACH_DIR, path.basename(filename))
      if (!fs.existsSync(src)) return { ok: false, reason: 'missing' }
      const desktopDirs = getDesktopDirs()
      const targetDir = desktopDirs[0] || path.join(process.env.USERPROFILE, 'Desktop')
      fs.mkdirSync(targetDir, { recursive: true })
      const target = uniqueTarget(targetDir, path.basename(filename))
      fs.renameSync(src, target)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: 'io', message: err.message }
    }
  })

  ipcMain.on('show-context-menu', (e) => {
    const stomachItems = (() => {
      try {
        if (!fs.existsSync(STOMACH_DIR)) return []
        return fs.readdirSync(STOMACH_DIR).filter(f => f.toLowerCase().endsWith('.lnk'))
      } catch { return [] }
    })()

    const spitSubmenu = stomachItems.length > 0
      ? stomachItems.map(f => ({
          label: f,
          click: async () => {
            const r = await new Promise(resolve => {
              // 复用上面的 spit-icon 逻辑
              try {
                const src = path.join(STOMACH_DIR, f)
                const dirs = getDesktopDirs()
                const targetDir = dirs[0] || path.join(process.env.USERPROFILE, 'Desktop')
                const target = uniqueTarget(targetDir, f)
                fs.renameSync(src, target)
                resolve({ ok: true })
              } catch (err) { resolve({ ok: false, reason: 'io', message: err.message }) }
            })
            if (r.ok) e.reply('icon-spit', f)
          }
        }))
      : [{ label: '（肚子里空空的）', enabled: false }]

    const template = [
      {
        label: '调整大小',
        submenu: [
          { label: '小', click: () => e.reply('set-scale', 0.6) },
          { label: '中', click: () => e.reply('set-scale', 1.0) },
          { label: '大', click: () => e.reply('set-scale', 1.5) }
        ]
      },
      { type: 'separator' },
      {
        label: '开始觅食',
        type: 'checkbox',
        checked: foraging,
        click: () => {
          foraging = !foraging
          e.reply('toggle-foraging', foraging)
        }
      },
      {
        label: '吐出来',
        submenu: spitSubmenu
      },
      { type: 'separator' },
      {
        label: isAlwaysOnTop ? '取消置顶' : '置顶',
        click: () => {
          isAlwaysOnTop = !isAlwaysOnTop
          mainWindow.setAlwaysOnTop(isAlwaysOnTop)
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]
    const menu = Menu.buildFromTemplate(template)
    menu.popup({ window: mainWindow })
  })
}

app.whenReady().then(() => {
  fs.mkdirSync(STOMACH_DIR, { recursive: true })
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})