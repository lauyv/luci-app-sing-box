'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

function method(name, params) {
  return rpc.declare({
    object: 'luci.sing-box',
    method: name,
    params: params || [],
    expect: { '': {} },
  });
}

const api = {
  status: method('status'),
  read: method('read'),
  logs: method('logs'),
  cache: method('cache'),
  fetchConfig: method('fetch', ['url']),
  save: method('save', ['content', 'revision']),
  check: method('check', ['content']),
  action: method('action', ['name', 'revision']),
  autostart: method('autostart', ['enabled']),
};

const messages = {
  apply_failed: '配置已保存，但服务未能稳定启动，请检查日志并修改配置',
  operation_interrupted: '操作已中断，请检查配置和服务状态',
  config_path_invalid: 'sing-box.main.conffile 必须是绝对路径',
  workdir_invalid: 'sing-box.main.workdir 必须是绝对路径',
  config_not_regular: '配置路径不是普通文件',
  config_symlink: '不支持符号链接配置文件',
  service_missing: '缺少 sing-box 可执行文件或启动脚本',
  config_missing: '没有已保存的配置',
  config_too_large: '配置大小超过 64 KiB',
  url_invalid: '请输入有效的 HTTP 或 HTTPS 配置地址',
  config_fetch_failed: '在线配置拉取失败，请检查地址和网络连接',
  check_failed: '配置校验失败（退出码 %s）',
  check_prepare_failed: '无法准备临时校验文件',
  operation_running: '正在执行：%s',
  check_passed: '配置文件通过 sing-box 校验',
  config_applied: '配置已应用，服务 PID 保持稳定。未测试网络连通性。',
  start_failed: '服务未能稳定启动，请检查日志',
  service_running: '服务正在运行',
  stop_failed: '服务未能停止',
  service_stopped: '服务已停止',
  action_unknown: '未知操作',
  directories_failed: '无法初始化面板目录',
  logs_failed: '无法读取系统日志（logread 失败或超时）',
  request_invalid: '请求无效',
  content_invalid: '配置内容必须是字符串',
  operation_busy: '另一项操作正在执行',
  config_save_failed: '无法保存配置文件',
  config_saved: '配置文件已保存；服务未重启',
  config_changed: '配置文件已改变，请重新加载后再保存或应用',
  operation_queued: '操作已加入队列',
  enabled_invalid: 'enabled 必须是布尔值',
  autostart_updated: '开机启动设置已更新',
  autostart_failed: '无法更改开机启动设置',
  method_unknown: '未知方法',
  service_status_failed: '无法确认服务进程状态，操作已中止',
  cache_disabled: '已保存配置未启用缓存文件，无需清理',
  cache_missing: '缓存文件不存在，无需清理',
  cache_config_invalid: '无法读取有效配置，不能确定缓存文件',
  cache_workdir_unsafe: '仅支持无符号链接的专用工作目录：/usr/share/sing-box、/var/lib/sing-box、/tmp/sing-box',
  cache_path_unsafe: '缓存路径不安全：必须是工作目录内的普通文件，不能是配置文件、链接或挂载路径',
  cache_inspect_failed: '无法读取缓存文件或挂载信息，请检查系统工具和文件访问权限',
  cache_changed: '配置或缓存文件已改变，请重新打开确认窗口',
  cache_remove_failed: '清理缓存失败，服务保持停止',
  cache_start_failed: '缓存已清理，但服务未能稳定启动，请检查日志；旧缓存未备份',
  cache_reset: '缓存已清理，服务保持停止',
  cache_reset_start: '缓存已清理，服务已重新启动',
};

const actions = {
  validate: '校验',
  apply: '应用',
  start: '启动',
  stop: '停止',
  restart: '重启',
  cache_reset: '清理缓存',
  cache_reset_start: '清理缓存并启动',
};

function message(result) {
  const value = result.code === 'operation_running' ? actions[result.argument] : result.argument;
  return Object.prototype.hasOwnProperty.call(messages, result.code)
    ? messages[result.code].replace('%s', () => (value == null ? '' : String(value)))
    : result.message || '后端返回无效响应';
}

function checked(result) {
  if (!result || !result.ok) throw new Error(result ? message(result) : '后端返回无效响应');
  return result;
}

function field(title, node) {
  return E('div', { class: 'cbi-value' }, [
    E('div', { class: 'cbi-value-title' }, title),
    E('div', { class: 'cbi-value-field' }, node),
  ]);
}

return view.extend({
  handleSaveApply: null,
  handleSave: null,
  handleReset: null,

  load() {
    return Promise.all([api.status().then(checked), api.read()]);
  },

  notify(text, error, details) {
    if (this.notification) this.notification.remove();
    const content = E('div', {}, [E('p', {}, text)]);
    if (details) content.appendChild(E('pre', { class: 'sing-box-output' }, details));
    this.notification = error
      ? ui.addNotification(null, content, 'error')
      : ui.addTimeLimitedNotification(null, content, 4500, 'info');
  },

  updateControls() {
    const busy = !!(this.localBusy || this.status.busy);
    this.buttons.forEach(({ node, write, config }) => {
      node.disabled = busy || (write && !this.writable) || (config && !this.loaded);
    });
    this.boot.disabled = busy || !this.writable;
    this.editor.readOnly = busy || !this.writable || !this.loaded;
  },

  async run(fn, write) {
    if (this.localBusy || this.status.busy || (write && !this.writable)) return;
    this.localBusy = true;
    this.updateControls();
    try {
      await fn();
    } catch (error) {
      this.notify(error.message, true);
    } finally {
      this.localBusy = false;
      try {
        await this.refresh();
      } catch (error) {
        this.notify(error.message, true);
      }
      this.updateControls();
    }
  },

  button(label, fn, style, write = true, config = false) {
    const node = E(
      'button',
      {
        type: 'button',
        class: 'cbi-button cbi-button-' + (style || 'action'),
        click: () => this.run(fn, write),
      },
      label,
    );
    this.buttons.push({ node, write, config });
    return node;
  },

  updateDirty() {
    this.dirty.textContent = !this.loaded
      ? '配置读取失败，请修复后重载。'
      : this.status.revision && this.status.revision !== this.revision
        ? messages.config_changed
        : this.editor.value !== this.savedText
          ? '有未保存的修改。'
          : '编辑器内容与配置文件一致。';
  },

  setConfig(result) {
    checked(result);
    this.savedText = result.content || '';
    this.editor.value = this.savedText;
    this.revision = result.revision;
    this.loaded = true;
    this.updateDirty();
  },

  content() {
    if (!this.loaded) throw new Error('请先重载配置');
    if (new Blob([this.editor.value]).size > 65536) throw new Error(messages.config_too_large);
    return this.editor.value;
  },

  replaceEditor(content) {
    if (typeof content !== 'string') throw new Error(messages.content_invalid);
    if (new Blob([content]).size > 65536) throw new Error(messages.config_too_large);
    if (this.editor.value !== this.savedText && !window.confirm('放弃当前未保存的修改并载入新配置？')) return false;
    this.editor.value = content;
    this.updateDirty();
    return true;
  },

  async fetchConfig() {
    const url = this.configUrl.value.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(messages.url_invalid);
    const result = checked(await api.fetchConfig(url));
    if (this.replaceEditor(result.content)) this.notify('在线配置已载入编辑器，尚未保存。');
  },

  async importFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name)) throw new Error('请选择 JSON 配置文件');
    const content = await file.text();
    if (this.replaceEditor(content)) this.notify('本地配置已载入编辑器，尚未保存。');
  },

  async queue(name, revision) {
    checked(await api.action(name, revision || ''));
    this.status.busy = true;
    this.lastJob = null;
  },

  async showCacheReset() {
    const plan = await api.cache();
    if (!plan) throw new Error('后端返回无效响应');
    const checkbox = new ui.Checkbox(plan.running ? '1' : '0', {
      id: 'sing-box-cache-start',
      disabled: !plan.ok || !this.writable,
    }).render();
    const start = checkbox.querySelector('input[type="checkbox"]');
    checkbox.querySelector('label').textContent = '完成后启动服务';
    const confirm = E(
      'button',
      {
        type: 'button',
        class: 'cbi-button cbi-button-negative',
        disabled: !plan.ok || !this.writable ? '' : null,
        click: () => {
          ui.hideModal();
          return this.run(() => this.queue(start.checked ? 'cache_reset_start' : 'cache_reset', plan.token), true);
        },
      },
      '清理缓存',
    );
    ui.showModal('清理缓存', [
      E('p', {}, '仅删除已保存配置使用的缓存数据库，不清理工作目录中的其他文件。旧缓存不会备份，删除后无法恢复。'),
      E('p', {}, ['工作目录：', E('code', {}, plan.workdir || '未配置')]),
      E('p', {}, ['缓存文件：', E('code', {}, plan.path || '未启用或无法确定')]),
      E(
        'p',
        { role: 'status' },
        plan.ok ? '执行前会停止服务并等待进程退出。下次启动时由 sing-box 重新生成缓存。' : message(plan),
      ),
      checkbox,
      E('div', { class: 'right' }, [
        E('button', { type: 'button', class: 'cbi-button cbi-button-neutral', click: ui.hideModal }, '取消'),
        ' ',
        confirm,
      ]),
    ]);
  },

  async save(apply) {
    const content = this.content();
    const result = checked(await api.save(content, this.revision));
    this.savedText = content;
    this.revision = result.revision;
    this.status.revision = result.revision;
    this.updateDirty();
    if (apply) await this.queue('apply', result.revision);
    else this.notify(message(result));
  },

  updateStatus(status) {
    this.status = status;
    this.runtime.textContent = status.running ? '运行中 · PID ' + status.pid : '已停止';
    this.version.textContent = status.version || '未检测到内核';
    this.path.textContent = status.config || '未配置';
    if (!this.localBusy) this.boot.checked = !!status.autostart;
    this.problem.textContent = status.error_code ? message({ code: status.error_code }) : status.error || '';
    this.problem.hidden = !this.problem.textContent;
    this.progress.textContent = status.busy ? '后台操作进行中，请稍候…' : '';
    if (status.job && status.job !== this.lastJob) {
      this.lastJob = status.job;
      try {
        const job = JSON.parse(status.job);
        if (job.state === 'error' || job.state === 'success')
          this.notify(message(job), job.state === 'error', job.details);
      } catch {
        this.notify('无法解析后台操作状态', true);
      }
    }
    this.updateDirty();
    this.updateControls();
  },

  async refresh() {
    this.updateStatus(checked(await api.status()));
  },

  async refreshLogs() {
    if (this.loadingLogs) return;
    this.loadingLogs = true;
    try {
      const result = checked(await api.logs());
      this.logHint.textContent =
        result.mode === 'file'
          ? '日志写入文件：' + result.output + '。下方仅显示系统日志。'
          : result.mode === 'disabled'
            ? '运行日志已关闭，下方可能是历史日志。'
            : result.log_stderr === false
              ? 'log_stderr 已关闭，日志收集取决于设备启动脚本。'
              : '';
      // oxlint-disable-next-line no-control-regex -- Strip ANSI color codes from system logs.
      const ansi = /(?:\x1b\[|\x9b)[0-9;:]*m/g;
      this.logs.value = (result.content || '').replace(ansi, '') || '暂无 sing-box 系统日志。';
      this.logUpdated.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
    } catch (error) {
      this.logHint.textContent = '日志刷新失败：' + error.message;
    } finally {
      this.loadingLogs = false;
    }
  },

  render(data) {
    this.writable = L.hasViewPermission() === true;
    this.status = data[0];
    this.buttons = [];
    this.loaded = false;
    this.localBusy = false;
    this.runtime = E('strong');
    this.version = E('span');
    this.path = E('code');
    this.problem = E('p', { class: 'cbi-section-descr', role: 'alert', hidden: true });
    this.progress = E('p', { role: 'status', 'aria-live': 'polite' });
    this.dirty = E('div', { class: 'cbi-section-descr', 'aria-live': 'polite' });
    this.editor = E('textarea', {
      class: 'cbi-input-textarea',
      rows: 24,
      spellcheck: 'false',
      'aria-label': 'sing-box JSON 配置',
      input: () => this.updateDirty(),
    });
    this.configUrl = E('input', {
      class: 'cbi-input-text',
      type: 'url',
      placeholder: 'https://example.com/config.json',
      'aria-label': '在线配置 URL',
    });
    const fileInput = E('input', {
      type: 'file',
      accept: '.json,application/json',
      hidden: '',
      style: 'display:none',
      change: (event) => {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        this.run(() => this.importFile(file), true);
      },
    });
    const checkbox = new ui.Checkbox('0', { id: 'sing-box-autostart' }).render();
    this.boot = checkbox.querySelector('input[type="checkbox"]');
    this.boot.setAttribute('aria-label', '开机启动');
    this.boot.addEventListener('change', () => {
      const enabled = this.boot.checked;
      this.run(async () => {
        checked(await api.autostart(enabled));
        this.notify(messages.autostart_updated);
      }, true);
    });
    const overview = E('div', { 'data-tab': 'overview', 'data-tab-title': '服务' }, [
      field('运行状态', this.runtime),
      field('内核版本', this.version),
      field('配置文件', this.path),
      field('开机启动', checkbox),
      field(
        '运行面板',
        E(
          'button',
          {
            type: 'button',
            class: 'cbi-button cbi-button-action',
            click: () => window.open('/luci-static/sing-box/dashboard/index.html', '_blank', 'noopener,noreferrer'),
          },
          '独立打开',
        ),
      ),
      field(
        '服务操作',
        E('div', { class: 'sing-box-actions' }, [
          this.button('启动', () => this.queue('start'), 'apply'),
          this.button('停止', () => this.queue('stop'), 'negative'),
          this.button('重启', () => this.queue('restart')),
        ]),
      ),
      field('维护', [
        this.button('清理缓存', () => this.showCacheReset(), 'negative'),
        E('div', { class: 'cbi-value-description' }, '仅清理缓存数据库，不备份，不重建工作目录。'),
      ]),
    ]);
    const config = E('div', { 'data-tab': 'config', 'data-tab-title': '配置' }, [
      field(
        '导入配置',
        E('div', { class: 'sing-box-actions' }, [
          this.configUrl,
          this.button('拉取', () => this.fetchConfig(), 'action', true, true),
          fileInput,
          this.button('上传 JSON', () => fileInput.click(), 'action', true, true),
        ]),
      ),
      this.dirty,
      this.editor,
      E('div', { class: 'cbi-page-actions sing-box-actions' }, [
        this.button(
          '重载配置',
          async () => {
            if (this.loaded && this.editor.value !== this.savedText && !window.confirm('放弃未保存的修改并重载配置？'))
              return;
            this.setConfig(await api.read());
          },
          'reset',
          false,
        ),
        this.button(
          '格式化 JSON',
          () => {
            this.editor.value = JSON.stringify(JSON.parse(this.content()), null, 2) + '\n';
            this.updateDirty();
          },
          'neutral',
          true,
          true,
        ),
        this.button(
          '校验',
          async () => {
            checked(await api.check(this.content()));
            this.status.busy = true;
            this.lastJob = null;
          },
          'action',
          true,
          true,
        ),
        this.button('保存', () => this.save(false), 'action', true, true),
        this.button('保存并应用', () => this.save(true), 'apply', true, true),
      ]),
    ]);
    this.logHint = E('div', { class: 'cbi-section-descr', role: 'status' });
    this.logUpdated = E('div', { class: 'cbi-section-descr' });
    this.logs = E('textarea', {
      class: 'cbi-input-textarea',
      rows: 20,
      readonly: '',
      'aria-label': 'sing-box 系统日志',
    });
    const logs = E('div', { 'data-tab': 'logs', 'data-tab-title': '系统日志' }, [this.logHint, this.logUpdated, this.logs]);
    logs.addEventListener('cbi-tab-active', () => this.refreshLogs());
    const panes = E('div', {}, [overview, config, logs]);
    const root = E('div', { class: 'cbi-map', id: 'sing-box-panel' }, [
      E('link', { rel: 'stylesheet', href: L.resource('view/sing-box/panel.css') }),
      E('h2', {}, 'sing-box'),
      E('p', { class: 'cbi-map-descr' }, this.writable ? '配置与服务管理' : '当前账号仅有查看权限。'),
      this.problem,
      this.progress,
      E('div', { class: 'cbi-section' }, [panes]),
    ]);
    ui.tabs.initTabGroup(panes.childNodes);
    try {
      this.setConfig(data[1]);
    } catch (error) {
      this.notify(error.message, true);
    }
    // 已完成的成功任务不在重新进入页面时重复提示。
    try {
      if (this.status.job && JSON.parse(this.status.job).state === 'success') this.lastJob = this.status.job;
    } catch {
      /* updateStatus reports malformed task data. */
    }
    this.updateStatus(this.status);
    poll.add(async () => {
      try {
        await this.refresh();
      } catch (error) {
        this.problem.textContent = '状态刷新失败：' + error.message;
        this.problem.hidden = false;
      }
      if (logs.getAttribute('data-tab-active') === 'true') await this.refreshLogs();
    }, 5);
    return root;
  },
});
