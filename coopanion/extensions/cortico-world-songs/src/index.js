/**
 * 曲库 World：只做一件事——把本地音频文件读成 [blob] 句柄，
 * 交给 QQ World 的 qq_draft(voice=...) 发送。不做推理、不联网。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';

const ID = 'songs';
const LABEL = '曲库';

const DEFAULTS = {
  enabled: false,
  dir: '',
  maxMB: 20,
};

const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

class SongsWorld {
  constructor(ctx = {}) {
    this.id = ID;
    this.cfg = ctx.cfg ?? { ...DEFAULTS };
    this.botDir = ctx.botDir ?? process.cwd();
    this.dataDir = ctx.dataDir ?? process.cwd();
  }

  #raw(key) {
    const value = this.cfg?.[key];
    return value === undefined || value === null ? DEFAULTS[key] : value;
  }

  #dir() {
    const configured = asText(this.#raw('dir'));
    if (!configured) return join(this.botDir, 'workspace', 'songs');
    return isAbsolute(configured) ? configured : join(this.botDir, configured);
  }

  #files() {
    const dir = this.#dir();
    try {
      return readdirSync(dir)
        .filter((name) => MIME[extname(name).toLowerCase()])
        .filter((name) => {
          try { return statSync(join(dir, name)).isFile(); } catch { return false; }
        })
        .sort();
    } catch {
      return [];
    }
  }

  start(host) {
    this.host = host;
  }

  async stop() {
    this.host = null;
  }

  envPromptVars() {
    return null;
  }

  tools() {
    return [{
      name: 'song_list',
      description: 'List the songs (audio files) currently in the local song library.',
      parameters: { type: 'object', properties: {} },
      tags: ['read'],
      handler: async () => {
        const files = this.#files();
        if (files.length === 0) {
          return { text: `曲库是空的（目录：${this.#dir()}）。` };
        }
        return { text: `曲库里现在有：\n${files.map((f) => `- ${f}`).join('\n')}` };
      },
    }, {
      name: 'song_send',
      description: 'Take one song from the local library and return it as a [blob] attachment handle. After that, call qq_draft with that handle in its voice field to send a QQ voice bar.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'File name or a distinctive part of it, e.g. "see-you-again" or "大鱼".',
          },
        },
        required: ['name'],
      },
      tags: ['act'],
      handler: async (args) => {
        const query = asText(args?.name);
        if (!query) return { text: '[song_send 没执行] 没给歌名。', failed: true };

        const files = this.#files();
        const exact = files.find((f) => f === query);
        const partial = files.find((f) => f.toLowerCase().includes(query.toLowerCase()))
          ?? files.find((f) => basename(f, extname(f)).toLowerCase().includes(query.toLowerCase()));
        const hit = exact ?? partial;
        if (!hit) {
          return {
            text: `[song_send 没执行] 曲库里没有「${query}」。现有：${files.join('、') || '（空）'}`,
            failed: true,
          };
        }

        const file = join(this.#dir(), hit);
        let bytes;
        try {
          bytes = readFileSync(file);
        } catch (err) {
          return { text: `[song_send 没执行] 读不了 ${hit}：${err?.message ?? err}`, failed: true };
        }

        const maxMB = Number(this.#raw('maxMB')) || 20;
        if (bytes.length > maxMB * 1024 * 1024) {
          return { text: `[song_send 没执行] ${hit} 有 ${(bytes.length / 1048576).toFixed(1)} MB，超过上限 ${maxMB} MB。`, failed: true };
        }

        const mime = MIME[extname(hit).toLowerCase()] ?? 'audio/wav';
        return {
          text: `取出了《${basename(hit, extname(hit))}》（${(bytes.length / 1048576).toFixed(1)} MB）。把回执里的 [blob ...] 句柄填进 qq_draft 的 voice 参数发送；语音条是单独一条消息，不要带文字或图片。`,
          blobs: [{ bytes, mime, name: hit }],
        };
      },
    }];
  }
}

export const definition = {
  id: ID,
  label: LABEL,
  defaults: () => ({ ...DEFAULTS }),
  create: (ctx) => new SongsWorld(ctx),
  describe: {
    tools: [{
      name: 'song_list',
      description: 'List the songs (audio files) currently in the local song library.',
      parameters: { type: 'object', properties: {} },
      tags: ['read'],
      summary: {
        zh: '列出曲库里现有的翻唱音频文件。',
        en: 'List the audio files in the local song library.',
      },
    }, {
      name: 'song_send',
      description: 'Take one song from the local library and return it as a [blob] attachment handle. After that, call qq_draft with that handle in its voice field to send a QQ voice bar.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'File name or a distinctive part of it, e.g. "see-you-again" or "大鱼".',
          },
        },
        required: ['name'],
      },
      tags: ['act'],
      summary: {
        zh: '从曲库取出一首歌的音频，回执带句柄；再用 qq_draft 的 voice 发送。',
        en: 'Return one library song as an audio blob handle, ready for qq_draft voice.',
      },
    }],
    events: [],
  },
};

export default definition;
