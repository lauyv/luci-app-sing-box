"use strict";
"require view";
"require rpc";
"require poll";

var callStatus = rpc.declare({ object: "luci.sing-box", method: "status", expect: { "": {} } });
var callRead = rpc.declare({ object: "luci.sing-box", method: "read", expect: { "": {} } });
var callLogs = rpc.declare({ object: "luci.sing-box", method: "logs", expect: { "": {} } });
var callSave = rpc.declare({
  object: "luci.sing-box",
  method: "save",
  params: ["content", "revision"],
  expect: { "": {} },
});
var callCheck = rpc.declare({ object: "luci.sing-box", method: "check", params: ["content"], expect: { "": {} } });
var callAction = rpc.declare({
  object: "luci.sing-box",
  method: "action",
  params: ["name", "revision"],
  expect: { "": {} },
});
var callAutostart = rpc.declare({
  object: "luci.sing-box",
  method: "autostart",
  params: ["enabled"],
  expect: { "": {} },
});

// 后端结果码对应的中文提示。
var messages = {
  apply_failed: "配置已保存，但服务未能稳定启动，请检查日志并修改配置",
  operation_interrupted: "操作已中断，请检查配置和服务状态",
  config_path_invalid: "sing-box.main.conffile 必须是绝对路径",
  workdir_invalid: "sing-box.main.workdir 必须是绝对路径",
  config_not_regular: "配置路径不是普通文件",
  config_symlink: "不支持符号链接配置文件",
  service_missing: "缺少 sing-box 可执行文件或启动脚本",
  config_missing: "没有已保存的配置",
  config_too_large: "配置大小超过 64 KiB",
  check_failed: "配置校验失败（退出码 %s）",
  check_prepare_failed: "无法准备临时校验文件",
  operation_running: "正在执行：%s",
  check_passed: "配置文件通过 sing-box 校验",
  config_applied: "配置已应用，服务 PID 保持稳定。未测试网络连通性。",
  start_failed: "服务未能稳定启动，请检查日志",
  service_running: "服务正在运行",
  stop_failed: "服务未能停止",
  service_stopped: "服务已停止",
  action_unknown: "未知操作",
  directories_failed: "无法初始化面板目录",
  logs_failed: "无法读取系统日志（logread 失败或超时）",
  request_invalid: "请求无效",
  content_invalid: "配置内容必须是字符串",
  operation_busy: "另一项操作正在执行",
  config_save_failed: "无法保存配置文件",
  config_saved: "配置文件已保存；服务未重启",
  config_changed: "配置文件已改变，请重新加载后再保存或应用",
  operation_queued: "操作已加入队列",
  enabled_invalid: "enabled 必须是布尔值",
  autostart_updated: "开机启动设置已更新",
  autostart_failed: "无法更改开机启动设置",
  method_unknown: "未知方法",
};

var actionLabels = {
  validate: "校验",
  apply: "应用",
  start: "启动",
  stop: "停止",
  restart: "重启",
};

function format(message, value) {
  return message.replace("%s", function () {
    return String(value == null ? "" : value);
  });
}

function backendMessage(result, fallback) {
  if (result && Object.prototype.hasOwnProperty.call(messages, result.code)) {
    var value = result.argument;
    if (result.code === "operation_running")
      value = Object.prototype.hasOwnProperty.call(actionLabels, value)
        ? actionLabels[value]
        : value;
    return format(messages[result.code], value);
  }
  // Old task results and newer, unknown backend responses remain readable.
  return (result && result.message) || fallback || "后端返回无效响应";
}

function checked(result) {
  if (!result || !result.ok) throw new Error(backendMessage(result));
  return result;
}

return view.extend({
  handleSaveApply: null,
  handleSave: null,
  handleReset: null,

  load: function () {
    return Promise.all([callStatus(), callRead()]);
  },

  dismissMessage: function () {
    window.clearTimeout(this.messageTimer);
    this.messageTimer = null;
    if (this.messageBox) this.messageBox.hidden = true;
  },

  showMessage: function (message, kind, details) {
    this.dismissMessage();
    this.job.textContent = message + (details ? "\n" + details : "");
    this.messageBox.setAttribute("data-state", kind);
    this.messageBox.hidden = false;
    if (kind === "success") {
      this.messageTimer = window.setTimeout(L.bind(this.dismissMessage, this), 4500);
    }
  },

  updateJob: function (raw) {
    if (!raw || raw === this.lastJob) return;
    this.lastJob = raw;
    try {
      var job = JSON.parse(raw);
      this.showMessage(backendMessage(job), job.state, job.details);
    } catch {
      this.showMessage("无法解析后台操作状态", "error");
    }
  },

  setBusy: function () {
    var busy = this.localBusy || (this.status && this.status.busy);
    this.buttons.forEach(function (button) {
      button.disabled = !!busy;
    });
    this.boot.disabled = !!busy;
    this.editor.disabled = !!busy;
  },

  run: function (fn) {
    if (this.localBusy || this.status.busy) return Promise.resolve();
    this.localBusy = true;
    this.setBusy();
    return Promise.resolve()
      .then(fn)
      .catch(
        L.bind(function (error) {
          this.showMessage(error.message, "error");
        }, this),
      )
      .finally(
        L.bind(function () {
          this.localBusy = false;
          return this.refresh()
            .catch(
              L.bind(function (error) {
                this.showMessage(error.message, "error");
              }, this),
            )
            .finally(L.bind(this.setBusy, this));
        }, this),
      );
  },

  checkEditor: function () {
    var content = this.editor.value;
    if (new Blob([content]).size > 65536)
      return Promise.reject(new Error("配置大小不能超过 64 KiB"));
    return callCheck(content).then(checked).then(L.bind(function () {
      this.status.busy = true;
      this.lastJob = null;
      this.showMessage("正在校验编辑器内容…", "running");
      this.setBusy();
    }, this));
  },

  saveConfig: function () {
    var text = this.editor.value;
    if (new Blob([text]).size > 65536) return Promise.reject(new Error("配置大小不能超过 64 KiB"));
    return callSave(text, this.revision)
      .then(checked)
      .then(
        L.bind(function (result) {
          this.savedText = text;
          this.revision = result.revision;
          this.status.revision = result.revision;
          this.updateDirty();
          return result;
        }, this),
      );
  },

  queue: function (name, revision) {
    return callAction(name, revision || "")
      .then(checked)
      .then(
        L.bind(function () {
          this.status.busy = true;
          this.lastJob = null;
          this.showMessage("操作已提交，正在等待后台结果…", "queued");
          this.setBusy();
        }, this),
      );
  },

  updateDirty: function () {
    if (this.status.revision && this.revision && this.status.revision !== this.revision) {
      this.dirty.textContent = backendMessage({ code: "config_changed" });
      return;
    }
    this.dirty.textContent =
      this.editor.value === this.savedText
        ? "编辑器内容与配置文件一致。"
        : "有未保存的修改。校验不会保存；点击“保存并应用”写入配置并重启服务。";
  },

  refresh: function () {
    return callStatus()
      .then(checked)
      .then(
        L.bind(function (status) {
          this.status = status;
          this.runtime.textContent = status.running
            ? format("运行中 · PID %s", status.pid)
            : "已停止";
          this.version.textContent = status.version || "未检测到内核";
          this.path.textContent = status.config || "未配置";
          this.boot.checked = status.autostart;
          this.problem.textContent = status.error_code
            ? backendMessage({ code: status.error_code, message: status.error })
            : status.error || "";
          this.runtime.setAttribute("data-running", status.running ? "true" : "false");
          this.updateJob(status.job);
          this.updateDirty();
          this.setBusy();
        }, this),
      );
  },

  refreshLogs: function () {
    return callLogs()
      .then(checked)
      .then(
        L.bind(function (result) {
          this.logHint.textContent =
            result.mode === "file"
              ? format(
                  "当前配置将日志写入文件：%s。这里仅显示系统日志，不读取该文件。",
                  result.output,
                )
              : result.mode === "disabled"
                ? "当前配置已关闭运行日志。以下内容可能是历史系统日志。"
                : "";
          if (result.mode === "system" && result.log_stderr === false)
            this.logHint.textContent +=
              "UCI 中的 log_stderr 已关闭。如果启动脚本使用此选项，新的运行日志将不会被收集到系统日志。将 sing-box.main.log_stderr 设为 1 并重启服务可启用收集。";
          // eslint-disable-next-line no-control-regex -- Strip ANSI color sequences from plain-text logs.
          var content = (result.content || "").replace(/(?:\x1b\[|\x9b)[0-9;:]*m/g, "");
          this.logText.textContent = content || "暂无 sing-box 系统日志。";
          this.logUpdated.textContent = format("更新于 %s", new Date().toLocaleTimeString("zh-CN"));
        }, this),
      );
  },

  render: function (data) {
    this.dismissMessage();
    this.status = checked(data[0]);
    this.lastJob = null;
    try {
      if (this.status.job && JSON.parse(this.status.job).state === "success")
        this.lastJob = this.status.job;
    } catch { /* 刷新时显示无法解析的任务信息。 */ }
    this.buttons = [];
    this.localBusy = false;
    this.activeTab = "overview";
    var read = data[1];
    this.savedText = read.content || "";
    this.revision = read.revision || "";
    this.editor = E("textarea", {
      class: "cbi-input-textarea sb-editor",
      rows: 24,
      spellcheck: "false",
      "aria-label": "sing-box JSON 配置",
      input: L.bind(this.updateDirty, this),
    });
    this.editor.value = this.savedText;
    this.dirty = E("p", { class: "sb-hint sb-dirty" });
    this.runtime = E("strong", { class: "sb-status" });
    this.version = E("span");
    this.path = E("code");
    this.problem = E("p", { class: "sb-problem", role: "alert" });
    this.job = E("div", { class: "sb-message-text", role: "status", "aria-live": "polite" });
    this.messageBox = E("div", { class: "sb-message", hidden: true }, [
      this.job,
      E("button", { type: "button", class: "sb-dismiss", "aria-label": "关闭提示",
        click: L.bind(this.dismissMessage, this) }, "×")
    ]);
    if (!read.ok) this.showMessage(backendMessage(read, "配置读取失败"), "error");
    this.boot = E("input", {
      type: "checkbox",
      "aria-label": "开机启动",
      change: L.bind(function () {
        var enabled = this.boot.checked;
        this.run(function () {
          return callAutostart(enabled).then(checked);
        });
      }, this),
    });

    var button = L.bind(function (label, fn) {
      var node = E(
        "button",
        {
          type: "button",
          class: "cbi-button cbi-button-action",
          click: L.bind(function () {
            return this.run(fn);
          }, this),
        },
        label,
      );
      this.buttons.push(node);
      return node;
    }, this);
    var field = function (label, content) {
      return E("div", { class: "cbi-value" }, [
        E("div", { class: "cbi-value-title" }, label),
        E("div", { class: "cbi-value-field" }, content)
      ]);
    };
    var overview = E("section", { class: "cbi-section sb-section", role: "tabpanel", id: "sb-overview", "aria-labelledby": "sb-tab-overview" }, [
      E("h3", {}, "服务设置"),
      E("div", { class: "cbi-section-node sb-form" }, [
        field("运行状态", [this.runtime]),
        field("内核版本", [this.version]),
        field("配置文件", [this.path]),
        field("开机启动", [
          E("label", { class: "sb-check" }, [this.boot]),
          E("div", { class: "cbi-value-description" }, "随路由器启动 sing-box 服务"),
          E("div", { class: "sb-toolbar" }, [
            button(
              "启动",
              L.bind(function () {
                return this.queue("start");
              }, this),
            ),
            button(
              "停止",
              L.bind(function () {
                return this.queue("stop");
              }, this),
            ),
            button(
              "重启",
              L.bind(function () {
                return this.queue("restart");
              }, this),
            ),
          ]),
        ]),
      ]),
    ]);

    var config = E("div", { class: "sb-config-page", role: "tabpanel", id: "sb-config", "aria-labelledby": "sb-tab-config" }, [
      E("section", { class: "cbi-section sb-section sb-config-content" }, [
        E("h3", {}, "配置内容"),
        E(
          "p",
          { class: "sb-config-description" },
          "直接编辑 JSON。校验不保存；保存并应用后重启服务。",
        ),
        this.dirty,
        this.editor,
      ]),
      E("div", { class: "sb-toolbar sb-config-actions" }, [
        button(
          "重载配置",
          L.bind(function () {
            return callRead()
              .then(checked)
              .then(
                L.bind(function (result) {
                  this.editor.value = result.content;
                  this.savedText = result.content;
                  this.revision = result.revision;
                  this.status.revision = result.revision;
                  this.updateDirty();
                }, this),
              );
          }, this),
        ),
        button(
          "格式化 JSON",
          L.bind(function () {
            try {
              this.editor.value = JSON.stringify(JSON.parse(this.editor.value), null, 2) + "\n";
            } catch (error) {
              throw new Error(format("JSON 格式无效。解析器详情：%s", error.message));
            }
            this.updateDirty();
          }, this),
        ),
        button(
          "校验",
          L.bind(function () { return this.checkEditor(); }, this),
        ),
        button(
          "保存并应用",
          L.bind(function () {
            return this.saveConfig().then(
              L.bind(function (result) {
                return this.queue("apply", result.revision);
              }, this),
            );
          }, this),
        ),
      ]),
    ]);
    this.logHint = E("p", { class: "sb-hint" });
    this.logUpdated = E("span", { class: "sb-hint sb-updated" });
    this.logText = E("pre", {
      class: "sb-log",
    });
    var logs = E("section", { class: "sb-logs-page", role: "tabpanel", id: "sb-logs", "aria-labelledby": "sb-tab-logs" }, [
      E("h3", {}, "日志内容"),
      this.logHint,
      this.logUpdated,
      E("div", { class: "cbi-section sb-log-card" }, [this.logText]),
    ]);
    var editor = this.editor;
    var logText = this.logText;
    var configActions = config.querySelector(".sb-config-actions");
    function outerHeight(node) {
      if (!node) return 0;
      var style = window.getComputedStyle(node);
      return node.getBoundingClientRect().height +
        (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }
    var resizePanels = function () {
      if (!config.isConnected) {
        window.removeEventListener("resize", resizePanels);
        layoutObserver.disconnect();
        return;
      }
      var isConfig = config.getClientRects().length > 0;
      if (!isConfig && !logs.getClientRects().length) return;
      var content = isConfig ? editor : logText;
      var top = content.getBoundingClientRect().top + window.scrollY;
      // 为页脚和底部操作栏预留空间，滚动保持在内容区内部。
      // 页脚的自动外边距可能用于填满页面，不能算作固定占用高度。
      var footer = document.querySelector("footer");
      var reserved = (footer ? footer.getBoundingClientRect().height : 0) +
        (isConfig ? outerHeight(configActions) : 0) + 48;
      var height = Math.max(isConfig ? 240 : 80, window.innerHeight - top - reserved) + "px";
      if (content.style.height !== height) content.style.height = height;
    };
    var layoutObserver = new ResizeObserver(resizePanels);
    layoutObserver.observe(config);
    layoutObserver.observe(logs);
    layoutObserver.observe(this.messageBox);
    layoutObserver.observe(this.problem);
    window.addEventListener("resize", resizePanels);
    config.style.display = "none";
    logs.style.display = "none";
    var sections = { overview: overview, config: config, logs: logs };
    var tabItems = {};
    var tabs = {};
    var nav = E("ul", { class: "cbi-tabmenu sb-tabs", role: "tablist", "aria-label": "面板导航" });
    [
      ["overview", "概览"],
      ["config", "配置"],
      ["logs", "日志"],
    ].forEach(
      L.bind(function (item) {
        tabs[item[0]] = E(
          "a",
          {
            href: "#sb-" + item[0],
            id: "sb-tab-" + item[0],
            "aria-controls": "sb-" + item[0],
            role: "tab",
            "aria-selected": item[0] === "overview" ? "true" : "false",
            click: L.bind(function (event) {
              event.preventDefault();
              this.activeTab = item[0];
              Object.keys(sections).forEach(function (key) {
                sections[key].style.display = key === item[0] ? "" : "none";
                tabs[key].setAttribute("aria-selected", key === item[0] ? "true" : "false");
                tabItems[key].className = key === item[0] ? "cbi-tab" : "cbi-tab-disabled";
              });
              if (item[0] === "config" || item[0] === "logs") resizePanels();
              if (item[0] === "logs")
                this.refreshLogs().catch(
                  L.bind(function (error) {
                    this.showMessage(error.message, "error");
                  }, this),
                );
            }, this),
          },
          item[1],
        );
        tabItems[item[0]] = E("li", { class: item[0] === "overview" ? "cbi-tab" : "cbi-tab-disabled", role: "presentation" }, [tabs[item[0]]]);
        nav.appendChild(tabItems[item[0]]);
      }, this),
    );
    this.updateDirty();
    this.setBusy();
    poll.add(
      L.bind(function () {
        return this.refresh()
          .then(
            L.bind(function () {
              if (this.activeTab === "logs") return this.refreshLogs();
            }, this),
          )
          .catch(
            L.bind(function (error) {
              this.problem.textContent = format("刷新失败：%s", error.message);
            }, this),
          );
      }, this),
      5,
    );
    this.refresh().catch(
      L.bind(function (error) {
        this.showMessage(error.message, "error");
      }, this),
    );
    return E("div", { class: "cbi-map sb-panel" }, [
      E("link", { rel: "stylesheet", href: L.resource("view/sing-box/panel.css") }),
      E("h2", {}, "sing-box"),
      this.problem,
      this.messageBox,
      nav,
      overview,
      config,
      logs,
    ]);
  },
});
