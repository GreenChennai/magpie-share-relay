(() => {
  const status = document.getElementById("status");
  const retry = document.getElementById("retry");
  let leaving = false;

  function show(message) {
    if (leaving) return;
    status.textContent = message;
    retry.hidden = false;
  }

  const timer = setTimeout(() => show("本地共享服务没有在运行。请先启动 magpie 的共享插件，再重试。"), 5000);
  retry.addEventListener("click", () => location.reload());

  (async () => {
    let theme = null;
    let options = {};
    try {
      theme = await window.magpie?.ready ?? null;
      options = (await window.magpie?.options?.get?.()) ?? {};
    } catch {
      // A page opened outside magpie has no bridge: fall back to the default port.
    }
    const port = Number(options.port) || 3488;
    let target = window.magpie?.service || `http://127.0.0.1:${port}/`;
    try {
      const url = new URL(target);
      if (theme && typeof theme.dark === "boolean") url.searchParams.set("theme", theme.dark ? "dark" : "light");
      if (theme?.tokens) url.searchParams.set("tokens", JSON.stringify(theme.tokens));
      target = url.toString();
    } catch {
      // Keep the plain address when the bridge gave something unparsable.
    }
    leaving = true;
    clearTimeout(timer);
    location.replace(target);
  })();
})();
