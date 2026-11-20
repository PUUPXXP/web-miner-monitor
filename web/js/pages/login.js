// 登录页
import { h } from '../dom.js';
import { api } from '../api.js';

export function LoginPage(root, { onSuccess }) {
  const error = h('div', { class: 'login-error' });
  const username = h('input', { class: 'input', type: 'text', placeholder: 'admin', autocomplete: 'username', value: 'admin' });
  const password = h('input', { class: 'input', type: 'password', placeholder: '请输入密码', autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '登 录');

  const form = h('form', {},
    h('div', { class: 'field' }, h('label', {}, '账号'), username),
    h('div', { class: 'field' }, h('label', {}, '密码'), password),
    error,
    btn,
  );

  const submit = async (e) => {
    e.preventDefault();
    error.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '登录中…';
    try {
      const { user } = await api.login(username.value.trim(), password.value);
      onSuccess(user);
    } catch (err) {
      error.textContent = err.message || '登录失败';
      error.classList.add('show');
      btn.disabled = false;
      btn.textContent = '登 录';
      password.focus();
    }
  };
  form.addEventListener('submit', submit);

  const card = h('div', { class: 'login-wrap' },
    h('div', { class: 'login-card' },
      h('div', { class: 'login-logo' }, '⛏'),
      h('h2', {}, '矿机监控中心'),
      h('p', {}, 'Monero & Pearl · Windows 矿机集中管理'),
      form,
      h('div', { class: 'login-tip' },
        '首次启动的初始密码保存在服务器目录：',
        h('br'),
        h('code', {}, 'data/初始管理员密码.txt'),
        h('br'),
        '登录后请立即在「设置 → 修改密码」中更改。',
      ),
    ),
  );
  root.appendChild(card);
  setTimeout(() => password.focus(), 80);
  return () => {};
}
