import { WechatWorld } from './world.js';

export const DEFAULTS = {
  enabled: false,
  host: '0.0.0.0',
  port: 17900,
  token: '',
  rooms: [],
  provider: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    secretName: 'DEEPSEEK_API_KEY',
    temperature: 0.85,
    maxTokens: 300,
    timeoutMs: 30000,
  },
  context: { maxTurns: 12 },
  limits: {
    maxSendsPerReply: 3,
    sendIntervalMs: 1500,
    roomMaxPerWindow: 6,
    roomWindowSec: 60,
  },
};

const definition = {
  id: 'wechat',
  label: '微信',
  defaults: () => JSON.parse(JSON.stringify(DEFAULTS)),
  create: (ctx) => new WechatWorld(ctx),
  describe: {
    tools: [],
    events: [],
  },
};

export default definition;
