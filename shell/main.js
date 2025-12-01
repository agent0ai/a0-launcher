const { app, BrowserWindow, net, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

// Handle Squirrel.Windows startup events
if (require('electron-squirrel-startup')) {
  app.quit();
}

// Constants
const GITHUB_REPO = 'agent0ai/a0-launcher';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CONTENT_ASSET_NAME = 'content.json';

// Paths
const CONTENT_DIR = path.join(app.getPath('userData'), 'app_content');
const META_FILE = path.join(app.getPath('userData'), 'content_meta.json');

let mainWindow;

/**
 * Fetch the latest release info from GitHub
 */
async function fetchLatestRelease() {
  try {
    const response = await net.fetch(GITHUB_API_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'A0-Launcher'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch latest release:', error);
    return null;
  }
}

/**
 * Read local content metadata
 */
async function readLocalMeta() {
  try {
    const data = await fs.readFile(META_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('No local meta file found, will download content');
    } else {
      console.error('Error reading meta file:', error);
    }
    return null;
  }
}

/**
 * Write local content metadata
 */
async function writeLocalMeta(data) {
  await fs.writeFile(META_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Download and extract content from the release asset
 */
async function downloadContent(downloadUrl) {
  sendStatus('Downloading latest content...');

  const response = await net.fetch(downloadUrl, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'A0-Launcher'
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const contentJson = await response.json();

  // Clear existing content directory
  await fs.rm(CONTENT_DIR, { recursive: true, force: true });
  await fs.mkdir(CONTENT_DIR, { recursive: true });

  // Write each file from the JSON bundle
  sendStatus('Extracting content...');

  for (const [filePath, content] of Object.entries(contentJson.files)) {
    const fullPath = path.join(CONTENT_DIR, filePath);
    const dir = path.dirname(fullPath);

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');
  }

  console.log(`Extracted ${Object.keys(contentJson.files).length} files`);
}

/**
 * Send status update to renderer
 */
function sendStatus(message) {
  console.log('Status:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', message);
  }
}

/**
 * Send error to renderer
 */
function sendError(message) {
  console.error('Error:', message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-error', message);
  }
}

/**
 * Initialize app content - check for updates and download if needed
 */
async function initializeAppContent() {
  sendStatus('Checking for updates...');

  const latestRelease = await fetchLatestRelease();

  if (!latestRelease) {
    // Offline or API error - try to use existing content
    const hasContent = await checkExistingContent();
    if (!hasContent) {
      sendError('Unable to fetch updates and no local content available. Please check your internet connection.');
      return false;
    }
    sendStatus('Using cached content (offline mode)');
    return true;
  }

  const localMeta = await readLocalMeta();
  const remoteTimestamp = new Date(latestRelease.published_at).getTime();
  const localTimestamp = localMeta ? new Date(localMeta.published_at).getTime() : 0;

  if (remoteTimestamp > localTimestamp) {
    console.log(`Update available: ${latestRelease.tag_name} (${latestRelease.published_at})`);

    // Find the content.json asset
    const contentAsset = latestRelease.assets.find(
      asset => asset.name === CONTENT_ASSET_NAME
    );

    if (!contentAsset) {
      console.error(`No ${CONTENT_ASSET_NAME} asset found in release`);
      const hasContent = await checkExistingContent();
      if (!hasContent) {
        sendError('Release does not contain required content bundle.');
        return false;
      }
      return true;
    }

    try {
      await downloadContent(contentAsset.browser_download_url);

      // Save metadata
      await writeLocalMeta({
        version: latestRelease.tag_name,
        published_at: latestRelease.published_at,
        downloaded_at: new Date().toISOString()
      });

      sendStatus('Update complete!');
    } catch (error) {
      console.error('Download failed:', error);
      const hasContent = await checkExistingContent();
      if (!hasContent) {
        sendError(`Download failed: ${error.message}`);
        return false;
      }
      sendStatus('Using cached content (download failed)');
    }
  } else {
    console.log('Content is up to date');
    sendStatus('Content is up to date');
  }

  return true;
}

/**
 * Check if existing content is available
 */
async function checkExistingContent() {
  try {
    const indexPath = path.join(CONTENT_DIR, 'index.html');
    await fs.access(indexPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the app content into the window
 */
async function loadAppContent() {
  const indexPath = path.join(CONTENT_DIR, 'index.html');

  try {
    await fs.access(indexPath);
    mainWindow.loadFile(indexPath);
  } catch {
    // Fallback: show error in loading page
    sendError('No content available. Please ensure a release exists with content.json.');
  }
}

/**
 * Create the main browser window
 */
function createWindow() {
  const iconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  );

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'A0 Launcher',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load loading screen first
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
}

// IPC Handlers
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-content-version', async () => {
  try {
    const meta = await readLocalMeta();
    return meta?.version || 'unknown';
  } catch {
    return 'unknown';
  }
});

// App lifecycle
app.whenReady().then(async () => {
  createWindow();

  // Wait a moment for loading screen to render
  await new Promise(resolve => setTimeout(resolve, 500));

  // Initialize content
  const success = await initializeAppContent();

  if (success) {
    // Small delay for visual feedback
    await new Promise(resolve => setTimeout(resolve, 800));
    await loadAppContent();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
