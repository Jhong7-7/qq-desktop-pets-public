/** WorkBuddy 任务 World 的配置段：worlds.wbtask */

export interface WBTaskConfig {
  /** 总开关；默认关闭，装好后在模块页或 config.json 里手动打开 */
  enabled: boolean;
  /** 跑 CLI 的 node 可执行文件 */
  nodePath: string;
  /** WorkBuddy 自带的 codebuddy CLI 入口（bin/codebuddy） */
  cliEntry: string;
  /** 任务的工作目录：CLI 在这里读写文件 */
  cwd: string;
  /** 模型档位；空串=用 CLI 默认 */
  model: string;
  /** 单次同步等待上限（秒），超时转后台继续跑 */
  timeoutSec: number;
  /** 回执最多带回多少字符，防止一大段日志糊满对话 */
  maxOutputChars: number;
  /** 权限模式：acceptEdits / bypassPermissions / default */
  permissionMode: string;
  /** 是否加 -y（非交互模式下写文件、跑命令必须），风险自负 */
  skipPermissions: boolean;
  /** 谁能提交任务（QQ 号或任意标识）；空数组=不限制来源 */
  allowedUsers: string[];
  /** 最多同时跑几个任务 */
  maxConcurrent: number;
  /** 追加给 CLI 的额外参数 */
  extraArgs: string[];
  /**
   * 额外注入给 CLI 的环境变量。
   * 用 API Key 认证时必须同时给：CODEBUDDY_API_KEY + CODEBUDDY_INTERNET_ENVIRONMENT=internal
   */
  env: Record<string, string>;
  /**
   * 执行通道：
   * - gateway：走桌面版 WorkBuddy 自带的本地 agent 服务，免登录、免 API Key（推荐）
   * - cli：起独立 codebuddy 进程，需要 API Key 或可用的登录态
   */
  executor: 'gateway' | 'cli';
  /** gateway 端口；0=自动发现（桌面版每次启动端口会变） */
  gatewayPort: number;
  /** gateway 口令；留空则运行时从桌面版进程环境读取 */
  gatewayPassword: string;
  /** 读进程环境用的 python 解释器（gateway 口令兜底） */
  pythonPath: string;
  /** read_env.py 的路径 */
  envScript: string;
}

export const WBTASK_DEFAULTS: WBTaskConfig = {
  enabled: false,
  nodePath: 'C:/Users/86189/.workbuddy/binaries/node/versions/22.22.2-6/node.exe',
  cliEntry: 'D:/wb/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy',
  cwd: 'D:/wb/泡泡',
  model: '',
  timeoutSec: 120,
  maxOutputChars: 1200,
  permissionMode: 'acceptEdits',
  skipPermissions: false,
  allowedUsers: [],
  maxConcurrent: 1,
  extraArgs: [],
  env: {},
  executor: 'gateway',
  gatewayPort: 0,
  gatewayPassword: '',
  pythonPath: 'C:/Users/86189/.workbuddy/binaries/python/versions/3.13.12/python.exe',
  envScript: 'D:/wb/泡泡/tools/wb-gateway/read_env.py',
};

/** 状态文件与日志目录都以 world id 开头，避免和其他 World 撞名 */
export const WBTASK_STATE_FILE = 'wbtask-jobs.json';
export const WBTASK_LOG_DIR = 'wbtask-logs';
