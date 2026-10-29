/**
 * 自定义下拉选择组件 (Custom Select)
 * 为全站 <select> 提供 Apple / ChatGPT 质感的毛玻璃悬浮下拉列表
 */

const CHEVRON_SVG = `<svg class="select-chevron" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4"/></svg>`;
const CHECK_SVG = `<svg class="select-check" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>`;

let activeDropdown = null;

// 点击页面其他区域关闭当前打开的下拉菜单
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    if (activeDropdown && !activeDropdown.contains(e.target)) {
      closeDropdown(activeDropdown);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeDropdown) {
      closeDropdown(activeDropdown);
    }
  });
}

function closeDropdown(wrapper) {
  if (!wrapper) return;
  wrapper.classList.remove('is-open');
  const trigger = wrapper.querySelector('.custom-select-trigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (activeDropdown === wrapper) activeDropdown = null;
}

function openDropdown(wrapper) {
  if (activeDropdown && activeDropdown !== wrapper) {
    closeDropdown(activeDropdown);
  }
  wrapper.classList.add('is-open');
  const trigger = wrapper.querySelector('.custom-select-trigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  activeDropdown = wrapper;

  // 智能避让：检查下方空间是否足够，不够则向上弹出
  const menu = wrapper.querySelector('.custom-select-menu');
  if (menu) {
    const rect = wrapper.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 200;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow < menuHeight + 10 && spaceAbove > spaceBelow) {
      wrapper.classList.add('pop-above');
    } else {
      wrapper.classList.remove('pop-above');
    }
  }
}

export function enhanceSelect(select) {
  if (!select || select.tagName !== 'SELECT') return;

  // 如果已经包装过，只需要同步当前选中的文本和状态
  if (select.dataset.enhanced) {
    const wrapper = select.parentElement;
    if (wrapper && wrapper.classList.contains('custom-select-wrapper')) {
      syncSelectState(select, wrapper);
    }
    return;
  }

  select.dataset.enhanced = 'true';

  // 创建外部包装容器
  const wrapper = document.createElement('div');
  wrapper.className = 'custom-select-wrapper';
  if (select.disabled) wrapper.classList.add('is-disabled');

  // 将原生 select 插入包装容器，并保持隐形
  select.parentNode.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.classList.add('native-select-hidden');

  // 触发按钮
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (select.disabled) trigger.disabled = true;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'custom-select-label';
  trigger.appendChild(labelSpan);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'custom-select-arrow';
  iconSpan.innerHTML = CHEVRON_SVG;
  trigger.appendChild(iconSpan);

  wrapper.appendChild(trigger);

  // 下拉菜单浮层
  const menu = document.createElement('div');
  menu.className = 'custom-select-menu';
  menu.setAttribute('role', 'listbox');
  wrapper.appendChild(menu);

  // 构建菜单项
  rebuildOptions(select, wrapper);

  // 触发按钮事件
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (select.disabled) return;
    if (wrapper.classList.contains('is-open')) {
      closeDropdown(wrapper);
    } else {
      openDropdown(wrapper);
    }
  });

  // 键盘操作支持
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!wrapper.classList.contains('is-open')) {
        openDropdown(wrapper);
      }
    }
  });

  // 监听原生 select 的变更事件（以防脚本直接设置 select.value）
  select.addEventListener('change', () => {
    syncSelectState(select, wrapper);
  });

  // 初始状态同步
  syncSelectState(select, wrapper);
}

function rebuildOptions(select, wrapper) {
  const menu = wrapper.querySelector('.custom-select-menu');
  if (!menu) return;
  menu.innerHTML = '';

  Array.from(select.options).forEach((opt, index) => {
    const item = document.createElement('div');
    item.className = 'custom-select-option';
    item.setAttribute('role', 'option');
    item.setAttribute('data-value', opt.value);
    if (opt.selected) item.classList.add('selected');
    if (opt.disabled) item.classList.add('is-disabled');

    const text = document.createElement('span');
    text.className = 'option-text';
    text.textContent = opt.textContent;
    item.appendChild(text);

    const check = document.createElement('span');
    check.className = 'option-check';
    check.innerHTML = CHECK_SVG;
    item.appendChild(check);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opt.disabled) return;
      if (select.value !== opt.value) {
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      syncSelectState(select, wrapper);
      closeDropdown(wrapper);
    });

    menu.appendChild(item);
  });
}

function syncSelectState(select, wrapper) {
  if (select.disabled) {
    wrapper.classList.add('is-disabled');
    const trigger = wrapper.querySelector('.custom-select-trigger');
    if (trigger) trigger.disabled = true;
  } else {
    wrapper.classList.remove('is-disabled');
    const trigger = wrapper.querySelector('.custom-select-trigger');
    if (trigger) trigger.disabled = false;
  }

  const selectedOpt = select.selectedOptions[0] || select.options[0];
  const label = wrapper.querySelector('.custom-select-label');
  if (label && selectedOpt) {
    label.textContent = selectedOpt.textContent;
  }

  // 同步 options 列表高亮
  const items = wrapper.querySelectorAll('.custom-select-option');
  items.forEach(item => {
    const val = item.getAttribute('data-value');
    const isSel = selectedOpt && val === selectedOpt.value;
    item.classList.toggle('selected', isSel);
  });
}

/**
 * 遍历容器并增强所有的原生 select
 */
export function enhanceSelects(container = document) {
  if (!container) return;
  const selects = container.querySelectorAll('select');
  selects.forEach(sel => {
    enhanceSelect(sel);
  });
}
