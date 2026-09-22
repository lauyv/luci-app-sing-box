'use strict';
'require view';

return view.extend({
  handleSaveApply: null,
  handleSave: null,
  handleReset: null,

  render() {
    const url = '/luci-static/sing-box/dashboard/index.html';
    return E('div', { class: 'cbi-map' }, [
      E('h2', {}, 'sing-box 运行面板'),
      E('p', { class: 'cbi-map-descr' }, [
        '首次使用请填写浏览器可访问的 API 地址和密钥。运行面板使用独立的 API 认证。 ',
        E('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, '独立打开'),
      ]),
      E('iframe', {
        src: url,
        title: 'sing-box 概览、代理、连接和日志',
        style: 'display:block;width:100%;height:calc(100dvh - 190px);min-height:520px;border:0;border-radius:6px;',
        referrerpolicy: 'no-referrer',
      }),
    ]);
  },
});
