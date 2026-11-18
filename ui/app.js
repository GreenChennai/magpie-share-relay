(() => {
  const TOKEN_HEADER = "x-magpie-share-token";
  const token = document.querySelector('meta[name="magpie-share-token"]')?.content || "";
  const $ = (id) => document.getElementById(id);
  const STATE_INTERVAL = 5000;
  const REVEAL_MS = 30000;

  let state = null;
  let usage = new Map();
  let selectedId = "";
  let diagnose = null;
  let logs = [];
  let pending = false;
  let lastSetupDone = null;
  const revealed = new Map();
  let toastTimer = null;

  function applyTheme() {
    const params = new URLSearchParams(location.search);
    const theme = params.get("theme");
    if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;

    const raw = params.get("tokens");
    if (!raw) return;
    let values;
    try {
      values = JSON.parse(raw);
    } catch {
      try {
        const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
        values = JSON.parse(decoded);
      } catch {
        return;
      }
    }
    if (!values || typeof values !== "object") return;
    for (const [name, value] of Object.entries(values)) {
      if (!/^--[a-z0-9-]+$/.test(name) || typeof value !== "string") continue;
      if (/[;{}<>]/.test(value)) continue;
      document.documentElement.style.setProperty(name, value);
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const armed = new WeakMap();

  // The plugin page runs in a sandbox without allow-modals, so window.confirm
  // never opens and always returns false. Confirm inside the page instead:
  // the first click arms the button, the second one does the work.
  function confirmClick(button, question = "确认？") {
    if (!button) return true;
    if (armed.has(button)) {
      clearTimeout(armed.get(button));
      armed.delete(button);
      button.textContent = button.dataset.idleLabel || button.textContent;
      button.classList.remove("armed");
      return true;
    }
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.textContent = question;
    button.classList.add("armed");
    const timer = setTimeout(() => {
      armed.delete(button);
      button.textContent = button.dataset.idleLabel;
      button.classList.remove("armed");
    }, 5000);
    armed.set(button, timer);
    return false;
  }

  function showToast(text, bad = false) {
    const toast = $("toast");
    toast.textContent = text;
    toast.classList.toggle("bad", bad);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
  }

  async function api(path, { method = "GET", body } = {}) {
    const headers = { [TOKEN_HEADER]: token };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return { status: 0, data: { error: String(err?.message || err) } };
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 403 && data.reload) {
      showToast("页面已过期，请重新打开插件页面", true);
    }
    return { status: response.status, data };
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制");
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      showToast(ok ? "已复制" : "复制失败，请手动选择", !ok);
      return ok;
    }
  }

  function findInvite(id) {
    return (state?.invites || []).find((invite) => invite.id === id) || null;
  }

  async function revealSecret(id) {
    const { status, data } = await api(`/api/invites/${encodeURIComponent(id)}/reveal`, { method: "POST" });
    if (status !== 200) {
      showToast(data.error || "无法显示 key", true);
      return "";
    }
    return data.secret || "";
  }

  function setRevealed(id, secret) {
    clearRevealed(id);
    const timer = setTimeout(() => {
      revealed.delete(id);
      renderFriends();
      renderLinks();
    }, REVEAL_MS);
    revealed.set(id, { secret, timer });
  }

  function clearRevealed(id) {
    const entry = revealed.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    revealed.delete(id);
  }

  function periodLabel(period) {
    return { day: "天", week: "周", month: "月" }[period] || period || "";
  }

  function limitText(limit) {
    if (!limit || (limit.costUsd === undefined && !limit.tokens)) {
      return "未限额（警告：可见整机用量）";
    }
    const parts = [];
    if (limit.costUsd !== undefined && limit.costUsd !== null) parts.push(`$${limit.costUsd}`);
    if (limit.tokens) parts.push(`${limit.tokens} tokens`);
    return `限额 ${parts.join(" / ")}/${periodLabel(limit.period)}`;
  }

  function usageText(invite) {
    const entry = usage.get(invite.id);
    if (!entry) return "";
    if (entry.error) return `用量未读取（${entry.error}）`;
    const left = [];
    if (entry.costLeft !== null && entry.costLeft !== undefined) left.push(`剩余 $${entry.costLeft}`);
    if (entry.tokensLeft !== null && entry.tokensLeft !== undefined && entry.tokensLeft > 0) {
      left.push(`剩余 ${entry.tokensLeft} tokens`);
    }
    if (left.length) return left.join(" · ");
    if (entry.costLeft === 0 || (entry.costLeft === null && entry.tokensLeft === 0)) return "限额已用完";
    return entry.limited ? "已设限额" : "未设限额";
  }

  function fmtAgo(ms) {
    if (!Number.isFinite(ms) || ms < 60_000) return "刚刚";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  function renderStatus() {
    if (!state) return;
    const relay = state.relay || { state: "off" };
    const labels = {
      off: "未启动",
      starting: "正在连接",
      up: "中继已连接",
      backoff: "等待重连",
      degraded: "连接不稳定",
      unsafe: "已停止（安全检查失败）",
      preflight_failed: "预检未通过",
    };
    const title = labels[relay.state] || relay.state || "未知";
    $("top-status").textContent = title;
    $("relay-title").textContent = title;
    const detail = [];
    if (relay.lastHint) detail.push(`${relay.lastHint.message}：${relay.lastHint.hint}`);
    else if (relay.lastError) detail.push(relay.lastError);
    if (relay.attempts) detail.push(`已重试 ${relay.attempts} 次`);
    if (!detail.length && relay.nextRetryAt) {
      detail.push(`下次重试：${new Date(relay.nextRetryAt).toLocaleTimeString()}`);
    }
    $("relay-detail").textContent = detail.join(" · ") || "—";
    $("relay-detail").title = relay.lastError || "";
    $("relay-note").hidden = !["starting", "backoff", "degraded"].includes(relay.state);

    $("config-warning").hidden = !state.configRecovered;
    if (state.configRecovered) {
      $("config-warning").textContent = "config.json 已损坏，正在使用备份；请检查设置并重新保存。";
    }

    for (const dot of [$("top-dot"), $("relay-dot")]) {
      dot.className = "dot";
      if (relay.state === "up") dot.classList.add("ok");
      else if (["starting", "backoff", "degraded"].includes(relay.state)) dot.classList.add("warn");
      else if (["unsafe", "preflight_failed"].includes(relay.state)) dot.classList.add("bad");
    }

    $("ssh-uptime").textContent = relay.pid
      ? `${fmtDuration(Date.now() - (relay.since || Date.now()))} · pid ${relay.pid}`
      : "—";
    if (state.publicCheck) {
      const age = fmtAgo(Date.now() - (state.publicCheckAt || 0));
      $("public-check").textContent = `${state.publicCheck.ok ? "✓" : "✗"} ${age}`;
    } else {
      $("public-check").textContent = relay.state === "up" ? "✓ 隧道在线" : "—";
    }
    $("service-port").textContent = state.runtime?.servicePort || "—";
    $("lan-ip").textContent = state.lanIP || "—";

    const base = state.publicURL || "";
    try {
      const url = new URL(base);
      $("public-label").textContent = `${url.host}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      $("public-label").textContent = base || "尚未设置 publicURL";
    }
    $("stop-relay").disabled = relay.state === "off" || relay.state === "preflight_failed";
    $("start-relay").disabled = ["starting", "up", "degraded", "backoff"].includes(relay.state);
  }

  function setTick(stepId, value, detail) {
    const tick = document.querySelector(`#${stepId} [data-tick]`);
    if (!tick) return;
    tick.className = "tick";
    if (value === true) {
      tick.classList.add("ok");
      tick.textContent = "✓";
    } else if (value === false) {
      tick.classList.add("bad");
      tick.textContent = "✗";
    } else {
      tick.textContent = "•";
    }
    if (detail) tick.title = detail;
  }

  function renderSetup() {
    if (!state) return;
    const checks = state.checks || [];
    const share = checks.find((check) => check.id === "share");
    const noKey = checks.find((check) => check.id === "no-key");
    setTick("step-share", share ? share.ok : null, share?.detail);
    $("step-share-note").textContent = share?.detail
      || "在 magpie 的 Settings → Network and sharing 打开。";
    if (noKey && noKey.ok === false) {
      $("step-share-note").textContent = `${share?.detail || ""} ${noKey.detail || ""}`.trim();
    }

    const relay = state.relay || {};
    const connected = relay.state === "up" || relay.state === "degraded";
    const hasKey = Boolean(state.sshPublicKey);
    setTick("step-key", connected ? true : hasKey ? null : false,
      connected ? "隧道已连上，说明公钥已授权" : "复制命令到 RN 执行");
    $("authorize-command").textContent = state.authorizeCommand || "（还没有公钥，稍后会自动生成）";
    $("ssh-public-key").textContent = state.sshPublicKey || "";

    const nginxOk = Boolean(state.nginx?.lastAppliedAt);
    setTick("step-nginx", nginxOk ? true : null,
      nginxOk ? `上次应用：${state.nginx.lastAppliedAt}` : "先预览再应用");

    setTick("step-tunnel", connected ? true : relay.state === "preflight_failed" || relay.state === "unsafe" ? false : null,
      relay.lastError);

    const done = [share?.ok === true, connected, nginxOk, connected].filter(Boolean).length;
    $("setup-progress").textContent = `${done}/4`;
    // Open while there is still work to do, fold away once complete. Only
    // react when the count changes so a manual toggle is not fought by the
    // five-second refresh.
    if (done !== lastSetupDone) {
      $("setup").open = done < 4;
      lastSetupDone = done;
    }
  }

  function renderFriends() {
    if (!state) return;
    const list = $("friends-list");
    list.replaceChildren();
    const invites = state.invites || [];
    if (!invites.length) {
      list.appendChild(el("p", "muted", "还没有朋友。点“新建朋友”创建第一把 key。"));
      return;
    }

    for (const invite of invites) {
      const row = el("div", `friend${invite.revoked ? " revoked" : ""}`);
      const main = el("div", "friend-main");
      const name = el("button", "link-name", invite.name || invite.id);
      name.type = "button";
      name.dataset.action = "select";
      name.dataset.id = invite.id;
      name.disabled = Boolean(invite.revoked);
      main.appendChild(name);

      const limit = el("span", "muted small", limitText(invite.limit));
      main.appendChild(limit);
      const used = usageText(invite);
      if (used) main.appendChild(el("span", "muted small", used));
      if (invite.revoked) main.appendChild(el("span", "bad small", "已撤销"));

      const keyLine = el("div", "friend-key");
      const shown = revealed.get(invite.id)?.secret;
      keyLine.appendChild(el("code", null, shown || invite.secretMasked || "****"));
      if (!invite.revoked) {
        const reveal = el("button", "small", shown ? "隐藏" : "显示");
        reveal.type = "button";
        reveal.dataset.action = "reveal";
        reveal.dataset.id = invite.id;
        keyLine.appendChild(reveal);

        const copyKey = el("button", "small", "复制 key");
        copyKey.type = "button";
        copyKey.dataset.action = "copy-key";
        copyKey.dataset.id = invite.id;
        keyLine.appendChild(copyKey);
      }
      main.appendChild(keyLine);

      const actions = el("div", "actions");
      if (!invite.revoked) {
        const copyLinks = el("button", "small", "复制两条链接");
        copyLinks.type = "button";
        copyLinks.dataset.action = "copy-links";
        copyLinks.dataset.id = invite.id;
        actions.appendChild(copyLinks);

        const rotate = el("button", "small", "轮换");
        rotate.type = "button";
        rotate.dataset.action = "rotate";
        rotate.dataset.id = invite.id;
        actions.appendChild(rotate);

        const revoke = el("button", "small danger", "撤销");
        revoke.type = "button";
        revoke.dataset.action = "revoke";
        revoke.dataset.id = invite.id;
        actions.appendChild(revoke);
      }
      main.appendChild(actions);
      row.appendChild(main);
      list.appendChild(row);
    }
  }

  function claudeEnv(base) {
    return [
      `export ANTHROPIC_BASE_URL=${base}`,
      "export ANTHROPIC_AUTH_TOKEN=<key>",
      "export ANTHROPIC_MODEL=<model id>",
    ].join("\n");
  }

  function curlExample(base) {
    return `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer <key>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<model id>","messages":[{"role":"user","content":"你好"}]}'`;
  }

  function remoteCommand(base, id) {
    const slug = String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "friend";
    const shareId = slug.endsWith("-share") ? slug : `${slug}-share`;
    return `magpie provider add remote-magpie <key> url=${base} id=${shareId}`;
  }

  function renderLinks() {
    const invite = selectedId ? findInvite(selectedId) : null;
    const links = state?.links;
    // The three addresses are the same for every friend, so they stay on
    // screen even before anyone is selected.
    if (links) {
      $("link-openai").textContent = links.openaiBase;
      $("link-anthropic").textContent = links.anthropicBase;
      $("link-remote").textContent = links.remoteMagpie;
    }
    if (!invite || !links) {
      $("links-content").hidden = true;
      $("links-body").hidden = false;
      $("links-body").textContent = links
        ? "三条地址对所有朋友通用；点朋友名字查看 key 和接入示例。"
        : "还没有可用的公网地址，先完成首次设置。";
      $("links-friend").textContent = "未选择朋友";
      return;
    }
    $("links-body").hidden = true;
    $("links-content").hidden = false;
    $("links-friend").textContent = `${invite.name}${invite.revoked ? "（已撤销）" : ""}`;
    const shown = revealed.get(invite.id)?.secret;
    $("link-secret").textContent = shown || invite.secretMasked || "****";
    $("reveal-link-secret").textContent = shown ? "隐藏" : "显示";
    $("claude-env").textContent = claudeEnv(links.base);
    $("curl-example").textContent = curlExample(links.base);
    $("remote-command").textContent = remoteCommand(links.base, invite.name || invite.id);
    $("refresh-usage").hidden = Boolean(invite.revoked);
  }

  function renderLogs() {
    $("log-list").textContent = logs.length
      ? logs.map((entry) => {
        const parts = [entry.at || "", entry.kind || "", entry.message || ""].filter(Boolean);
        const extra = Object.entries(entry)
          .filter(([key]) => !["at", "kind", "message"].includes(key))
          .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
          .join(" ");
        return `${parts.join(" ")}${extra ? `\n  ${extra}` : ""}`;
      }).join("\n")
      : "没有日志。";
  }

  function renderDiagnose() {
    const list = $("diagnose-list");
    list.replaceChildren();
    if (!diagnose) {
      list.appendChild(el("p", "muted", "点“诊断”运行全部检查。"));
      return;
    }
    for (const [label, group] of [["本机", diagnose.preflight], ["公网", diagnose.public]]) {
      list.appendChild(el("h3", null, label));
      const checks = group?.checks || [];
      if (!checks.length) {
        list.appendChild(el("p", "muted small", "没有结果。"));
        continue;
      }
      for (const check of checks) {
        const row = el("div", "check");
        const tick = el("span", `tick ${check.ok ? "ok" : check.fatal ? "bad" : "warn"}`, check.ok ? "✓" : "✗");
        row.appendChild(tick);
        const body = el("div");
        body.appendChild(el("strong", null, check.id));
        const status = check.status ? ` · ${check.status}` : "";
        body.appendChild(el("span", "muted small", ` ${check.detail || ""}${status}`));
        row.appendChild(body);
        list.appendChild(row);
      }
    }
  }

  function renderAll() {
    renderStatus();
    renderSetup();
    renderFriends();
    renderLinks();
  }

  async function refreshState(quiet = false) {
    const { status, data } = await api("/api/state");
    if (status !== 200) {
      if (!quiet) showToast(data.error || "读取状态失败", true);
      return;
    }
    state = data;
    if (selectedId && !findInvite(selectedId)) selectedId = "";
    renderAll();
  }

  async function refreshUsage() {
    const { status, data } = await api("/api/usage");
    if (status !== 200) {
      showToast(data.error || "读取用量失败", true);
      return;
    }
    usage = new Map((data.entries || []).map((entry) => [entry.id, entry]));
    renderFriends();
  }

  async function refreshLogs() {
    const { status, data } = await api("/api/logs?n=200");
    if (status !== 200) return;
    logs = data.entries || [];
    renderLogs();
  }

  async function runDiagnose() {
    const { status, data } = await api("/api/diagnose");
    if (status !== 200) {
      showToast(data.error || "诊断失败", true);
      return;
    }
    diagnose = data;
    renderDiagnose();
  }

  async function startRelay() {
    if (pending) return;
    pending = true;
    $("setup-error").hidden = true;
    try {
      const { status, data } = await api("/api/relay/start", { method: "POST" });
      if (status !== 200) {
        const failing = (data.checks || []).find((check) => check.fatal && !check.ok);
        $("setup-error").textContent = data.detail || failing?.detail || data.error || "启动失败";
        $("setup-error").hidden = false;
        showToast("启动失败", true);
      } else {
        showToast("已开始连接");
      }
      await refreshState();
    } finally {
      pending = false;
    }
  }

  async function stopRelay(button) {
    if (!confirmClick(button, "确认停止？")) return;
    if (pending) return;
    pending = true;
    try {
      const { status, data } = await api("/api/relay/stop", { method: "POST", body: { confirm: true } });
      if (status !== 200) showToast(data.error || "停止失败", true);
      else showToast("已停止");
      await refreshState();
    } finally {
      pending = false;
    }
  }

  async function applyNginx(button) {
    if (!confirmClick(button, "确认应用？")) return;
    if (pending) return;
    pending = true;
    try {
      const { status, data } = await api("/api/nginx/apply", { method: "POST", body: { confirm: true } });
      if (status === 200) {
        showToast("nginx 已更新");
      } else {
        showToast(data.message || data.detail || data.error || "应用失败", true);
        $("nginx-note").textContent = data.detail || data.message || data.error || "应用失败";
      }
      await refreshState();
    } finally {
      pending = false;
    }
  }

  async function previewNginx() {
    const { status, data } = await api("/api/nginx/preview", { method: "POST" });
    const box = $("nginx-preview");
    if (status !== 200) {
      showToast(data.error || "预览失败", true);
      return;
    }
    box.textContent = data.script || data.snippet || "";
    box.hidden = false;
  }

  async function createFriend() {
    if (pending) return;
    const name = $("friend-name").value.trim();
    if (!name) {
      showToast("请先填写朋友的名字", true);
      $("friend-name").focus();
      return;
    }
    const rawCost = $("friend-cost").value.trim();
    const period = $("friend-period").value;
    const body = { name, limit: { period } };
    if (rawCost !== "") {
      const cost = Number(rawCost);
      if (Number.isFinite(cost) && cost >= 0) body.limit.costUsd = cost;
    }

    pending = true;
    try {
      const { status, data } = await api("/api/invites", { method: "POST", body });
      if (status !== 200) {
        showToast(data.detail || data.error || "创建失败", true);
        return;
      }
      $("new-friend-form").hidden = true;
      $("friend-name").value = "";
      if (data.warning) showToast(data.warning, true);
      else showToast("朋友已创建");
      selectedId = data.invite?.id || selectedId;
      await refreshState();
      await refreshUsage();
    } finally {
      pending = false;
    }
  }

  async function copyFriendLinks(invite) {
    const secret = await revealSecret(invite.id);
    if (!secret) return;
    const links = state?.links;
    if (!links) return;
    await copyText([
      `API: ${links.openaiBase}`,
      `Anthropic: ${links.anthropicBase}`,
      `Remote magpie: ${links.remoteMagpie}`,
      `Key: ${secret}`,
    ].join("\n"));
  }

  async function handleFriendAction(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const invite = findInvite(button.dataset.id);
    if (!invite) return;
    const action = button.dataset.action;

    if (action === "select") {
      selectedId = invite.id;
      renderLinks();
      return;
    }

    if (action === "reveal") {
      if (revealed.has(invite.id)) {
        clearRevealed(invite.id);
        renderFriends();
        renderLinks();
        return;
      }
      const secret = await revealSecret(invite.id);
      if (secret) {
        setRevealed(invite.id, secret);
        renderFriends();
        renderLinks();
      }
      return;
    }

    if (action === "copy-key") {
      const secret = await revealSecret(invite.id);
      if (secret) await copyText(secret);
      return;
    }

    if (action === "copy-links") {
      await copyFriendLinks(invite);
      return;
    }

    if (action === "rotate") {
      if (!confirmClick(button, "确认轮换？")) return;
      const { status, data } = await api(`/api/invites/${encodeURIComponent(invite.id)}/rotate`, { method: "POST" });
      if (status !== 200) showToast(data.error || "轮换失败", true);
      else showToast("已轮换；请把新 key 发给朋友");
      clearRevealed(invite.id);
      await refreshState();
      return;
    }

    if (action === "revoke") {
      if (!confirmClick(button, "确认撤销？")) return;
      const { status, data } = await api(`/api/invites/${encodeURIComponent(invite.id)}/revoke`, {
        method: "POST",
        body: { confirm: true },
      });
      if (status !== 200) showToast(data.error || "撤销失败", true);
      else showToast("已撤销");
      clearRevealed(invite.id);
      await refreshState();
    }
  }

  function wire() {
    $("stop-relay").addEventListener("click", (event) => stopRelay(event.currentTarget));
    $("diagnose-btn").addEventListener("click", runDiagnose);
    $("diagnose-run").addEventListener("click", runDiagnose);
    $("start-relay").addEventListener("click", startRelay);
    $("preview-nginx").addEventListener("click", previewNginx);
    $("apply-nginx").addEventListener("click", (event) => applyNginx(event.currentTarget));
    $("copy-authorize").addEventListener("click", () => {
      if (state?.authorizeCommand) copyText(state.authorizeCommand);
      else showToast("还没有公钥", true);
    });
    $("new-friend").addEventListener("click", () => {
      $("new-friend-form").hidden = !$("new-friend-form").hidden;
      if (!$("new-friend-form").hidden) $("friend-name").focus();
    });
    $("cancel-friend").addEventListener("click", () => { $("new-friend-form").hidden = true; });
    // The plugin page runs in a sandbox without allow-forms, so a native
    // form submit never fires. Create on an explicit click or Enter instead.
    $("create-friend").addEventListener("click", createFriend);
    for (const id of ["friend-name", "friend-cost", "friend-period"]) {
      $(id).addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        createFriend();
      });
    }
    $("friends-list").addEventListener("click", handleFriendAction);
    $("refresh-usage").addEventListener("click", refreshUsage);
    $("copy-logs").addEventListener("click", () => copyText($("log-list").textContent || ""));

    $("reveal-link-secret").addEventListener("click", async () => {
      const invite = findInvite(selectedId);
      if (!invite) return;
      if (revealed.has(invite.id)) {
        clearRevealed(invite.id);
        renderLinks();
        return;
      }
      const secret = await revealSecret(invite.id);
      if (secret) {
        setRevealed(invite.id, secret);
        renderLinks();
        renderFriends();
      }
    });
    $("copy-link-secret").addEventListener("click", async () => {
      const invite = findInvite(selectedId);
      if (!invite) return;
      const secret = await revealSecret(invite.id);
      if (secret) await copyText(secret);
    });
    $("copy-links").addEventListener("click", async () => {
      const invite = findInvite(selectedId);
      if (invite) await copyFriendLinks(invite);
    });

    document.addEventListener("click", (event) => {
      const target = event.target.closest("button[data-copy]");
      if (!target) return;
      const source = $(target.dataset.copy);
      if (source) copyText(source.textContent || "");
    });
  }

  applyTheme();
  wire();
  refreshState();
  refreshUsage();
  refreshLogs();
  setInterval(() => refreshState(true), STATE_INTERVAL);
})();
