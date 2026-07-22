const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron')

let mainWindow
let isAlwaysOnTop = true

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

  ipcMain.on('show-context-menu', (e) => {
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

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
