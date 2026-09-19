import "./style.css";
import type { AuditEvent, PollDetail, PollResults, PollStatus, PollSummary, VoteReceipt } from "../src/types.ts";

// The management token lives only in page memory: never written to
// localStorage/sessionStorage, never printed into the page or audit trail.
let adminToken = "";

const STATUS_LABEL: Record<PollStatus, string> = { draft: "草稿", open: "投票中", closed: "已截止", archived: "已归档" };
// The single legal successor of each status (draft→open→closed→archived).
const NEXT_STATUS: Record<PollStatus, PollStatus | null> = { draft: "open", open: "closed", closed: "archived", archived: null };
const NEXT_ACTION_LABEL: Record<PollStatus, string> = {
  draft: "开放议题 · 开始投票",
  open: "结束投票 · 截止议题",
  closed: "归档议题",
  archived: "议题已归档"
};
const ACTION_LABEL: Record<string, string> = {
  poll_create: "创建议题",
  poll_status_change: "状态转换",
  group_change: "成员变更",
  group_change_rejected: "成员变更被拒",
  status_change_rejected: "状态转换被拒"
};

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/" aria-label="VeilVote 首页"><span class="mark">V</span>VeilVote</a><div class="header-admin"><span class="header-note">社区议事 / 匿名投票</span><div class="admin-token-row"><input id="admin-token" type="password" autocomplete="off" placeholder="管理员令牌 X-Admin-Token" /><button type="button" id="admin-set" class="admin-button">设置</button><button type="button" id="admin-clear" class="admin-button ghost" hidden>清除</button><button type="button" id="admin-create" class="admin-button ghost" hidden>新建议题</button><button type="button" id="admin-audit" class="admin-button ghost" hidden>审计记录</button><span id="admin-mode" class="admin-mode" hidden>管理模式</span></div></div></header><main><section class="intro"><p class="eyebrow">COMMUNITY COMMONS</p><h1>让每个声音，<br>都从知情开始。</h1><p>浏览社区正在讨论的议题，以 Semaphore 零知识证明匿名投出你的一票。议题经历草稿、开放、截止与归档四个阶段，管理操作全程留痕。</p><div class="intro-footer"><span class="status-dot"></span>议题目录<span class="intro-divider">/</span><span id="poll-count">正在读取…</span></div></section><section class="workspace" aria-label="议题浏览器"><aside><p class="section-caption">当前议题</p><div id="poll-list" aria-live="polite">加载中…</div></aside><article id="poll-detail" aria-live="polite"><div class="empty">选择议题查看内容</div></article></section></main><footer><span>VeilVote</span><span>公开信息 · 独立判断 · 社区共识</span></footer><div id="modal-root"></div>`;
const list = document.querySelector<HTMLDivElement>("#poll-list")!;
const detail = document.querySelector<HTMLElement>("#poll-detail")!;
const tokenInput = document.querySelector<HTMLInputElement>("#admin-token")!;
const setButton = document.querySelector<HTMLButtonElement>("#admin-set")!;
const clearButton = document.querySelector<HTMLButtonElement>("#admin-clear")!;
const createButton = document.querySelector<HTMLButtonElement>("#admin-create")!;
const auditButton = document.querySelector<HTMLButtonElement>("#admin-audit")!;
const adminMode = document.querySelector<HTMLSpanElement>("#admin-mode")!;
const modalRoot = document.querySelector<HTMLDivElement>("#modal-root")!;

function text(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function date(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
function dateTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(value)); }
function isAdmin(): boolean { return adminToken.length > 0; }

async function request<T>(path: string, init: RequestInit & { admin?: boolean } = {}): Promise<T> {
  const { admin = true, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers);
  // Attach the in-memory token to every request while management mode is on;
  // public endpoints (receipt verification) are called without it.
  if (admin && isAdmin()) headers.set("X-Admin-Token", adminToken);
  const response = await fetch(path, { ...fetchInit, headers });
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw Object.assign(new Error(`请求失败（${response.status}）`), { status: response.status, body });
  return body as T;
}

/**
 * A fetch failure (offline, DNS, connection refused) rather than an HTTP
 * error response. Duck-typed rather than `instanceof TypeError` so errors from
 * another realm (embedded views, test runtimes) are still recognized.
 */
function isNetworkFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || "status" in error) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TypeError" || name === undefined;
}

const ERROR_TEXT: Record<string, string> = {
  admin_unauthorized: "管理令牌缺失、错误或服务端未配置（401，未执行任何写入）",
  poll_closed: "议题未开放或已截止，无法投票",
  duplicate_nullifier: "该身份已在此议题投过票（重复提交被拒绝）",
  invalid_proof: "证明无效，投票被拒绝",
  proof_binding_mismatch: "证明与议题或选项不匹配，投票被拒绝",
  group_version_changed: "成员名单已变更或乐观版本过期，请刷新后重试",
  group_frozen: "议题已有选票，成员名单已冻结",
  poll_not_editable: "当前状态下不可变更成员（仅草稿或未投票的开放议题可变更）",
  unknown_merkle_root: "证明对应的成员版本不存在",
  unknown_option: "选项无效",
  invalid_vote: "提交内容格式不正确",
  poll_not_found: "议题不存在",
  illegal_transition: "非法状态转换（仅允许 草稿→开放→截止→归档）",
  status_conflict: "状态已变化，expectedStatus 与当前状态冲突",
  invalid_status: "状态值非法",
  poll_exists: "议题 id 已存在",
  invalid_poll: "议题字段不合法（标题、摘要、描述、组织方均不可为空）",
  invalid_poll_id: "议题 id 不合法或为空",
  invalid_poll_dates: "时间不合法，截止时间必须晚于发布时间",
  invalid_options: "至少需要两个选项，且 id 非空、标签非空",
  duplicate_option_id: "选项 id 重复",
  invalid_commitments: "成员承诺必须为非空的合法字段元素",
  duplicate_commitment: "成员承诺重复",
  invalid_group_operation: "成员变更内容格式不正确"
};
function errorText(error: unknown): string {
  const code = (error as { body?: { error?: string } })?.body?.error;
  return (code && ERROR_TEXT[code]) || (error instanceof Error ? error.message : "操作失败，请重试");
}

function statusBadge(status: PollStatus): HTMLElement {
  return text("span", STATUS_LABEL[status], `status-badge status-${status}`);
}

/**
 * Canonical, copyable snapshot text. Field order matches the server's digest
 * input (pollId, groupVersion, total, options, closedAt, digest); options use
 * the poll's own order, which is the order captured in the snapshot.
 */
function snapshotSummary(result: PollResults): string {
  const snapshot = result.snapshot!;
  const lines = [
    `pollId: ${snapshot.pollId}`,
    `groupVersion: ${snapshot.groupVersion}`,
    `total: ${snapshot.total}`,
    ...snapshot.options.map(option => `options.${option.id}: ${option.count}`),
    `closedAt: ${snapshot.closedAt}`,
    `digest: ${snapshot.digest}`
  ];
  return lines.join("\n");
}

function resultsBlock(result: PollResults, poll: PollDetail): HTMLElement {
  const wrapper = text("div", "", "results");
  const snapshot = result.snapshot;
  wrapper.append(text("h3", snapshot ? `最终结果 · 共 ${snapshot.total} 票（关闭时定格）` : `当前结果 · 共 ${result.total} 票`));
  // Closed/archived: counts come from the immutable snapshot; open: the live
  // tally. Both iterate the poll's option order (equal to the snapshot order).
  const counts = snapshot ? snapshot.options : result.options;
  const labels = new Map(poll.options.map(option => [option.id, option.label]));
  const listElement = document.createElement("ul");
  for (const option of counts) {
    const item = document.createElement("li");
    item.append(text("span", labels.get(option.id) ?? option.id), text("strong", `${option.count} 票`));
    listElement.append(item);
  }
  wrapper.append(listElement);

  if (snapshot) {
    const meta = text("dl", "", "snapshot-meta");
    for (const [label, value] of [
      ["关闭时刻", dateTime(snapshot.closedAt)],
      ["UTC", snapshot.closedAt],
      ["成员版本", `v${snapshot.groupVersion}`],
      ["总票数", String(snapshot.total)]
    ] as [string, string][]) {
      meta.append(text("dt", label), text("dd", value));
    }
    wrapper.append(meta);

    const digestLine = text("p", "", "snapshot-digest");
    digestLine.append(text("span", "摘要 SHA-256："), text("code", snapshot.digest));
    wrapper.append(digestLine);

    // The canonical summary is always present as selectable text; the copy
    // button is a progressive enhancement (clipboard API may be unavailable
    // over plain HTTP or without a user gesture).
    const summary = snapshotSummary(result);
    const summaryBox = document.createElement("div");
    summaryBox.className = "snapshot-summary";
    const summaryActions = text("div", "", "snapshot-summary-actions");
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "admin-button ghost snapshot-copy";
    copyButton.textContent = "复制摘要";
    const copyStatus = text("span", "", "snapshot-copy-status muted");
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(summary);
        copyStatus.textContent = "已复制到剪贴板。";
        copyStatus.className = "snapshot-copy-status ok";
      } catch {
        copyStatus.textContent = "剪贴板不可用：请在下方文本框中手动全选复制。";
        copyStatus.className = "snapshot-copy-status error";
        summaryTextarea.hidden = false;
      }
    });
    summaryActions.append(copyButton, copyStatus);
    const summaryTextarea = document.createElement("textarea");
    summaryTextarea.className = "snapshot-summary-text";
    summaryTextarea.value = summary;
    summaryTextarea.rows = summary.split("\n").length;
    summaryTextarea.readOnly = true;
    summaryTextarea.hidden = true;
    const fallbackHint = document.createElement("button");
    fallbackHint.type = "button";
    fallbackHint.className = "admin-button ghost snapshot-show-text";
    fallbackHint.textContent = "显示可全选文本";
    fallbackHint.addEventListener("click", () => { summaryTextarea.hidden = false; summaryTextarea.focus(); summaryTextarea.select(); fallbackHint.hidden = true; });
    summaryBox.append(summaryActions, fallbackHint, summaryTextarea);
    wrapper.append(text("p", "下列摘要由关闭事务内写入的不可变快照生成，刷新、归档与服务重启后保持一致。", "muted snapshot-note"), summaryBox);
  }
  return wrapper;
}

// ---- Management: lifecycle transition --------------------------------------

function adminSection(poll: PollDetail): HTMLElement {
  const section = text("section", "", "admin-panel");
  section.append(text("h3", "议题管理"));
  const next = NEXT_STATUS[poll.status];
  const transition = document.createElement("button");
  transition.type = "button";
  transition.className = "admin-button primary";
  transition.textContent = NEXT_ACTION_LABEL[poll.status];
  transition.disabled = next === null;
  const note = text("p", "", "muted admin-note");
  note.textContent = next
    ? `合法转换：${STATUS_LABEL[poll.status]} → ${STATUS_LABEL[next]}（提交 expectedStatus=${poll.status}）`
    : "议题已归档，没有进一步的状态转换。";
  const statusLine = text("p", "", "admin-status-line");
  statusLine.setAttribute("aria-live", "polite");
  transition.addEventListener("click", async () => {
    if (!next) return;
    transition.disabled = true;
    statusLine.textContent = "正在提交状态转换…";
    statusLine.className = "admin-status-line";
    try {
      await request(`/api/polls/${encodeURIComponent(poll.id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, expectedStatus: poll.status })
      });
      statusLine.textContent = `已转换为「${STATUS_LABEL[next]}」。`;
      statusLine.className = "admin-status-line ok";
      await loadPolls();
      await showPoll(poll.id);
    } catch (error) {
      statusLine.textContent = errorText(error);
      statusLine.className = "admin-status-line error";
      transition.disabled = false;
    }
  });
  section.append(transition, note, statusLine);
  if (poll.status === "draft" || poll.status === "open") section.append(memberAdminSection(poll));
  return section;
}

function memberAdminSection(poll: PollDetail): HTMLElement {
  const box = document.createElement("details");
  box.className = "member-admin";
  box.append(text("summary", "成员名单管理（join / rotate / revoke）"));
  box.append(text("p", `当前成员版本 v${poll.groupVersion} · ${poll.eligibleMemberCommitments.length} 个承诺。草稿或尚未投票的开放议题可变更；首票投出后即冻结。`, "muted"));

  function row(operation: string, fields: [string, string][], label: string, build: (values: Record<string, string>) => Record<string, string>): HTMLElement {
    const form = document.createElement("div");
    form.className = "member-form";
    const inputs: Record<string, HTMLInputElement> = {};
    for (const [key, placeholder] of fields) {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = placeholder;
      input.dataset.field = key;
      inputs[key] = input;
      form.append(input);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-button";
    button.textContent = label;
    const line = text("p", "", "member-form-status muted");
    button.addEventListener("click", async () => {
      const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
      if (Object.values(values).some(value => !value)) { line.textContent = "请填写全部字段。"; line.className = "member-form-status error"; return; }
      button.disabled = true;
      try {
        const payload = { operation, expectedVersion: poll.groupVersion, ...build(values) };
        const { group } = await request<{ group: { version: number } }>(`/api/polls/${encodeURIComponent(poll.id)}/group`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        line.textContent = `已生成新版本 v${group.version}。`;
        line.className = "member-form-status ok";
        await loadPolls();
        await showPoll(poll.id);
      } catch (error) {
        line.textContent = errorText(error);
        line.className = "member-form-status error";
        button.disabled = false;
      }
    });
    form.append(button, line);
    return form;
  }

  box.append(
    row("join", [["commitment", "新成员承诺（十进制）"]], "追加成员", v => ({ commitment: v.commitment })),
    row("rotate", [["oldCommitment", "旧承诺"], ["newCommitment", "新承诺"]], "原位替换", v => ({ oldCommitment: v.oldCommitment, newCommitment: v.newCommitment })),
    row("revoke", [["commitment", "待移除承诺"]], "移除成员", v => ({ commitment: v.commitment }))
  );
  return box;
}

// ---- Voting ----------------------------------------------------------------

function voteSection(poll: PollDetail): HTMLElement {
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
    } catch (error) {
      const code = (error as { body?: { error?: string } })?.body?.error;
      status.textContent = `${errorText(error)} 可修正后重试。`;
      status.className = "vote-status error";
      // The membership snapshot moved on: reload the detail so the next proof
      // is generated against the current version and root.
      if (code === "group_version_changed") setTimeout(() => void showPoll(poll.id), 1500);
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

// ---- Public receipt verification -------------------------------------------

interface VerifyForm { id: string; pollId: string; optionId: string; nullifier: string }

/**
 * Receipt verification against POST /api/receipts/:id/verify. The form only
 * handles the receipt's own public fields — an identity secret is never
 * requested, and values live solely in the DOM (page memory). The request is
 * sent without the admin token even when management mode is on.
 */
function receiptVerifySection(poll: PollDetail): HTMLElement {
  const section = text("section", "", "receipt-verify");
  section.append(text("h3", "回执核验"));
  section.append(text("p", "凭投票回执上的编号与公开字段调用 POST /api/receipts/:id/verify 即可核验选票已被计入。核验不涉及也不索取身份秘密；输入仅保存在本页内存中，刷新即清空。", "muted verify-note"));

  const fieldDefs: [keyof VerifyForm, string, string][] = [
    ["id", "回执编号", "回执 UUID"],
    ["pollId", "议题 id", poll.id],
    ["optionId", "选项 id", "例如 weekday-evenings"],
    ["nullifier", "Nullifier", "证明的公开输出"]
  ];
  const inputs = {} as Record<keyof VerifyForm, HTMLInputElement>;
  const form = document.createElement("div");
  form.className = "verify-form";
  for (const [key, labelText, placeholder] of fieldDefs) {
    const label = text("label", labelText, "verify-label");
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.dataset.field = key;
    // Convenience default: the receipt being checked usually belongs to this poll.
    if (key === "pollId") input.value = poll.id;
    label.append(input);
    form.append(label);
    inputs[key] = input;
  }

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "vote-submit verify-submit";
  submit.textContent = "提交核验";
  const statusLine = text("p", "", "verify-status muted");
  statusLine.setAttribute("aria-live", "polite");
  const resultBox = text("div", "", "verify-result");

  let busy = false;
  async function verify() {
    if (busy) return;
    const values: VerifyForm = { id: inputs.id.value.trim(), pollId: inputs.pollId.value.trim(), optionId: inputs.optionId.value.trim(), nullifier: inputs.nullifier.value.trim() };
    if (!values.id || !values.pollId || !values.optionId || !values.nullifier) {
      statusLine.textContent = "提交格式有误（400）：回执编号、pollId、optionId、nullifier 均须为非空文本。";
      statusLine.className = "verify-status error";
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = "核验中…";
    for (const input of Object.values(inputs)) input.disabled = true;
    resultBox.replaceChildren();
    try {
      const data = await request<{ valid: true; receipt: VoteReceipt }>(`/api/receipts/${encodeURIComponent(values.id)}/verify`, {
        method: "POST",
        admin: false,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pollId: values.pollId, optionId: values.optionId, nullifier: values.nullifier })
      });
      statusLine.textContent = "核验成功（200）：回执存在，且 pollId、optionId、nullifier 全部一致。";
      statusLine.className = "verify-status ok";
      const receiptList = document.createElement("dl");
      for (const [label, value] of [["回执编号", data.receipt.id], ["议题", data.receipt.pollId], ["选项", data.receipt.optionId], ["Nullifier", data.receipt.nullifier], ["接受时间", data.receipt.acceptedAt]]) {
        receiptList.append(text("dt", label), text("dd", value));
      }
      resultBox.replaceChildren(receiptList);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const code = (error as { body?: { error?: string } })?.body?.error;
      let message: string;
      if (isNetworkFailure(error)) {
        message = "网络失败：无法连接核验服务，请检查网络后修改重试。";
      } else if (status === 404 || code === "receipt_not_found") {
        message = "未知回执（404）：该回执编号不存在，请核对后重试。";
      } else if (status === 422 || code === "receipt_mismatch") {
        message = "回执字段不符（422 receipt_mismatch）：回执存在，但 pollId、optionId、nullifier 中至少一项不一致，可修改后重试。";
      } else if (status === 400 || code === "invalid_verification" || code === "invalid_json") {
        message = "提交格式有误（400）：四项字段均须为文本字符串。";
      } else {
        message = `${errorText(error)} 可修改后重试。`;
      }
      statusLine.textContent = message;
      statusLine.className = "verify-status error";
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = "提交核验";
      for (const input of Object.values(inputs)) input.disabled = false;
    }
  }
  submit.addEventListener("click", () => void verify());
  for (const input of Object.values(inputs)) input.addEventListener("keydown", event => { if (event.key === "Enter") void verify(); });

  section.append(form, submit, statusLine, resultBox);
  return section;
}

let selected = "";
async function showPoll(id: string) {
  selected = id;
  list.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.classList.toggle("selected", button.dataset.id === id); button.setAttribute("aria-pressed", String(button.dataset.id === id)); });
  detail.replaceChildren(text("p", "正在读取议题…", "empty"));
  try {
    const { poll } = await request<{ poll: PollDetail }>(`/api/polls/${encodeURIComponent(id)}`);
    if (selected !== id) return;
    const heading = text("div", "", "detail-heading");
    heading.append(text("span", "公开议题", "tag"), statusBadge(poll.status), text("span", `发布于 ${date(poll.publishedAt)}`, "muted"));
    const stats = text("div", "", "stats");
    for (const [label, value] of [["参与成员", `${poll.memberCount} 位`], ["可选方案", `${poll.optionCount} 项`], ["成员版本", `v${poll.groupVersion}`], ["截止日期", date(poll.closesAt)]]) {
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

    detail.replaceChildren();
    detail.append(heading, text("h2", poll.title), text("p", poll.description, "description"), text("p", `议题组织方 / ${poll.organizer}`, "organizer"), stats, text("h3", "议题方案"), options, commitments);
    if (isAdmin()) detail.append(adminSection(poll));
    if (poll.status === "draft") {
      detail.append(text("p", "该议题仍为草稿：不对公众显示，普通详情、投票与结果均不可见。管理员可在上方完善成员名单后开放投票。", "draft-note"));
    } else if (poll.status === "open") {
      detail.append(voteSection(poll));
      detail.append(receiptVerifySection(poll));
    } else {
      const mount = text("div", "", "results-mount");
      detail.append(text("p", poll.status === "closed" ? "议题已截止，结果如下并继续公开。" : "议题已归档，结果继续公开可查。", "muted"), mount);
      try {
        const { result } = await request<{ result: PollResults }>(`/api/polls/${encodeURIComponent(poll.id)}/results`);
        mount.replaceChildren(resultsBlock(result, poll));
      } catch (error) {
        mount.replaceChildren(text("p", errorText(error), "error"));
      }
      detail.append(receiptVerifySection(poll));
    }
  } catch (error) { if (selected === id) detail.replaceChildren(text("p", error instanceof Error ? error.message : "暂时无法读取议题", "error")); }
}

async function loadPolls() {
  const { polls } = await request<{ polls: PollSummary[] }>("/api/polls");
  document.querySelector("#poll-count")!.textContent = `${polls.length} 个议题${isAdmin() ? "（含草稿）" : ""}`;
  list.replaceChildren();
  polls.forEach(poll => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.id = poll.id; button.className = "poll-card";
    const top = document.createElement("span"); top.className = "card-top";
    top.append(text("span", poll.organizer, "card-organizer"), statusBadge(poll.status));
    button.append(top, text("strong", poll.title), text("span", poll.summary, "card-summary"), text("span", `${poll.memberCount} 位成员 · ${poll.optionCount} 个方案`, "card-meta"));
    button.addEventListener("click", () => void showPoll(poll.id)); list.append(button);
  });
  return polls;
}

// ---- Modals: create draft + audit ------------------------------------------

function openModal(title: string, body: HTMLElement) {
  modalRoot.replaceChildren();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const panel = document.createElement("div");
  panel.className = "modal";
  const heading = text("div", "", "modal-heading");
  heading.append(text("h3", title));
  const close = document.createElement("button");
  close.type = "button"; close.className = "admin-button ghost"; close.textContent = "关闭";
  close.addEventListener("click", () => modalRoot.replaceChildren());
  overlay.addEventListener("click", event => { if (event.target === overlay) modalRoot.replaceChildren(); });
  heading.append(close);
  panel.append(heading, body);
  overlay.append(panel);
  modalRoot.append(overlay);
}

function toLocalInputValue(dateValue: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dateValue.getFullYear()}-${pad(dateValue.getMonth() + 1)}-${pad(dateValue.getDate())}T${pad(dateValue.getHours())}`;
}

function createDraftModal() {
  const body = document.createElement("div");
  body.className = "create-form";
  const field = (label: string, input: HTMLInputElement | HTMLTextAreaElement) => {
    const wrapper = text("label", label, "create-label");
    wrapper.append(input);
    body.append(wrapper);
    return input;
  };
  const idInput = field("议题 id（slug，唯一）", Object.assign(document.createElement("input"), { type: "text", placeholder: "例如 community-tea-house" })) as HTMLInputElement;
  const titleInput = field("标题", Object.assign(document.createElement("input"), { type: "text" })) as HTMLInputElement;
  const organizerInput = field("组织方", Object.assign(document.createElement("input"), { type: "text" })) as HTMLInputElement;
  const summaryInput = field("摘要", Object.assign(document.createElement("input"), { type: "text" })) as HTMLInputElement;
  const descriptionInput = field("详细描述", Object.assign(document.createElement("textarea"), { rows: 3 })) as HTMLTextAreaElement;
  const publishedInput = field("发布时间", Object.assign(document.createElement("input"), { type: "datetime-local" })) as HTMLInputElement;
  const closesInput = field("截止时间", Object.assign(document.createElement("input"), { type: "datetime-local" })) as HTMLInputElement;
  publishedInput.value = toLocalInputValue(new Date());
  const defaultClose = new Date(); defaultClose.setDate(defaultClose.getDate() + 14);
  closesInput.value = toLocalInputValue(defaultClose);

  body.append(text("p", "选项（至少两个，id 唯一）", "create-label"));
  const optionsMount = document.createElement("div");
  optionsMount.className = "option-rows";
  const optionRows: { id: HTMLInputElement; label: HTMLInputElement }[] = [];
  function addOptionRow(id = "", label = "") {
    const rowDiv = document.createElement("div"); rowDiv.className = "option-row";
    const idInputOption = document.createElement("input"); idInputOption.placeholder = "选项 id"; idInputOption.value = id;
    const labelInputOption = document.createElement("input"); labelInputOption.placeholder = "选项文案"; labelInputOption.value = label;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "admin-button ghost"; remove.textContent = "删";
    remove.addEventListener("click", () => { rowDiv.remove(); optionRows.splice(optionRows.findIndex(entry => entry.id === idInputOption), 1); });
    rowDiv.append(idInputOption, labelInputOption, remove);
    optionsMount.append(rowDiv);
    optionRows.push({ id: idInputOption, label: labelInputOption });
  }
  addOptionRow(); addOptionRow();
  const addOption = document.createElement("button"); addOption.type = "button"; addOption.className = "admin-button ghost"; addOption.textContent = "＋ 添加选项";
  addOption.addEventListener("click", () => addOptionRow());
  body.append(optionsMount, addOption);

  const commitmentsInput = field("初始成员承诺（每行一个，非空且不重复）", Object.assign(document.createElement("textarea"), { rows: 5, placeholder: "十进制 Semaphore 承诺，每行一个" })) as HTMLTextAreaElement;

  const submit = document.createElement("button"); submit.type = "button"; submit.className = "admin-button primary"; submit.textContent = "创建草稿议题";
  const line = text("p", "", "create-status muted");
  submit.addEventListener("click", async () => {
    const payload = {
      id: idInput.value.trim(),
      title: titleInput.value.trim(),
      summary: summaryInput.value.trim(),
      description: descriptionInput.value.trim(),
      organizer: organizerInput.value.trim(),
      publishedAt: new Date(publishedInput.value).toISOString(),
      closesAt: new Date(closesInput.value).toISOString(),
      options: optionRows.map(row => ({ id: row.id.value.trim(), label: row.label.value.trim() })),
      commitments: commitmentsInput.value.split("\n").map(value => value.trim()).filter(Boolean)
    };
    submit.disabled = true;
    try {
      const { poll } = await request<{ poll: PollDetail }>("/api/polls", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      line.textContent = `已创建草稿 ${poll.id}（201）。`;
      line.className = "create-status ok";
      modalRoot.replaceChildren();
      await loadPolls();
      await showPoll(poll.id);
    } catch (error) {
      line.textContent = errorText(error);
      line.className = "create-status error";
      submit.disabled = false;
    }
  });
  body.append(submit, line);
  openModal("创建草稿议题（POST /api/polls）", body);
}

interface AuditFilters { pollId: string; action: string; result: string; from: string; to: string; pageSize: number }

const AUDIT_ACTIONS = ["poll_create", "poll_status_change", "group_change", "group_change_rejected", "status_change_rejected"];

function auditModal() {
  const body = document.createElement("div");
  body.className = "audit-body";
  openModal("审计记录（GET /api/admin/audit，按时间倒序）", body);

  const filters: AuditFilters = { pollId: "", action: "", result: "", from: "", to: "", pageSize: 10 };
  let page = 1;
  let totalPages = 1;
  let requestSeq = 0;

  const filterBar = document.createElement("div");
  filterBar.className = "audit-filters";
  function textFilter(key: "pollId" | "from" | "to", label: string, placeholder: string): HTMLInputElement {
    const wrap = text("label", label, "audit-filter");
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.dataset.filter = key;
    wrap.append(input);
    filterBar.append(wrap);
    return input;
  }
  function selectFilter(key: "action" | "result" | "pageSize", label: string, options: [string, string][]): HTMLSelectElement {
    const wrap = text("label", label, "audit-filter");
    const select = document.createElement("select");
    for (const [value, optionLabel] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = optionLabel;
      select.append(option);
    }
    select.dataset.filter = key;
    wrap.append(select);
    filterBar.append(wrap);
    return select;
  }
  const pollIdInput = textFilter("pollId", "议题 id", "精确匹配，如 demo-tea-corner");
  const fromInput = textFilter("from", "起始 from", "2026-09-20T10:00:00Z");
  const toInput = textFilter("to", "截止 to", "带时区的严格 ISO8601");
  const actionSelect = selectFilter("action", "动作", [["", "全部动作"], ...AUDIT_ACTIONS.map(action => [action, ACTION_LABEL[action] ?? action] as [string, string])]);
  const resultSelect = selectFilter("result", "结果", [["", "全部结果"], ["success", "成功"], ["failure", "失败"]]);
  const pageSizeSelect = selectFilter("pageSize", "每页", [["10", "10 条"], ["20", "20 条"], ["50", "50 条"], ["100", "100 条"], ["200", "200 条（上限）"]]);

  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.className = "admin-button primary audit-search";
  searchButton.textContent = "查询";
  filterBar.append(searchButton);
  body.append(filterBar);

  const content = text("div", "", "audit-content");
  const pager = document.createElement("div");
  pager.className = "audit-pager";
  body.append(content, pager);

  function buildQuery(): string {
    const params = new URLSearchParams();
    page = Math.max(1, Math.floor(page));
    params.set("page", String(page));
    params.set("pageSize", String(filters.pageSize));
    for (const key of ["pollId", "action", "result", "from", "to"] as const) {
      const value = filters[key].trim();
      if (value) params.set(key, value);
    }
    return params.toString();
  }

  function pageButton(label: string, className: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `admin-button ghost ${className}`;
    button.textContent = label;
    pager.append(button);
    return button;
  }
  const firstButton = pageButton("« 首页", "audit-first");
  const prevButton = pageButton("‹ 上一页", "audit-prev");
  const pageInfo = text("span", "", "audit-page-info");
  const nextButton = pageButton("下一页 ›", "audit-next");
  const lastButton = pageButton("末页 »", "audit-last");
  pager.append(firstButton, prevButton, pageInfo, nextButton, lastButton);

  async function load() {
    const seq = ++requestSeq;
    content.replaceChildren(text("p", "正在读取审计记录…", "muted audit-loading"));
    pager.hidden = true;
    try {
      const data = await request<{ events: AuditEvent[]; total: number; page: number; pageSize: number; totalPages: number }>(`/api/admin/audit?${buildQuery()}`);
      // A newer filter/paging request supersedes a stale in-flight response.
      if (seq !== requestSeq) return;
      content.replaceChildren();
      totalPages = Math.max(1, data.totalPages);
      pageInfo.textContent = `共 ${data.total} 条 · 第 ${data.page} / ${totalPages} 页（每页 ${data.pageSize} 条）`;
      pager.hidden = false;
      firstButton.disabled = data.page <= 1;
      prevButton.disabled = data.page <= 1;
      // An out-of-range page simply renders empty: next/last stay enabled via
      // totalPages so the user can navigate back without anything crashing.
      nextButton.disabled = data.page >= totalPages;
      lastButton.disabled = data.page >= totalPages;
      if (data.events.length === 0) {
        content.append(text("p", data.total === 0 ? "暂无符合筛选条件的审计事件。" : "本页没有记录（页码可能超出范围）。", "audit-empty muted"));
        return;
      }
      content.append(text("p", "仅记录动作、议题、结果、时间与详情，不记录令牌、身份秘密、承诺内容或零知识证明。", "muted"));
      const table = document.createElement("table");
      table.className = "audit-table";
      table.append(htmlRow("thead", ["时间", "动作", "议题", "结果", "详情"]));
      const tbody = document.createElement("tbody");
      for (const event of data.events) {
        const tr = document.createElement("tr");
        tr.append(htmlCell("td", dateTime(event.at)));
        tr.append(htmlCell("td", ACTION_LABEL[event.action] ?? event.action));
        tr.append(htmlCell("td", event.pollId, "mono"));
        const resultCell = htmlCell("td", event.result === "success" ? "成功" : "失败");
        resultCell.className = event.result === "success" ? "ok mono" : "error mono";
        tr.append(resultCell);
        tr.append(htmlCell("td", JSON.stringify(event.details), "mono details"));
        tbody.append(tr);
      }
      table.append(tbody);
      content.append(table);
    } catch (error) {
      if (seq !== requestSeq) return;
      pager.hidden = true;
      const status = (error as { status?: number }).status;
      const code = (error as { body?: { error?: string } })?.body?.error;
      let message: string;
      if (isNetworkFailure(error)) message = "网络失败：暂时无法连接服务，请稍后重试。";
      else if (status === 401 || code === "admin_unauthorized") message = "未授权（401 admin_unauthorized）：管理令牌缺失、错误或服务端未配置；请重新设置令牌后再打开审计视图。";
      else if (status === 400 && code === "invalid_time_range") message = "时间参数无效（400）：from/to 必须是带时区的严格 ISO8601 时刻（如 2026-09-20T10:00:00Z），且区间不可倒置。";
      else if (status === 400 && code === "invalid_pagination") message = "分页参数无效（400）：page 与 pageSize 须为正整数，pageSize 上限 200。";
      else message = errorText(error);
      content.replaceChildren(text("p", message, "error audit-error"));
    }
  }

  function applyFilters() {
    filters.pollId = pollIdInput.value;
    filters.action = actionSelect.value;
    filters.result = resultSelect.value;
    filters.from = fromInput.value;
    filters.to = toInput.value;
    filters.pageSize = Number(pageSizeSelect.value);
    // Any filter change restarts pagination at the first page.
    page = 1;
    void load();
  }
  searchButton.addEventListener("click", applyFilters);
  for (const input of [pollIdInput, fromInput, toInput]) {
    input.addEventListener("keydown", event => { if (event.key === "Enter") applyFilters(); });
  }
  actionSelect.addEventListener("change", applyFilters);
  resultSelect.addEventListener("change", applyFilters);
  pageSizeSelect.addEventListener("change", applyFilters);
  firstButton.addEventListener("click", () => { page = 1; void load(); });
  prevButton.addEventListener("click", () => { page -= 1; void load(); });
  nextButton.addEventListener("click", () => { page += 1; void load(); });
  lastButton.addEventListener("click", () => {
    page = totalPages;
    void load();
  });

  void load();
}
function htmlRow(part: "thead", cells: string[]): HTMLElement {
  const thead = document.createElement(part);
  const tr = document.createElement("tr");
  for (const cell of cells) tr.append(htmlCell("th", cell));
  thead.append(tr);
  return thead;
}
function htmlCell(tag: "td" | "th", content: string, className = ""): HTMLElement {
  const cell = document.createElement(tag);
  cell.textContent = content;
  if (className) cell.className = className;
  return cell;
}

// ---- Admin token wiring (in-memory only) -----------------------------------

function applyAdminMode() {
  const on = isAdmin();
  clearButton.hidden = !on;
  createButton.hidden = !on;
  auditButton.hidden = !on;
  adminMode.hidden = !on;
  tokenInput.disabled = on;
  setButton.textContent = on ? "已设置" : "设置";
}
setButton.addEventListener("click", () => {
  adminToken = tokenInput.value.trim();
  tokenInput.value = "";
  applyAdminMode();
  void loadPolls()
    .then(polls => { if (polls[0]) void showPoll(polls[0].id); else detail.replaceChildren(text("div", "", "empty")); })
    .catch(error => list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error")));
});
clearButton.addEventListener("click", () => {
  adminToken = "";
  applyAdminMode();
  void loadPolls()
    .then(polls => { if (polls[0]) void showPoll(polls[0].id); })
    .catch(error => list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error")));
});
createButton.addEventListener("click", () => createDraftModal());
auditButton.addEventListener("click", () => void auditModal());
applyAdminMode();

void (async () => {
  try {
    const polls = await loadPolls();
    if (polls[0]) await showPoll(polls[0].id); else list.append(text("p", "暂无议题"));
  } catch (error) { list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error")); }
})();
