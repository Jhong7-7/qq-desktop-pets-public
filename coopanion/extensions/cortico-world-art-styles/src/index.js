/**
 * 画风包 World：把「风格名 + 精细度 + 比例」翻成可直接喂给 image_draw 的
 * prompt / size / quality。只读本地 JSON，不联网、不调模型。
 *
 * 设计意图：画风不该靠她每次自由发挥，应该有一个稳定的名字表；
 * 同时把「精细度」变成一个她能自己拧的旋钮（draft / normal / detailed）。
 */
import { readFileSync } from 'node:fs';

const ID = 'art-styles';
const LABEL = '画风包';

const DEFAULTS = {
  enabled: false,
  defaultDetail: 'normal',
};

const CATALOG = JSON.parse(readFileSync(new URL('./styles.json', import.meta.url), 'utf8'));

const DETAIL_ALIAS = {
  draft: 'draft', 草图: 'draft', 草稿: 'draft', 快速: 'draft', low: 'draft',
  normal: 'normal', 标准: 'normal', 普通: 'normal', medium: 'normal',
  detailed: 'detailed', 精细: 'detailed', 细节: 'detailed', 高: 'detailed', high: 'detailed',
};

function norm(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function groupLabel(id) {
  return (CATALOG.groups.find((g) => g.id === id)?.label) ?? id;
}

function styleLine(key, s, withNote) {
  const base = `${key}（${s.label}）`;
  return withNote && s.note ? `${base} — ${s.note}` : base;
}

function findStyle(key) {
  const k = norm(key).toLowerCase();
  if (CATALOG.styles[k]) return k;
  // 允许用中文标签匹配
  const byLabel = Object.entries(CATALOG.styles).find(([, s]) => s.label === norm(key));
  return byLabel ? byLabel[0] : null;
}

function nearStyles(key) {
  const k = norm(key).toLowerCase();
  return Object.keys(CATALOG.styles)
    .filter((name) => name.includes(k) || k.includes(name))
    .slice(0, 5);
}

function listText(groupFilter) {
  const groups = groupFilter
    ? CATALOG.groups.filter((g) => g.id === groupFilter || g.label === groupFilter)
    : CATALOG.groups;
  if (!groups.length) {
    return {
      text: `没有这个分组：${groupFilter}。可用分组：${CATALOG.groups.map((g) => `${g.id}(${g.label})`).join('、')}`,
      failed: true,
    };
  }
  const lines = [];
  for (const g of groups) {
    lines.push(`【${g.label}】`);
    for (const [key, s] of Object.entries(CATALOG.styles)) {
      if (s.group === g.id) lines.push(`  ${styleLine(key, s, true)}`);
    }
  }
  lines.push('');
  lines.push(`精细度：${Object.entries(CATALOG.detail).map(([k, d]) => `${k}(${d.label})`).join(' / ')}`);
  lines.push(`比例：${Object.keys(CATALOG.aspect).join(' / ')}`);
  return { text: lines.join('\n') };
}

const STYLE_LIST_TOOL = {
  name: 'style_list',
  description:
    'List the drawing styles this skill pack knows: grouped keys, Chinese labels and when to use each. '
    + 'Call it before picking a style for the owner, or when the owner asks what styles you can draw.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        description: 'Optional filter: anime (日系) / real (写实) / paint (绘画) / design (设计).',
      },
    },
  },
  handler: async (args) => listText(norm(args?.group) || null),
};

const STYLE_PROMPT_TOOL = {
  name: 'style_prompt',
  description:
    'Turn a named style + subject into a ready-to-use image prompt with size and quality. '
    + 'When the OWNER asks for a picture, first ask them which style / detail / aspect they want (offer 2–3 styles from style_list) and only then call this. '
    + 'When you draw on your own initiative, skip asking: use detail="normal" and choose the style yourself. '
    + 'Then pass the returned prompt, size and quality straight to image_draw.',
  tags: ['read'],
  parameters: {
    type: 'object',
    properties: {
      style: {
        type: 'string',
        description: 'Style key from style_list (e.g. anime, watercolor, cyberpunk). Chinese labels also accepted.',
      },
      subject: {
        type: 'string',
        description: 'What to draw: subject, pose, scene, mood. Any language.',
      },
      detail: {
        type: 'string',
        description: 'draft (草图/快) / normal (标准, default) / detailed (精细). Chinese words like 精细 also work.',
      },
      aspect: {
        type: 'string',
        description: 'square (default) / portrait / landscape / "16:9" / "4:3" / "9:16".',
      },
    },
    required: ['style', 'subject'],
  },
  handler: async (args) => {
    const styleKey = findStyle(args?.style);
    if (!styleKey) {
      const near = nearStyles(args?.style);
      return {
        text: `没有这个风格：${norm(args?.style) || '(空)'}。`
          + (near.length ? `相近的有：${near.join('、')}。` : '')
          + '先用 style_list 看一下全部风格。',
        failed: true,
      };
    }
    const subject = norm(args?.subject);
    if (!subject) return { text: '[style_prompt 没执行] 缺 subject。', failed: true };

    const detailKey = DETAIL_ALIAS[norm(args?.detail).toLowerCase()] ?? DEFAULTS.defaultDetail;
    const detail = CATALOG.detail[detailKey] ?? CATALOG.detail[DEFAULTS.defaultDetail];
    const aspectKey = norm(args?.aspect) || 'square';
    const size = CATALOG.aspect[aspectKey] ?? CATALOG.aspect.square;
    const style = CATALOG.styles[styleKey];

    const prompt = `${style.prompt}, ${subject}, ${detail.extra}`;
    return {
      text: [
        `[画风] ${style.label}（${styleKey}，${groupLabel(style.group)}）`,
        `prompt: ${prompt}`,
        `size: ${size}    quality: ${detail.quality}`,
        `下一步：把 prompt / size / quality 原样传给 image_draw，不要再自己改风格词或加否定句。`,
      ].join('\n'),
    };
  },
};

class ArtStylesWorld {
  constructor(ctx = {}) {
    this.id = ID;
    this.cfg = ctx.cfg ?? { ...DEFAULTS };
    this.host = null;
  }

  start(host) {
    this.host = host;
  }

  async stop() {
    this.host = null;
  }

  tools() {
    return [STYLE_LIST_TOOL, STYLE_PROMPT_TOOL];
  }

  envPromptVars() {
    const d = CATALOG.detail[this.cfg?.defaultDetail] ? this.cfg.defaultDetail : DEFAULTS.defaultDetail;
    return {
      'art-styles.styles': String(Object.keys(CATALOG.styles).length),
      'art-styles.default-detail': d,
    };
  }
}

export const definition = {
  id: ID,
  label: LABEL,
  defaults: () => ({ ...DEFAULTS }),
  create: (ctx) => new ArtStylesWorld(ctx),
  describe: {
    tools: [
      {
        name: 'style_list',
        description: STYLE_LIST_TOOL.description,
        parameters: STYLE_LIST_TOOL.parameters,
        tags: STYLE_LIST_TOOL.tags,
        summary: {
          zh: '列出画风包里的风格（分组、中文名、适用场景）以及精细度和比例选项。',
          en: 'List grouped drawing styles plus the detail and aspect options.',
        },
      },
      {
        name: 'style_prompt',
        description: STYLE_PROMPT_TOOL.description,
        parameters: STYLE_PROMPT_TOOL.parameters,
        tags: STYLE_PROMPT_TOOL.tags,
        summary: {
          zh: '把「风格 + 主体 + 精细度 + 比例」拼成可直接给 image_draw 的 prompt / size / quality。',
          en: 'Compose a ready-to-use prompt, size and quality for image_draw from a style and subject.',
        },
      },
    ],
    events: [],
  },
};

export default definition;
