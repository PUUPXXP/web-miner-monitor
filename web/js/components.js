// 通用 UI 组件：弹窗、确认框、表单弹窗
import { h, clear } from './dom.js';
import { toast } from './realtime.js';

let openCount = 0;

export function closeModal() {
  const root = document.getElementById('modal-root');
  clear(root);
  openCount = Math.max(0, openCount - 1);
  document.body.style.overflow = openCount > 0 ? 'hidden' : '';
}

/**
 * 打开弹窗
 * @param {{title:string, body:Node|string, footer?:Node|null, wide?:boolean, onClose?:Function}} opts
 */
export function openModal({ title, body, footer = null, wide = false, onClose = null }) {
  const root = document.getElementById('modal-root');
  clear(root);
  const backdrop = h('div', { class: 'modal-backdrop' });
  const modal = h('div', { class: `modal ${wide ? 'wide' : ''}` });
  const close = () => {
    backdrop.remove();
    onClose?.();
    openCount = Math.max(0, openCount - 1);
    document.body.style.overflow = openCount > 0 ? 'hidden' : '';
  };
  const head = h('div', { class: 'modal-head' },
    h('h3', {}, title),
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: '关闭', onclick: close }, '✕'),
  );
  const bodyEl = h('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body) bodyEl.appendChild(body);
  modal.append(head, bodyEl);
  if (footer) modal.appendChild(h('div', { class: 'modal-foot' }, footer));
  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  root.appendChild(backdrop);
  openCount += 1;
  document.body.style.overflow = 'hidden';
  return { close, modal, body: bodyEl };
}

export function confirmDialog({ title = '确认操作', message, okText = '确认', danger = true, detail = null }) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title,
      body: h('div', {},
        h('p', { style: { margin: '0 0 8px' } }, message),
        detail ? h('div', { class: 'logview', html: detail }) : null,
      ),
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => { close(); resolve(false); } }, '取消'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { close(); resolve(true); } }, okText),
      ),
      onClose: () => resolve(false),
    });
  });
}

/** 表单弹窗：fields = [{name,label,type,value,options,placeholder,hint,required,rows}] */
export function formDialog({ title, fields, okText = '保存', wide = false, onSubmit }) {
  return new Promise((resolve) => {
    const inputs = {};
    const form = h('form', { autocomplete: 'off' });
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = h('select', { class: 'select' },
          ...(f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)),
        );
      } else if (f.type === 'textarea') {
        input = h('textarea', { class: 'textarea', rows: f.rows || 4, placeholder: f.placeholder || '' });
        input.value = f.value ?? '';
      } else if (f.type === 'checkbox') {
        input = h('input', { type: 'checkbox', checked: !!f.value, style: { width: '18px', height: '18px', accentColor: 'var(--accent)' } });
      } else if (f.type === 'number') {
        input = h('input', { class: 'input', type: 'number', step: f.step || 'any', placeholder: f.placeholder || '', value: f.value ?? '' });
      } else {
        input = h('input', { class: 'input', type: f.type || 'text', placeholder: f.placeholder || '', value: f.value ?? '' });
      }
      inputs[f.name] = input;
      form.appendChild(h('div', { class: 'field' },
        h('label', {}, f.label, f.required ? h('span', { style: { color: 'var(--danger)' } }, ' *') : null),
        input,
        f.hint ? h('div', { class: 'hint' }, f.hint) : null,
      ));
    }
    const submit = async (e) => {
      e?.preventDefault();
      const values = {};
      for (const [k, el] of Object.entries(inputs)) {
        values[k] = el.type === 'checkbox' ? el.checked : el.value;
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await onSubmit?.(values);
        close();
        resolve(values);
      } catch (err) {
        toast(err.message || '保存失败', 'err');
        btn.disabled = false;
      }
    };
    form.addEventListener('submit', submit);
    form.appendChild(h('div', { style: { display: 'none' } }, h('button', { type: 'submit' })));
    const { close } = openModal({
      title,
      wide,
      body: form,
      footer: h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); resolve(null); } }, '取消'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => submit() }, okText),
      ),
      onClose: () => resolve(null),
    });
    inputRefFocus(form);
  });
}

function inputRefFocus(form) {
  const first = form.querySelector('input, select, textarea');
  setTimeout(() => first?.focus(), 60);
}

export function pageHeader(title, sub, actions = []) {
  return h('div', { class: 'flex-between mb-20' },
    h('div', {},
      h('h2', { style: { margin: '0 0 2px', fontSize: '21px', letterSpacing: '-.01em' } }, title),
      sub ? h('div', { class: 'dim', style: { fontSize: '12.5px' } }, sub) : null,
    ),
    actions.length ? h('div', { class: 'btn-row' }, ...actions) : null,
  );
}
