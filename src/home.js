/**
 * 堵车实验室 · 现代化极简浅色首页模块
 * 极简高级设计：去除冗余说明文字与多余小卡片，突出路网视觉与核心行动
 */

import { parseDesign } from './simulation.mjs';

/**
 * 首页内置矢量图标集合
 */
const HOME_ICONS = {
  brand: `<path d="M4 19h16M4 5h16M7 5v14M17 5v14M7 12h10"/>`,
  arrowRight: `<path d="M5 12h14m-6-6 6 6-6 6"/>`,
  arrowLeft: `<path d="m15 19-7-7 7-7"/>`,
  play: `<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>`,
  resume: `<path d="M3 12a9 9 0 0 1 15.5-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.36L3 16M3 21v-5h5"/>`,
  folder: `<path d="M3 7v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1Z"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  road: `<path d="m7 3-4 18M17 3l4 18M12 3v4m0 4v3m0 4v3"/>`,
  grid: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>`,
  check: `<path d="M5 13l4 4L19 7"/>`
};

export const homeIcon = name => `<span class="home-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${HOME_ICONS[name] || HOME_ICONS.road}</svg></span>`;

/**
 * 极简模板列表：仅包含真实模板 ID 与精准标题，无副标题与复杂标签
 */
export const TEMPLATES = [
  { id: 'signal', title: '信号交叉口' },
  { id: 'turn-junction', title: '六车道转向路口' },
  { id: 'fork', title: '分岔路网' },
  { id: 'roundabout', title: '曲线环岛' },
  { id: 'bottleneck', title: '慢行瓶颈' },
  { id: 'accident', title: '冲突与事故' },
  { id: 'queue-base', title: '瓶颈 · 原始限速' },
  { id: 'queue-improved', title: '瓶颈 · 提高限速' },
  { id: 'braess-closed', title: 'Braess · 无捷径' },
  { id: 'braess-open', title: 'Braess · 有捷径' },
  { id: 'signal-balanced', title: '信号 · 等分配时' },
  { id: 'signal-adjusted', title: '信号 · 东西优先' }
];

export const TEMPLATE_GROUPS = [
  {
    category: '经典路网',
    description: '',
    items: TEMPLATES
  }
];

export function checkSavedDesign(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = parseDesign(raw);
    if (parsed && parsed.network) {
      const net = parsed.network;
      const roadsCount = Array.isArray(net.roads) ? net.roads.length : 0;
      const nodesCount = Array.isArray(net.nodes) ? net.nodes.length : 0;
      const facilitiesCount = Array.isArray(net.facilities) ? net.facilities.length : 0;
      if (roadsCount > 0 || nodesCount > 0 || facilitiesCount > 0) {
        return {
          valid: true,
          roadsCount,
          nodesCount,
          facilitiesCount
        };
      }
    }
  } catch {
    // 解析异常直接判定为无有效存档
  }
  return null;
}

export function checkCurrentDraft(stateOrNetwork) {
  if (!stateOrNetwork) return { hasDraft: false, hasContent: false, roadsCount: 0, nodesCount: 0, summary: '' };
  const network = stateOrNetwork.network || stateOrNetwork;
  const roadsCount = (network.roads || []).length;
  const nodesCount = (network.nodes || []).length;
  const facilitiesCount = (network.facilities || []).length;
  const hasHistory = Array.isArray(stateOrNetwork.history) && stateOrNetwork.history.length > 0;
  const hasSession = !!stateOrNetwork.hasSession;

  const hasContent = roadsCount > 0 || nodesCount > 0 || facilitiesCount > 0 || hasHistory;
  const hasDraft = hasSession || hasContent;

  return {
    hasDraft,
    hasContent,
    roadsCount,
    nodesCount,
    facilitiesCount
  };
}

/**
 * 纯粹的 Hero 矢量路网示意图形 (SVG)，移除所有多余技术标签
 */
function createHeroSvg() {
  return `
    <svg class="home-hero-diagram" viewBox="0 0 540 360" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="微观交通网络架构示意图">
      <defs>
        <pattern id="home-grid-pat" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M 30 0 L 0 0 0 30" fill="none" stroke="rgba(15, 23, 42, 0.05)" stroke-width="1"/>
        </pattern>
        <linearGradient id="curve-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#10b981" stop-opacity="0.6"/>
        </linearGradient>
      </defs>

      <!-- 衬底网格 -->
      <rect width="540" height="360" fill="url(#home-grid-pat)" rx="16"/>

      <!-- 主干道横向铺装与车道线 -->
      <path d="M 30 180 L 510 180" stroke="rgba(15, 23, 42, 0.08)" stroke-width="44" stroke-linecap="round"/>
      <path d="M 30 180 L 510 180" stroke="#0f766e" stroke-opacity="0.18" stroke-width="40" stroke-linecap="round"/>
      <path d="M 35 180 L 505 180" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 6" stroke-opacity="0.7"/>
      <path d="M 35 166 L 505 166" stroke="rgba(15, 23, 42, 0.25)" stroke-width="1.2"/>
      <path d="M 35 194 L 505 194" stroke="rgba(15, 23, 42, 0.25)" stroke-width="1.2"/>

      <!-- 主干道纵向铺装与车道线 -->
      <path d="M 270 30 L 270 330" stroke="rgba(15, 23, 42, 0.08)" stroke-width="44" stroke-linecap="round"/>
      <path d="M 270 30 L 270 330" stroke="#0f766e" stroke-opacity="0.18" stroke-width="40" stroke-linecap="round"/>
      <path d="M 270 35 L 270 325" stroke="#0f766e" stroke-width="1.5" stroke-dasharray="6 6" stroke-opacity="0.7"/>
      <path d="M 256 35 L 256 325" stroke="rgba(15, 23, 42, 0.25)" stroke-width="1.2"/>
      <path d="M 284 35 L 284 325" stroke="rgba(15, 23, 42, 0.25)" stroke-width="1.2"/>

      <!-- 匝道互通立交曲线 -->
      <path d="M 110 180 C 110 90, 270 90, 270 30" stroke="url(#curve-grad)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4"/>
      <path d="M 270 330 C 270 270, 430 270, 430 180" stroke="url(#curve-grad)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4"/>

      <!-- 中心交通圆环 -->
      <circle cx="270" cy="180" r="42" fill="#ffffff" stroke="rgba(15, 23, 42, 0.12)" stroke-width="16"/>
      <circle cx="270" cy="180" r="42" stroke="#0f766e" stroke-width="2" stroke-dasharray="5 5" fill="none"/>
      <circle cx="270" cy="180" r="28" fill="#f8fafc" stroke="rgba(15, 23, 42, 0.1)" stroke-width="1"/>

      <!-- 信号控制节点与指示灯 -->
      <g transform="translate(270, 180)">
        <circle cx="0" cy="0" r="8" fill="#ffffff" stroke="#0f766e" stroke-width="2"/>
        <circle cx="0" cy="0" r="3" fill="#0f766e"/>
        <rect x="-34" y="-3" width="8" height="6" rx="2" fill="#10b981"/>
        <rect x="26" y="-3" width="8" height="6" rx="2" fill="#10b981"/>
        <rect x="-3" y="-34" width="6" height="8" rx="2" fill="#ef4444"/>
        <rect x="-3" y="26" width="6" height="8" rx="2" fill="#ef4444"/>
      </g>

      <!-- 流动车辆粒子 -->
      <g class="flow-vehicles">
        <rect x="140" y="169" width="14" height="6" rx="1.5" fill="#0f172a" opacity="0.85"/>
        <rect x="180" y="169" width="15" height="6" rx="1.5" fill="#0f766e"/>
        <rect x="220" y="169" width="13" height="6" rx="1.5" fill="#0f172a" opacity="0.8"/>

        <rect x="330" y="185" width="14" height="6" rx="1.5" fill="#0f766e"/>
        <rect x="380" y="185" width="18" height="7" rx="1.5" fill="#334155"/>
        <rect x="420" y="185" width="14" height="6" rx="1.5" fill="#0f172a" opacity="0.8"/>

        <rect x="260" y="80" width="6" height="14" rx="1.5" fill="#ef4444"/>
        <rect x="260" y="105" width="6" height="15" rx="1.5" fill="#0f172a" opacity="0.8"/>

        <rect x="274" y="240" width="6" height="14" rx="1.5" fill="#10b981"/>
        <rect x="274" y="270" width="6" height="14" rx="1.5" fill="#0f766e"/>
      </g>
    </svg>
  `;
}

/**
 * 构建完整的极简首页 DOM 字符串
 */
export function buildHomeHtml({ draftInfo, savedInfo }) {
  const hasDraft = draftInfo && draftInfo.hasDraft;
  const hasSaved = savedInfo && savedInfo.valid;

  return `
    <div class="home-container" id="home-view">
      <!-- 首页顶栏：极简品牌 -->
      <header class="home-topbar">
        <div class="home-brand">
          <span class="home-brand-logo" aria-hidden="true">
            <img src="./assets/icons/brand.svg" alt="">
          </span>
          <span class="home-brand-title">堵车实验室</span>
        </div>
      </header>

      <!-- 首页主内容区（桌面端首屏无需滚动，纯净居中） -->
      <main class="home-main-view" id="home-main-view">
        <div class="home-content-wrap">
          <div class="home-hero-text">
            <h1 class="home-hero-title">规划道路，观察车流。</h1>

            <div class="home-cta-group">
              <button class="home-cta-btn primary" data-home-action="start-blank" title="开始设计">
                <span class="home-cta-icon">${homeIcon('plus')}</span>
                <span class="home-cta-label">开始设计</span>
                <span class="home-cta-arrow">${homeIcon('arrowRight')}</span>
              </button>

              <button class="home-cta-btn secondary" data-home-action="open-templates" title="选择实验模板">
                <span class="home-cta-icon">${homeIcon('grid')}</span>
                <span class="home-cta-label">选择模板</span>
                <span class="home-cta-arrow">${homeIcon('arrowRight')}</span>
              </button>

              ${hasDraft ? `
                <button class="home-cta-btn secondary highlight" data-home-action="resume-draft" title="继续当前草稿">
                  <span class="home-cta-icon">${homeIcon('resume')}</span>
                  <span class="home-cta-label">继续当前草稿</span>
                  <span class="home-cta-arrow">${homeIcon('arrowRight')}</span>
                </button>
              ` : ''}

              ${hasSaved ? `
                <button class="home-cta-btn secondary" data-home-action="load-saved" title="载入保存在本浏览器中的方案">
                  <span class="home-cta-icon">${homeIcon('folder')}</span>
                  <span class="home-cta-label">载入已存设计</span>
                  <span class="home-cta-arrow">${homeIcon('arrowRight')}</span>
                </button>
              ` : ''}
            </div>
          </div>

          <div class="home-hero-visual" aria-hidden="true">
            <div class="home-visual-card">
              ${createHeroSvg()}
            </div>
          </div>
        </div>
      </main>

      <!-- 单独简洁模板选择层（默认隐藏，点击“选择模板”后展示） -->
      <section class="home-templates-view hidden" id="home-templates-view" aria-label="选择实验模板">
        <div class="home-templates-container">
          <div class="home-templates-topbar">
            <button class="home-back-btn" data-home-action="close-templates">
              ${homeIcon('arrowLeft')}<span>返回首页</span>
            </button>
            <h2 class="home-templates-heading">选择模板</h2>
          </div>
          <div class="home-simple-grid">
            ${TEMPLATES.map(item => `
              <button class="home-simple-card" data-home-template="${item.id}" title="载入 ${item.title}">
                <span class="home-simple-title">${item.title}</span>
                <span class="home-simple-arrow">${homeIcon('arrowRight')}</span>
              </button>
            `).join('')}
          </div>
        </div>
      </section>
    </div>
  `;
}
