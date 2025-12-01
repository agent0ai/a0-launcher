const path = require('node:path');

module.exports = {
  packagerConfig: {
    name: 'A0 Launcher',
    executableName: 'a0-launcher',
    appBundleId: 'ai.agent0.launcher',
    asar: true,
    icon: path.join(__dirname, 'shell', 'assets', 'icon'),
    appCategoryType: 'public.app-category.developer-tools',
    osxSign: {},
    osxNotarize: process.env.APPLE_ID ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    } : undefined
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'A0Launcher',
        authors: 'Agent Zero Team',
        description: 'Agent Zero Launcher',
        iconUrl: 'https://raw.githubusercontent.com/agent0ai/a0-launcher/main/shell/assets/icon.ico',
        setupIcon: path.join(__dirname, 'shell', 'assets', 'icon.ico')
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin']
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        name: 'A0 Launcher',
        icon: path.join(__dirname, 'shell', 'assets', 'icon.icns'),
        format: 'ULFO'
      }
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'a0-launcher',
          productName: 'A0 Launcher',
          maintainer: 'Agent Zero Team',
          homepage: 'https://github.com/agent0ai/a0-launcher',
          icon: path.join(__dirname, 'shell', 'assets', 'icon.png'),
          categories: ['Development', 'Utility']
        }
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'a0-launcher',
          productName: 'A0 Launcher',
          homepage: 'https://github.com/agent0ai/a0-launcher',
          icon: path.join(__dirname, 'shell', 'assets', 'icon.png'),
          categories: ['Development', 'Utility']
        }
      }
    }
  ]
};
