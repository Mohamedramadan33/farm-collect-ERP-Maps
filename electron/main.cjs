const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_TITLE = 'خريطة مزارع سيكم - Sekem Farms Mapper';
const isDev = process.env.ELECTRON_DEV === 'true' || !app.isPackaged;
const viteDevUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

let mainWindow = null;
let backendProcess = null;
let backendExitCode = null;
let isQuitting = false;

app.setAppUserModelId('com.sekem.farmsmapper');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function checkPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(preferredPort = 3001) {
  if (await checkPortAvailable(preferredPort)) {
    return preferredPort;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 3001;
      server.close(() => resolve(port));
    });
  });
}

function httpGetOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServerReady(url, timeoutMs = 25000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (backendProcess && backendExitCode !== null) {
      throw new Error(`Backend process exited prematurely with code ${backendExitCode}.`);
    }
    if (await httpGetOk(url)) {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for service at ${url}`);
}

function getBackendLaunchSpec(port) {
  const userDataDir = app.getPath('userData');
  const resourcesPath = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
  const staticDistDir = path.join(app.getAppPath(), 'dist');

  const baseEnv = {
    ...process.env,
    PORT: String(port),
    BIND_HOST: '127.0.0.1',
    USER_DATA_DIR: userDataDir,
    RESOURCES_PATH: resourcesPath,
    STATIC_DIST_DIR: staticDistDir,
  };

  if (app.isPackaged) {
    const serverEntry = path.join(app.getAppPath(), 'dist-server', 'server.cjs');
    return {
      command: process.execPath,
      args: [serverEntry],
      cwd: userDataDir,
      env: {
        ...baseEnv,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
      },
    };
  }

  const compiledEntry = path.resolve(__dirname, '..', 'dist-server', 'server.cjs');
  if (!isDev && fs.existsSync(compiledEntry)) {
    return {
      command: process.execPath,
      args: [compiledEntry],
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...baseEnv,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
      },
    };
  }

  const tsxBin = path.resolve(
    __dirname,
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  const tsEntry = path.resolve(__dirname, '..', 'server.ts');

  return {
    command: tsxBin,
    args: [tsEntry],
    cwd: path.resolve(__dirname, '..'),
    shell: process.platform === 'win32',
    env: {
      ...baseEnv,
      ELECTRON_API_ONLY: 'true',
      NODE_ENV: 'development',
    },
  };
}

async function ensureBackendRunning() {
  const preferredPort = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

  // In concurrently electron:dev mode, backend may already be running on preferredPort
  if (isDev && (await httpGetOk(`http://127.0.0.1:${preferredPort}/api/health`))) {
    return preferredPort;
  }

  const port = await findFreePort(preferredPort);
  const spec = getBackendLaunchSpec(port);

  backendExitCode = null;
  backendProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: Boolean(spec.shell),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  backendProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk}`);
  });
  backendProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });
  backendProcess.on('exit', (code) => {
    backendExitCode = code ?? 0;
    backendProcess = null;
  });

  await waitForServerReady(`http://127.0.0.1:${port}/api/health`);
  return port;
}

function stopBackendProcess() {
  if (!backendProcess || !backendProcess.pid) return;
  const pid = backendProcess.pid;
  backendProcess = null;

  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Process already exited
  }
}

function isExternalNavigation(targetUrl, appOrigin) {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') {
      return true;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return parsed.origin !== appOrigin;
  } catch {
    return false;
  }
}

async function createMainWindow(appUrl) {
  const appOrigin = new URL(appUrl).origin;

  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f8fafc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalNavigation(url, appOrigin)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isExternalNavigation(url, appOrigin)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(appUrl);
}

app.whenReady().then(async () => {
  try {
    const backendPort = await ensureBackendRunning();

    let targetUrl;
    if (isDev && process.env.ELECTRON_DEV === 'true') {
      await waitForServerReady(viteDevUrl);
      targetUrl = viteDevUrl;
    } else {
      targetUrl = `http://127.0.0.1:${backendPort}`;
    }

    await createMainWindow(targetUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Startup Error - Sekem Farms Mapper', `Failed to start application:\n\n${message}`);
    stopBackendProcess();
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
    // Re-open is handled by single-instance / normal lifecycle
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackendProcess();
});

app.on('will-quit', () => {
  stopBackendProcess();
});

app.on('window-all-closed', () => {
  stopBackendProcess();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('SIGINT', () => {
  stopBackendProcess();
  app.quit();
});

process.on('SIGTERM', () => {
  stopBackendProcess();
  app.quit();
});
