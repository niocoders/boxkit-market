// legacy plugin format 风格 preload：与 legacy plugin format 插件写法一致，直接使用 legacy plugin format 全局
legacy plugin format.onPluginEnter(({ code, payload }) => {
  window.currentFeature = code;
  window.enterPayload = payload;
  const el = document.getElementById("status");
  if (el) el.textContent = `进入功能: ${code}${payload ? ` · 输入: ${payload}` : ""}`;
});

legacy plugin format.onPluginOut(() => {
  window.currentFeature = undefined;
});
