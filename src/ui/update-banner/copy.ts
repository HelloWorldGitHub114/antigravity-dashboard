import type { UpdateLifecycleState, UpdateProgressPhase } from '../../contracts/ipc.ts';

export interface UpdateCopy {
  pluginMenu: string;
  checkUpdates: string;
  title: string;
  close: string;
  currentVersion: string;
  latestVersion: string;
  installation: string;
  whatsNew: string;
  retained: string;
  reloadPlugin: string;
  retry: string;
  update: string;
  working: string;
  checkComplete: string;
  readyToUpdate: string;
  reloadingPlugin: string;
  notCompleted: string;
  statuses: Record<UpdateLifecycleState, string>;
  errors: Record<string, string>;
  phases: Record<UpdateProgressPhase, string>;
}

const EN_COPY: UpdateCopy = {
  pluginMenu: 'Plugin menu',
  checkUpdates: 'Check for updates',
  title: 'Plugin update',
  close: 'Close',
  currentVersion: 'Installed',
  latestVersion: 'Latest',
  installation: 'Installation',
  whatsNew: 'What’s new',
  retained: 'Settings and statistics are retained',
  reloadPlugin: 'Reload plugin',
  retry: 'Retry',
  update: 'Update',
  working: 'Working',
  checkComplete: 'Check complete',
  readyToUpdate: 'Ready to update',
  reloadingPlugin: 'Reloading plugin',
  notCompleted: 'Not completed. Retry available.',
  statuses: {
    checking: 'Checking…',
    current: 'You’re up to date',
    available: 'Update available',
    installing: 'Verifying and installing…',
    installed: 'Update installed',
    reloading: 'Reloading…',
    error: 'Update incomplete',
    idle: 'Check for updates',
  },
  errors: {
    network: 'Connection failed. Please retry.',
    python: 'Python was not found.',
    verification: 'Package verification failed.',
    busy: 'Another update is in progress.',
    install: 'Installation incomplete; previous files retained.',
    rollback: 'Recovery failed; a local backup is available.',
  },
  phases: {
    check: 'Connecting to releases',
    download: 'Downloading update',
    verify: 'Verifying package',
    extract: 'Preparing files',
    backup: 'Backing up installed version',
    install: 'Installing files',
    recover: 'Restoring previous version',
    complete: 'Update complete',
  },
};

const ZH_COPY: UpdateCopy = {
  pluginMenu: '插件菜单',
  checkUpdates: '检查更新',
  title: '插件更新',
  close: '关闭',
  currentVersion: '当前版本',
  latestVersion: '最新版本',
  installation: '安装类型',
  whatsNew: '更新内容',
  retained: '设置和统计记录将保留',
  reloadPlugin: '重新加载插件',
  retry: '重试',
  update: '更新',
  working: '正在处理',
  checkComplete: '检查完成',
  readyToUpdate: '准备就绪',
  reloadingPlugin: '正在重新加载插件',
  notCompleted: '操作未完成，可重试',
  statuses: {
    checking: '正在检查…',
    current: '已是最新版本',
    available: '发现新版本',
    installing: '正在校验并安装…',
    installed: '更新已完成',
    reloading: '正在重新加载…',
    error: '更新未完成',
    idle: '检查更新',
  },
  errors: {
    network: '连接失败，请稍后重试',
    python: '未找到 Python',
    verification: '未通过安装包校验',
    busy: '已有更新正在进行',
    install: '安装未完成，原版已保留',
    rollback: '恢复失败，可从备份恢复',
  },
  phases: {
    check: '正在连接发布源',
    download: '正在下载更新',
    verify: '正在校验安装包',
    extract: '正在准备文件',
    backup: '正在备份当前版本',
    install: '正在安装文件',
    recover: '正在恢复原版本',
    complete: '更新完成',
  },
};

export function getUpdateCopy(language: string): UpdateCopy {
  return language === 'zh-CN' ? ZH_COPY : EN_COPY;
}

export function formatReleaseNotes(notes?: string): string {
  return (notes ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(0, 3)
    .join('\n');
}
