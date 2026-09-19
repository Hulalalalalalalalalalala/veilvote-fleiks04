import "./style.css";
import type { AuditEvent, PollDetail, PollResults, PollStatus, PollSummary, VoteReceipt } from "../src/types.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/" aria-label="VeilVote 首页"><span class="mark">V</span>VeilVote</a><span class="header-note">社区议事 / 匿名投票</span></header><main><section class="intro"><p class="eyebrow">COMMUNITY COMMONS</p><h1>让每个声音，<br>都从知情开始。</h1><p>浏览社区正在讨论的议题，以 Semaphore 零知识证明匿名投出你的一票。</p><div class="intro-footer"><span class="status-dot"></span><span id="poll-count">正在读取…</span><span class="intro-divider">/</span><button type="button" id="admin-toggle" class="link-button">管理登录</button><span class="intro-divider">/</span><button type="button" id="audit-toggle" class="link-button" hidden>审计记录</button><button type="button" id="create-toggle" class="link-button" hidden>创建议题</button></div></section><section id="admin-bar" class="admin-bar" hidden></section><section class="workspace" aria-label="议题浏览器"><aside><p class="section-caption">当前议题</p><div id="poll-list" aria-live="polite">加载中…</div></aside><article id="poll-detail" aria-live="polite"><div class="empty">选择议题查看内容</div></article></section></main><footer><span>VeilVote</span><span>公开信息 · 独立判断 · 社区共识</span></footer>`;
const list = document.querySelector<HTMLDivElement>("#poll-list")!;
const detail = document.querySelector<HTMLElement>("#poll-detail")!;
const adminBar = document.querySelector<HTMLElement>("#admin-bar")!;
const adminToggle = document.querySelector<HTMLButtonElement>("#admin-toggle")!;
const auditToggle = document.querySelector<HTMLButtonElement>("#audit-toggle")!;
const createToggle = document.querySelector<HTMLButtonElement>("#create-toggle")!;

// The admin token lives in page memory only: never persisted to storage,
// never written into the DOM, and only sent on admin API requests.
let adminToken: string | null = null;
let selected = "";

const LEGAL_TRANSITIONS: Record<PollStatus, PollStatus[]> = {
  draft: ["open"],
  open: ["closed"],
  closed: ["archived"],
  archived: []
};
const STATUS_LABEL: Record<PollStatus, string> = { draft: "草案", open: "投票中", closed: "已截止", archived: "已归档" };

function text(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function date(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value));
}
async function request<T>(path: string, init?: RequestInit, admin = false): Promise<T> {
  const headers = new Headers(init?.headers);
  if (admin && adminToken) headers.set("X-Admin-Token", adminToken);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw Object.assign(new Error(`请求失败（${response.status}）`), { status: response.status, body: await response.json().catch(() => undefined) });
  return response.json() as Promise<T>;
}

const ERROR_TEXT: Record<string, string> = {
  poll_closed: "议题已截止，无法投票",
  duplicate_nullifier: "该身份已在此议题投过票（重复提交被拒绝）",
  invalid_proof: "证明无效，投票被拒绝",
  proof_binding_mismatch: "证明与议题或选项不匹配，投票被拒绝",
  group_version_changed: "成员名单已变更，请基于最新版本重新生成证明",
  group_frozen: "议题已有选票，成员名单已冻结",
  poll_not_editable: "当前状态不可变更成员（仅草案或未投票的投票中议题可变更）",
  invalid_status_transition: "该状态转换不合法（仅允许 草案→投票中→已截止→已归档）",
  status_conflict: "议题状态已变化，请刷新后重试（状态冲突）",
  admin_unauthorized: "管理令牌缺失或错误，或服务未配置 ADMIN_TOKEN",
  poll_exists: "已存在相同 id 的议题",
  unknown_merkle_root: "证明对应的成员版本不存在",
  unknown_option: "选项无效",
  invalid_vote: "提交内容格式不正确",
  invalid_poll: "议题字段不合法，请检查标红字段",
  poll_not_found: "议题不存在"
};
function errorText(error: unknown): string {
  const code = (error as { body?: { error?: string } })?.body?.error;
  return (code && ERROR_TEXT[code]) || (error instanceof Error ? error.message : "操作失败，请重试");
}

function resultsBlock(result: PollResults, poll: PollDetail): HTMLElement {
  const wrapper = text("div", "", "results");
  wrapper.append(text("h3", `当前结果 · 共 ${result.total} 票`));
  const labels = new Map(poll.options.map(option => [option.id, option.label]));
  const listElement = document.createElement("ul");
  for (const option of result.options) {
    const item = document.createElement("li");
    item.append(text("span", labels.get(option.id) ?? option.id), text("strong", `${option.count} 票`));
    listElement.append(item);
  }
  wrapper.append(listElement);
  return wrapper;
}

function resultsSection(poll: PollDetail): HTMLElement {
  const section = text("section", "", "vote");
  const note = poll.status === "closed" ? "议题已截止；结果继续公开。" : "议题已归档；结果继续公开。";
  section.append(text("h3", "计票结果"), text("p", note, "muted vote-note"));
  const mount = text("div", "", "results-mount");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "vote-refresh";
  refresh.textContent = "刷新结果";
  refresh.addEventListener("click", () => void loadResults());
  section.append(mount, refresh);
  async function loadResults() {
    try {
      const { result } = await request<{ result: PollResults }>(`/api/polls/${encodeURIComponent(poll.id)}/results`);
      mount.replaceChildren(resultsBlock(result, poll));
    } catch (error) { mount.replaceChildren(text("p", errorText(error), "error")); }
  }
  void loadResults();
  return section;
}

function voteSection(poll: PollDetail, reload: () => void): HTMLElement {
  const section = text("section", "", "vote");
  section.append(text("h3", "匿名投票"));
  section.append(text("p", "身份秘密仅在本页内存中用于生成 Semaphore 零知识证明，不会上传、保存或离开浏览器。演示身份 veilvote-demo-member-01 至 veilvote-demo-member-08 仅供合成演示数据，不可用于真实用户。", "muted vote-note"));

  const identityLabel = text("label", "身份秘密", "vote-label");
  const identityInput = document.createElement("input");
  identityInput.type = "password";
  identityInput.autocomplete = "off";
  identityInput.placeholder = "演示：veilvote-demo-member-01";
  identityLabel.append(identityInput);

  const optionFieldset = document.createElement("fieldset");
  optionFieldset.className = "vote-options";
  optionFieldset.append(text("legend", "选择方案"));
  poll.options.forEach((option, index) => {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "vote-option";
    radio.value = option.id;
    if (index === 0) radio.checked = true;
    label.append(radio, text("span", option.label));
    optionFieldset.append(label);
  });

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "vote-submit";
  submit.textContent = "生成证明并提交选票";
  const status = text("p", "", "vote-status");
  status.setAttribute("aria-live", "polite");
  const receiptBox = text("div", "", "receipt");
  const resultsMount = text("div", "", "results-mount");

  async function refreshResults() {
    try {
      const { result } = await request<{ result: PollResults }>(`/api/polls/${encodeURIComponent(poll.id)}/results`);
      resultsMount.replaceChildren(resultsBlock(result, poll));
    } catch (error) { resultsMount.replaceChildren(text("p", errorText(error), "error")); }
  }

  let busy = false;
  submit.addEventListener("click", async () => {
    if (busy) return;
    const secret = identityInput.value.trim();
    const optionId = optionFieldset.querySelector<HTMLInputElement>("input:checked")?.value;
    if (!secret) { status.textContent = "请输入身份秘密。"; status.className = "vote-status error"; return; }
    if (!optionId) { status.textContent = "请选择一个方案。"; status.className = "vote-status error"; return; }
    busy = true;
    submit.disabled = true;
    receiptBox.replaceChildren();
    try {
      status.textContent = "正在生成身份与分组…";
      status.className = "vote-status";
      const [{ Identity }, { Group }, { generateProof }] = await Promise.all([
        import("@semaphore-protocol/identity"),
        import("@semaphore-protocol/group"),
        import("@semaphore-protocol/proof")
      ]);
      const identity = new Identity(secret);
      if (!poll.eligibleMemberCommitments.includes(identity.commitment.toString())) {
        throw new Error("该身份不在本议题的成员承诺中，请检查输入。");
      }
      const group = new Group(poll.eligibleMemberCommitments);
      status.textContent = "正在生成零知识证明（首次需下载证明参数）…";
      const proof = await generateProof(identity, group, optionId, poll.id);
      status.textContent = "正在提交选票…";
      const { receipt } = await request<{ receipt: VoteReceipt }>(`/api/polls/${encodeURIComponent(poll.id)}/votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId, groupVersion: poll.groupVersion, proof })
      });
      identityInput.value = "";
      status.textContent = "投票已被接受，回执如下（可凭回执编号随时查询）。";
      status.className = "vote-status ok";
      const receiptList = document.createElement("dl");
      for (const [label, value] of [["回执编号", receipt.id], ["议题", receipt.pollId], ["选项", receipt.optionId], ["Nullifier", receipt.nullifier], ["接受时间", receipt.acceptedAt]]) {
        receiptList.append(text("dt", label), text("dd", value));
      }
      receiptBox.replaceChildren(receiptList);
      await refreshResults();
      // The first vote freezes the member list; reload so admin controls update.
      reload();
    } catch (error) {
      const code = (error as { body?: { error?: string } })?.body?.error;
      status.textContent = `${errorText(error)} 可修正后重试。`;
      status.className = "vote-status error";
      // The membership snapshot moved on (or the poll just closed): reload.
      if (code === "group_version_changed" || code === "poll_closed") setTimeout(reload, 1500);
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "vote-refresh";
  refresh.textContent = "刷新结果";
  refresh.addEventListener("click", () => void refreshResults());

  section.append(identityLabel, optionFieldset, submit, status, receiptBox, resultsMount, refresh);
  void refreshResults();
  return section;
}

/** Admin-only member management: join / rotate / revoke against the current version. */
function memberAdminSection(poll: PollDetail, reload: () => void): HTMLElement {
  const section = document.createElement("details");
  section.className = "member-admin";
  section.append(text("summary", `成员管理（管理员）· 当前版本 v${poll.groupVersion}`));
  const note = poll.status === "draft"
    ? "草案阶段可自由调整成员；开放投票后，首张选票会冻结名单。"
    : "议题尚未收到选票，仍可变更成员；首张选票提交后名单立即冻结。";
  section.append(text("p", note, "muted"));
  const statusLine = text("p", "", "vote-status");

  function commitmentInput(placeholder: string): HTMLInputElement {
    const input = document.createElement("input");
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.className = "member-input";
    return input;
  }
  function row(buttonLabel: string, inputs: HTMLInputElement[], build: () => Record<string, unknown>) {
    const wrapper = document.createElement("div");
    wrapper.className = "member-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vote-refresh";
    button.textContent = buttonLabel;
    button.addEventListener("click", async () => {
      statusLine.className = "vote-status";
      statusLine.textContent = "提交中…";
      try {
        const { group } = await request<{ group: { version: number } }>(`/api/polls/${encodeURIComponent(poll.id)}/group`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...build(), expectedVersion: poll.groupVersion })
        }, true);
        statusLine.className = "vote-status ok";
        statusLine.textContent = `已生成新版本 v${group.version}。`;
        reload();
      } catch (error) {
        statusLine.className = "vote-status error";
        statusLine.textContent = errorText(error);
      }
    });
    wrapper.append(...inputs, button);
    return wrapper;
  }
  const joinInput = commitmentInput("新成员承诺");
  const rotateOld = commitmentInput("旧承诺");
  const rotateNew = commitmentInput("新承诺");
  const revokeInput = commitmentInput("待移除承诺");
  section.append(
    row("加入成员", [joinInput], () => ({ operation: "join", commitment: joinInput.value.trim() })),
    row("轮换身份", [rotateOld, rotateNew], () => ({ operation: "rotate", oldCommitment: rotateOld.value.trim(), newCommitment: rotateNew.value.trim() })),
    row("移除成员", [revokeInput], () => ({ operation: "revoke", commitment: revokeInput.value.trim() })),
    statusLine
  );
  return section;
}

/** Admin lifecycle buttons for the transitions legal from the current status. */
function lifecycleSection(poll: PollDetail, reload: () => void): HTMLElement {
  const section = text("div", "", "lifecycle");
  const statusLine = text("p", "", "vote-status");
  for (const target of LEGAL_TRANSITIONS[poll.status]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = target === "open" ? "vote-submit" : "vote-refresh";
    button.textContent = target === "open" ? "开放投票（draft → open）" : `转换为「${STATUS_LABEL[target]}」`;
    button.addEventListener("click", async () => {
      try {
        await request(`/api/polls/${encodeURIComponent(poll.id)}/status`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: target, expectedStatus: poll.status })
        }, true);
        reload();
      } catch (error) {
        statusLine.className = "vote-status error";
        statusLine.textContent = errorText(error);
      }
    });
    section.append(button);
  }
  section.append(statusLine);
  return section;
}

function statusBadge(status: PollStatus): HTMLElement {
  return text("span", STATUS_LABEL[status], `tag status-${status}`);
}

function showPoll(id: string) {
  selected = id;
  list.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.classList.toggle("selected", button.dataset.id === id); button.setAttribute("aria-pressed", String(button.dataset.id === id)); });
  detail.replaceChildren(text("p", "正在读取议题…", "empty"));
  void renderPoll(id);
}
async function renderPoll(id: string) {
  try {
    // Admin reads can see drafts; public reads 404 for them.
    const { poll } = await request<{ poll: PollDetail }>(`/api/polls/${encodeURIComponent(id)}`, undefined, adminToken !== null);
    if (selected !== id) return;
    const heading = text("div", "", "detail-heading");
    heading.append(statusBadge(poll.status), text("span", `发布于 ${date(poll.publishedAt)} · 截止 ${dateTime(poll.closesAt)}`, "muted"));
    const stats = text("div", "", "stats");
    for (const [label, value] of [["参与成员", `${poll.memberCount} 位`], ["可选方案", `${poll.optionCount} 项`], ["成员版本", `v${poll.groupVersion}`], ["当前状态", STATUS_LABEL[poll.status]]]) {
      const item = text("div", ""); item.append(text("span", label, "muted"), text("strong", value)); stats.append(item);
    }
    const options = document.createElement("ol"); options.className = "options";
    poll.options.forEach((option, index) => { const item = document.createElement("li"); item.append(text("span", String(index + 1).padStart(2, "0"), "option-number"), text("span", option.label)); options.append(item); });
    const commitments = document.createElement("details"); commitments.className = "commitments";
    commitments.append(text("summary", `成员公开承诺 · ${poll.eligibleMemberCommitments.length} 项 · 版本 v${poll.groupVersion}`));
    commitments.append(text("p", "承诺用于标识已登记的成员资格，不包含姓名或身份秘密。此处展示演示成员数据。", "muted"));
    const rootLine = text("p", "", "muted");
    rootLine.append(text("span", "当前快照 Merkle 根："), text("code", poll.merkleRoot));
    commitments.append(rootLine);
    poll.eligibleMemberCommitments.forEach(commitment => commitments.append(text("code", commitment)));

    const children: HTMLElement[] = [heading, text("h2", poll.title), text("p", poll.description, "description"), text("p", `议题组织方 / ${poll.organizer}`, "organizer"), stats, text("h3", "议题方案"), options, commitments];
    if (adminToken) children.push(lifecycleSection(poll, () => void renderPoll(id)));
    if (poll.status === "open") {
      children.push(voteSection(poll, () => void renderPoll(id)));
      if (adminToken) children.push(memberAdminSectionPlaceholder(poll, id));
    } else if (poll.status === "closed" || poll.status === "archived") {
      children.push(resultsSection(poll));
    } else if (poll.status === "draft") {
      children.push(text("p", "草案不公开发布：普通列表、详情与结果均不可见，也不能投票。开放投票后进入公共目录。", "muted draft-note"));
      if (adminToken) children.push(memberAdminSection(poll, () => void renderPoll(id)));
    }
    detail.replaceChildren(...children);
  } catch (error) {
    if (selected === id) detail.replaceChildren(text("p", error instanceof Error ? error.message : "暂时无法读取议题", "error"));
  }
}
/** Member ops on an open poll are only legal before the first vote; hide after. */
function memberAdminSectionPlaceholder(poll: PollDetail, id: string): HTMLElement {
  const mount = document.createElement("div");
  void (async () => {
    try {
      const { result } = await request<{ result: PollResults }>(`/api/polls/${encodeURIComponent(id)}/results`);
      if (result.total === 0) mount.replaceChildren(memberAdminSection(poll, () => void renderPoll(id)));
      else mount.replaceChildren(text("p", "已有选票，成员名单已冻结。", "muted"));
    } catch { mount.replaceChildren(); }
  })();
  return mount;
}

async function loadList() {
  document.querySelector("#poll-count")!.textContent = "正在读取…";
  list.replaceChildren(text("p", "加载中…", "muted"));
  try {
    let polls: PollSummary[];
    if (adminToken) {
      const data = await request<{ polls: PollSummary[] }>("/api/admin/polls", undefined, true);
      polls = data.polls;
    } else {
      polls = (await request<{ polls: PollSummary[] }>("/api/polls")).polls;
    }
    document.querySelector("#poll-count")!.textContent = adminToken ? `管理员视图 · ${polls.length} 个议题（含草案）` : `${polls.length} 个公开议题`;
    list.replaceChildren();
    polls.forEach(poll => {
      const button = document.createElement("button"); button.type = "button"; button.dataset.id = poll.id; button.className = "poll-card";
      button.append(
        text("span", poll.organizer, "card-organizer"),
        text("strong", poll.title),
        text("span", poll.summary, "card-summary"),
        text("span", "", "card-tags")
      );
      button.querySelector(".card-tags")!.append(statusBadge(poll.status), text("span", ` · ${poll.memberCount} 位成员 · ${poll.optionCount} 个方案`, "card-meta"));
      button.addEventListener("click", () => showPoll(poll.id));
      list.append(button);
    });
    if (selected && polls.some(poll => poll.id === selected)) void renderPoll(selected);
    else if (polls[0]) { selected = polls[0].id; void showPoll(polls[0].id); } else list.append(text("p", "暂无议题"));
  } catch (error) {
    adminToken = null;
    syncAdminUi();
    list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error"));
  }
}

function syncAdminUi() {
  const on = adminToken !== null;
  auditToggle.hidden = !on;
  createToggle.hidden = !on;
  adminToggle.textContent = on ? "退出管理" : "管理登录";
  adminBar.hidden = !on;
  if (on) adminBar.replaceChildren(text("span", "管理员模式：令牌仅保存在本页内存中，不会持久化。", "muted"));
}

adminToggle.addEventListener("click", () => {
  if (adminToken) {
    adminToken = null;
    syncAdminUi();
    void loadList();
    return;
  }
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "输入 ADMIN_TOKEN";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "vote-refresh";
  confirm.textContent = "登录";
  adminBar.hidden = false;
  adminBar.replaceChildren(text("span", "管理令牌：", "muted"), input, confirm, text("span", "", "admin-error error"));
  input.focus();
  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    adminToken = value;
    // Validate before trusting it: the admin list requires the token.
    try {
      await request("/api/admin/polls", undefined, true);
      syncAdminUi();
      await loadList();
    } catch (error) {
      adminToken = null;
      adminBar.querySelector(".admin-error")!.textContent = errorText(error);
    }
  };
  confirm.addEventListener("click", () => void submit());
  input.addEventListener("keydown", event => { if (event.key === "Enter") void submit(); });
});

auditToggle.addEventListener("click", () => {
  selected = "";
  list.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.classList.remove("selected"));
  detail.replaceChildren(text("p", "正在读取审计记录…", "empty"));
  void (async () => {
    try {
      const { events } = await request<{ events: AuditEvent[] }>("/api/admin/audit?limit=200", undefined, true);
      const wrapper = text("div", "", "audit");
      wrapper.append(text("h2", "审计记录"), text("p", "仅记录动作、议题、结果、时间与非敏感详情；不记录令牌、身份秘密、nullifier 或证明。按时间倒序。", "muted description"));
      const table = document.createElement("table");
      table.className = "audit-table";
      table.append(...["时间", "动作", "结果", "议题", "详情"].map(label => {
        const th = document.createElement("th"); th.textContent = label; return th;
      }));
      const ACTION_LABEL: Record<string, string> = {
        poll_created: "创建议题", status_changed: "状态转换", members_changed: "成员变更", vote_accepted: "接受投票", vote_rejected: "拒绝投票"
      };
      for (const event of events) {
        const tr = document.createElement("tr");
        const detailCell = text("code", JSON.stringify(event.detail), "audit-detail");
        tr.append(
          text("td", dateTime(event.at)),
          text("td", ACTION_LABEL[event.action] ?? event.action),
          text("td", event.result === "success" ? "成功" : "失败", event.result === "success" ? "audit-ok" : "audit-fail"),
          text("td", event.pollId ?? "—"),
          (() => { const td = document.createElement("td"); td.append(detailCell); return td; })()
        );
        table.append(tr);
      }
      wrapper.append(table);
      if (events.length === 0) wrapper.append(text("p", "暂无审计事件。", "muted"));
      detail.replaceChildren(wrapper);
    } catch (error) {
      detail.replaceChildren(text("p", errorText(error), "error"));
    }
  })();
});

createToggle.addEventListener("click", () => {
  selected = "";
  detail.replaceChildren(buildCreateForm());
});

function buildCreateForm(): HTMLElement {
  const wrapper = text("div", "", "create-form");
  wrapper.append(text("h2", "创建草案议题"), text("p", "创建后议题为 draft：不进公共列表，普通详情与结果返回 404。需要至少两个 id 唯一的选项，以及非空且无重复的成员承诺。", "muted description"));
  const field = (label: string, input: HTMLElement, key: string) => {
    const labelElement = text("label", label, "create-label");
    labelElement.append(input);
    input.dataset.field = key;
    return labelElement;
  };
  const idInput = document.createElement("input"); idInput.placeholder = "议题 id（唯一 slug，如 autumn-book-fair）";
  const titleInput = document.createElement("input");
  const summaryInput = document.createElement("input");
  const organizerInput = document.createElement("input");
  const descriptionInput = document.createElement("textarea"); descriptionInput.rows = 3;
  const publishedInput = document.createElement("input"); publishedInput.type = "datetime-local";
  publishedInput.value = new Date(Date.now() - Date.now() % 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const closesInput = document.createElement("input"); closesInput.type = "datetime-local";
  closesInput.value = new Date(Date.now() + 7 * 864e5 - (7 * 864e5) % 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const optionsWrap = text("div", "", "create-options");
  const addOptionRow = (optionId = "", optionLabel = "") => {
    const rowElement = document.createElement("div");
    rowElement.className = "option-row";
    const oId = document.createElement("input"); oId.placeholder = "选项 id"; oId.value = optionId; oId.dataset.field = "options";
    const oLabel = document.createElement("input"); oLabel.placeholder = "选项文案"; oLabel.value = optionLabel; oLabel.dataset.field = "options";
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "vote-refresh"; remove.textContent = "移除";
    remove.addEventListener("click", () => { rowElement.remove(); });
    rowElement.append(oId, oLabel, remove);
    optionsWrap.append(rowElement);
  };
  addOptionRow("", ""); addOptionRow("", "");
  const addOption = document.createElement("button");
  addOption.type = "button"; addOption.className = "vote-refresh"; addOption.textContent = "+ 添加选项";
  addOption.addEventListener("click", () => addOptionRow());

  const commitmentsInput = document.createElement("textarea");
  commitmentsInput.rows = 6;
  commitmentsInput.placeholder = "成员承诺，每行一个（非空、不可重复）";
  void (async () => {
    try {
      const { polls } = await request<{ polls: PollSummary[] }>("/api/polls");
      if (polls[0]) {
        const { poll } = await request<{ poll: PollDetail }>(`/api/polls/${encodeURIComponent(polls[0].id)}`);
        commitmentsInput.value = poll.eligibleMemberCommitments.join("\n");
      }
    } catch { /* leave empty */ }
  })();

  const statusLine = text("p", "", "vote-status");
  const submit = document.createElement("button");
  submit.type = "button"; submit.className = "vote-submit"; submit.textContent = "创建草案";
  submit.addEventListener("click", async () => {
    wrapper.querySelectorAll("[data-invalid]").forEach(element => element.removeAttribute("data-invalid"));
    const options = [...optionsWrap.querySelectorAll(".option-row")].map(rowElement => {
      const inputs = rowElement.querySelectorAll<HTMLInputElement>("input");
      return { id: inputs[0].value.trim(), label: inputs[1].value.trim() };
    });
    const payload = {
      id: idInput.value.trim(),
      title: titleInput.value.trim(),
      summary: summaryInput.value.trim(),
      description: descriptionInput.value.trim(),
      organizer: organizerInput.value.trim(),
      publishedAt: new Date(publishedInput.value).toISOString(),
      closesAt: new Date(closesInput.value).toISOString(),
      options,
      commitments: commitmentsInput.value.split("\n").map(line => line.trim()).filter(Boolean)
    };
    try {
      const { poll } = await request<{ poll: PollDetail }>("/api/polls", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      }, true);
      statusLine.className = "vote-status ok";
      statusLine.textContent = `草案「${poll.title}」已创建（201）。`;
      await loadList();
      showPoll(poll.id);
    } catch (error) {
      statusLine.className = "vote-status error";
      statusLine.textContent = errorText(error);
      const fields = ((error as { body?: { fields?: string[] } }).body?.fields) ?? [];
      for (const name of fields) {
        wrapper.querySelectorAll<HTMLElement>(`[data-field="${name}"]`).forEach(element => element.setAttribute("data-invalid", "true"));
      }
    }
  });

  wrapper.append(
    field("议题 id", idInput, "id"),
    field("标题", titleInput, "title"),
    field("摘要", summaryInput, "summary"),
    field("组织方", organizerInput, "organizer"),
    field("详细描述", descriptionInput, "description"),
    field("发布时间", publishedInput, "publishedAt"),
    field("截止时间", closesInput, "closesAt"),
    text("p", "选项（至少两个，id 唯一）", "create-label"), optionsWrap, addOption,
    field("成员承诺", commitmentsInput, "commitments"),
    submit, statusLine
  );
  return wrapper;
}

void loadList();
