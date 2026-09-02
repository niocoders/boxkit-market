// BoxKit preload 示例
bk.onPluginEnter(({ code, payload }) => {
  window.currentFeature = code;
  window.enterPayload = payload;
  const el = document.getElementById("status");
  if (el) el.textContent = `进入功能: ${code}${payload ? ` · 输入: ${payload}` : ""}`;
});

bk.onPluginOut(() => {
  window.currentFeature = undefined;
});
