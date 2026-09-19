import "./style.css";
import type { AuditEvent, AuditPage, PollDetail, PollResults, PollStatus, PollSummary, VoteReceipt } from "../src/types.ts";

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
const AUDIT_ACTIONS = ["poll_create", "poll_status_change", "group_change", "group_change_rejected", "status_change_rejected"];

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
function dateTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(new Date(value)); }
function isAdmin(): boolean { return adminToken.length > 0; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // Attach the in-memory token to every request while management mode is on.
  if (isAdmin()) headers.set("X-Admin-Token", adminToken);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw Object.assign(new Error(`请求失败（${response.status}）`), { status: response.status, body });
  return body as T;
}

/** Copy to clipboard with a legacy fallback; never throws, reports success. */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch { return false; }
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
  invalid_poll_dates: "时间不合法：需为带时区的 ISO8601 时刻，且截止时间晚于发布时间",
  invalid_options: "至少需要两个选项，且 id 非空、标签非空",
  duplicate_option_id: "选项 id 重复",
  invalid_commitments: "成员承诺必须为非空的合法字段元素",
  duplicate_commitment: "成员承诺重复",
  invalid_group_operation: "成员变更内容格式不正确",
  receipt_not_found: "回执编号未知（404）",
  receipt_mismatch: "核验字段与回执记录不符（422）",
  invalid_verification: "核验请求格式不正确（400）",
  invalid_json: "请求体不是合法 JSON（400）",
  invalid_time_range: "时间范围不合法：from/to 需为带时区的严格 ISO8601 时刻，且不得倒置（400）",
  invalid_pagination: "分页参数不合法（400）"
};
function errorText(error: unknown): string {
  const code = (error as { body?: { error?: string } })?.body?.error;
  return (code && ERROR_TEXT[code]) || (error instanceof Error ? error.message : "操作失败，请重试");
}
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && !("status" in error));
}

function statusBadge(status: PollStatus): HTMLElement {
  return text("span", STATUS_LABEL[status], `status-badge status-${status}`);
}

/** Per-option tally list, always rendered in the poll's original option order. */
function tallyList(result: PollResults, poll: PollDetail): HTMLElement {
  const counts = new Map(result.options.map(option => [option.id, option.count]));
  const listElement = document.createElement("ul");
  listElement.className = "tally";
  for (const option of poll.options) {
    const item = document.createElement("li");
    item.append(text("span", option.label), text("strong", `${counts.get(option.id) ?? 0} 票`));
    listElement.append(item);
  }
  return listElement;
}

// ---- Results: live tally while open, immutable snapshot after close --------

function liveResultsBlock(result: PollResults, poll: PollDetail): HTMLElement {
  const wrapper = text("div", "", "results results-live");
  wrapper.append(text("h3", `实时计数 · 当前共 ${result.total} 票`));
  wrapper.append(text("p", "投票进行中：计数随选票实时变化，此阶段不产生快照。", "muted results-note"));
  wrapper.append(tallyList(result, poll));
  return wrapper;
}

/**
 * Closed/archived view of the immutable close snapshot: closedAt, the group
 * version captured at close, the digest and the per-option counts in the
 * poll's original option order. A refresh re-fetches the same snapshot; the
 * digest comparison makes stability across refresh/archive/restart visible.
 */
function snapshotBlock(poll: PollDetail): HTMLElement {
  const wrapper = text("section", "", "snapshot-panel");
  wrapper.append(text("h3", "最终结果 · 关闭时快照"));
  wrapper.append(text("p", "议题截止时在同一事务内写入的不可变快照；归档、刷新与服务重启后均保持不变。", "muted results-note"));
  const mount = text("div", "", "snapshot-mount");
  mount.append(text("p", "正在读取快照…", "muted"));
  const actions = document.createElement("div");
  actions.className = "snapshot-actions";
  const refresh = document.createElement("button");
  refresh.type = "button"; refresh.className = "admin-button ghost"; refresh.textContent = "重新拉取快照";
  const copy = document.createElement("button");
  copy.type = "button"; copy.className = "admin-button"; copy.textContent = "复制快照摘要（JSON）";
  const line = text("p", "", "snapshot-status muted"); line.setAttribute("aria-live", "polite");
  actions.append(refresh, copy, line);
  wrapper.append(mount, actions);

  let lastDigest = "";
  let lastResult: PollResults | null = null;
  let busy = false;

  function render(result: PollResults) {
    const snap = result.snapshot;
    mount.replaceChildren();
    if (!snap) { mount.append(text("p", "服务端未返回快照，请刷新重试。", "error")); return; }
    mount.append(tallyList(result, poll));
    const meta = document.createElement("dl");
    meta.className = "snapshot-meta";
    const rows: [string, string][] = [
      ["关闭时刻 (closedAt)", snap.closedAt],
      ["成员版本 (groupVersion)", `v${snap.groupVersion}`],
      ["总票数 (total)", String(snap.total)],
      ["摘要 (digest)", snap.digest]
    ];
    for (const [label, value] of rows) {
      meta.append(text("dt", label), text("dd", value, "mono snapshot-field"));
    }
    const pre = document.createElement("pre");
    pre.className = "snapshot-json mono";
    // Exactly the snapshot object that the copy button copies.
    pre.textContent = JSON.stringify(snap, null, 2);
    const details = document.createElement("details");
    details.append(text("summary", "查看 / 选择完整快照 JSON"));
    details.append(pre);
    mount.append(meta, details);
  }

  async function load() {
    if (busy) return;
    busy = true; refresh.disabled = true;
    line.className = "snapshot-status muted"; line.textContent = "正在拉取…";
    try {
      const { result } = await request<{ result: PollResults }>(`/api/polls/${encodeURIComponent(poll.id)}/results`);
      const snap = result.snapshot;
      if (!snap) throw new Error("missing_snapshot");
      render(result);
      lastResult = result;
      line.className = "snapshot-status ok";
      line.textContent = lastDigest && lastDigest !== snap.digest
        ? `警告：本次快照 digest 与上次不同（${lastDigest.slice(0, 12)}… → ${snap.digest.slice(0, 12)}…）`
        : `快照已拉取${lastDigest ? "，digest 与上次一致，内容不变" : ""}：${snap.digest.slice(0, 16)}…`;
      lastDigest = snap.digest;
    } catch (error) {
      line.className = "snapshot-status error";
      line.textContent = errorText(error);
    } finally {
      busy = false; refresh.disabled = false;
    }
  }

  refresh.addEventListener("click", () => void load());
  copy.addEventListener("click", async () => {
    if (!lastResult?.snapshot) { line.className = "snapshot-status error"; line.textContent = "快照尚未加载，暂无可复制内容。"; return; }
    const summary = JSON.stringify(lastResult.snapshot, null, 2);
    line.className = "snapshot-status muted"; line.textContent = "正在复制…";
    const copied = await copyText(summary);
    line.className = copied ? "snapshot-status ok" : "snapshot-status error";
    line.textContent = copied ? "快照摘要已复制到剪贴板。" : "复制失败：请展开 JSON 手动选择复制。";
  });

  void load();
  return wrapper;
}

// ---- Receipt verification ---------------------------------------------------

function verifySection(pollId: string): HTMLElement {
  const section = text("section", "", "verify");
  section.append(text("h3", "回执核验（POST /api/receipts/:id/verify）"));
  section.append(text("p", "输入投票回执上的四项公开字段即可核验选票已被计入。核验只比对回执自身的公开字段，不需要也不会请求身份秘密；所有输入仅存在于本页内存中。", "muted results-note"));

  const form = document.createElement("form");
  form.className = "verify-form";
  form.noValidate = true;
  const fields: [string, string, string][] = [
    ["receiptId", "回执编号", "receipt id（UUID）"],
    ["pollId", "议题 pollId", pollId],
    ["optionId", "选项 optionId", "option id"],
    ["nullifier", "Nullifier", "选票 nullifier"]
  ];
  const inputs: Record<string, HTMLInputElement> = {};
  for (const [key, label, placeholder] of fields) {
    const wrapper = text("label", label, "verify-label");
    const input = document.createElement("input");
    input.type = "text";
    input.id = `verify-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    input.autocomplete = "off";
    input.placeholder = placeholder;
    input.value = key === "pollId" ? pollId : "";
    inputs[key] = input;
    wrapper.append(input);
    form.append(wrapper);
  }
  const submit = document.createElement("button");
  submit.type = "submit"; submit.className = "admin-button primary"; submit.textContent = "核验回执";
  const statusLine = text("p", "", "verify-status muted");
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");
  form.append(submit, statusLine);
  section.append(form);

  let busy = false;
  function setBusyState(on: boolean) {
    busy = on;
    submit.disabled = on;
    for (const input of Object.values(inputs)) input.disabled = on;
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    if (busy) return;
    const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
    if (!values.receiptId || !values.pollId || !values.optionId || !values.nullifier) {
      statusLine.dataset.outcome = "bad-request";
      statusLine.className = "verify-status error";
      statusLine.textContent = "请填写全部四个字段（回执编号、pollId、optionId、nullifier）后再提交。";
      return;
    }
    setBusyState(true);
    statusLine.dataset.outcome = "busy";
    statusLine.className = "verify-status muted";
    statusLine.textContent = "正在提交核验…";
    void (async () => {
      try {
        const reply = await request<{ valid: boolean; receipt: VoteReceipt }>(`/api/receipts/${encodeURIComponent(values.receiptId)}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pollId: values.pollId, optionId: values.optionId, nullifier: values.nullifier })
        });
        statusLine.dataset.outcome = "success";
        statusLine.className = "verify-status ok";
        statusLine.textContent = `核验成功：回执有效（valid=true），选票接受于 ${reply.receipt.acceptedAt}。`;
      } catch (error) {
        const status = (error as { status?: number }).status;
        statusLine.className = "verify-status error";
        if (status === 404) {
          statusLine.dataset.outcome = "unknown";
          statusLine.textContent = "未找到该回执编号（404 receipt_not_found）：请检查回执编号是否抄录正确。";
        } else if (status === 422) {
          statusLine.dataset.outcome = "mismatch";
          statusLine.textContent = "字段不符（422 receipt_mismatch）：pollId / optionId / nullifier 至少一项与回执记录不一致，可修改后重试。";
        } else if (status === 400) {
          statusLine.dataset.outcome = "bad-request";
          statusLine.textContent = `请求格式错误（400 ${(error as { body?: { error?: string } }).body?.error ?? "invalid_verification"}）：请检查字段格式后重试。`;
        } else if (status === 401) {
          statusLine.dataset.outcome = "bad-request";
          statusLine.textContent = errorText(error);
        } else if (isNetworkFailure(error)) {
          statusLine.dataset.outcome = "network";
          statusLine.textContent = "网络失败：未能连接服务端，请检查网络后重试。";
        } else {
          statusLine.dataset.outcome = "network";
          statusLine.textContent = `${errorText(error)}（可修改后重试）`;
        }
      } finally {
        setBusyState(false);
      }
    })();
  });
  return section;
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
      resultsMount.replaceChildren(liveResultsBlock(result, poll));
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
      status.textContent = "投票已被接受，回执如下（可凭回执编号随时核验）。";
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
  refresh.textContent = "刷新实时计数";
  refresh.addEventListener("click", () => void refreshResults());

  section.append(identityLabel, optionFieldset, submit, status, receiptBox, resultsMount, refresh);
  void refreshResults();
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
      detail.append(text("p", "该议题仍为草稿：不对公众显示，普通详情、投票、结果与回执核验均不可见。管理员可在上方完善成员名单后开放投票。", "draft-note"));
    } else if (poll.status === "open") {
      detail.append(voteSection(poll));
      detail.append(verifySection(poll.id));
    } else {
      detail.append(text("p", poll.status === "closed" ? "议题已截止，结果为关闭时写入的不可变快照，继续公开可查、可核验。" : "议题已归档，快照结果继续公开可查、可核验，归档不改变快照。", "muted"));
      detail.append(snapshotBlock(poll));
      detail.append(verifySection(poll.id));
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

// ---- Audit trail: filters + pagination -------------------------------------

function auditModal() {
  const body = document.createElement("div");
  body.className = "audit-body";

  // Filter bar.
  const filterBar = document.createElement("div");
  filterBar.className = "audit-filters";
  const pollFilter = document.createElement("input");
  pollFilter.type = "text"; pollFilter.id = "audit-filter-poll-id"; pollFilter.placeholder = "pollId 精确匹配";
  const actionFilter = document.createElement("select");
  actionFilter.id = "audit-filter-action";
  actionFilter.append(new Option("全部动作", ""));
  for (const action of AUDIT_ACTIONS) actionFilter.append(new Option(ACTION_LABEL[action], action));
  const resultFilter = document.createElement("select");
  resultFilter.id = "audit-filter-result";
  resultFilter.append(new Option("全部结果", ""), new Option("成功", "success"), new Option("失败", "failure"));
  const fromFilter = document.createElement("input");
  fromFilter.type = "datetime-local"; fromFilter.id = "audit-filter-from"; fromFilter.step = "1";
  const toFilter = document.createElement("input");
  toFilter.type = "datetime-local"; toFilter.id = "audit-filter-to"; toFilter.step = "1";
  const pageSizeFilter = document.createElement("select");
  pageSizeFilter.id = "audit-page-size";
  for (const size of [10, 20, 50, 100, 200]) pageSizeFilter.append(new Option(`每页 ${size}`, String(size)));
  pageSizeFilter.value = "50";
  for (const [label, control] of [["议题", pollFilter], ["动作", actionFilter], ["结果", resultFilter], ["起 (from)", fromFilter], ["止 (to)", toFilter], ["分页", pageSizeFilter]] as [string, HTMLElement][]) {
    const wrapper = text("label", label, "audit-filter-label");
    wrapper.append(control);
    filterBar.append(wrapper);
  }
  filterBar.append(text("p", "from/to 以本地时区填写，将以带时区的严格 ISO8601（UTC）提交；修改任一筛选条件都会回到第一页。", "muted audit-filter-note"));

  const stateLine = text("p", "", "audit-state muted");
  stateLine.setAttribute("aria-live", "polite");
  const summaryLine = text("p", "", "audit-summary muted");
  const tableMount = document.createElement("div");
  const pager = document.createElement("div");
  pager.className = "audit-pager";
  const firstButton = Object.assign(document.createElement("button"), { type: "button", className: "admin-button ghost", textContent: "« 首页" });
  firstButton.id = "audit-first";
  const prevButton = Object.assign(document.createElement("button"), { type: "button", className: "admin-button ghost", textContent: "‹ 上一页" });
  prevButton.id = "audit-prev";
  const pageIndicator = text("span", "", "audit-page-indicator mono");
  pageIndicator.id = "audit-page-indicator";
  const nextButton = Object.assign(document.createElement("button"), { type: "button", className: "admin-button ghost", textContent: "下一页 ›" });
  nextButton.id = "audit-next";
  const lastButton = Object.assign(document.createElement("button"), { type: "button", className: "admin-button ghost", textContent: "末页 »" });
  lastButton.id = "audit-last";
  pager.append(firstButton, prevButton, pageIndicator, nextButton, lastButton);

  body.append(filterBar, stateLine, summaryLine, tableMount, pager);
  openModal("审计记录（GET /api/admin/audit，按时间倒序）", body);

  let page = 1;
  let requestSeq = 0;
  let loading = false;
  let latestTotalPages = 1;

  function setState(kind: "loading" | "empty" | "loaded" | "error", message: string) {
    stateLine.dataset.state = kind;
    stateLine.className = `audit-state ${kind === "error" ? "error" : kind === "loading" ? "muted" : "muted"}`;
    stateLine.textContent = message;
  }

  function buildQuery(): string {
    const params = new URLSearchParams();
    const pollId = pollFilter.value.trim();
    if (pollId) params.set("pollId", pollId);
    if (actionFilter.value) params.set("action", actionFilter.value);
    if (resultFilter.value) params.set("result", resultFilter.value);
    if (fromFilter.value) {
      const instant = new Date(fromFilter.value);
      if (!Number.isNaN(instant.getTime())) params.set("from", instant.toISOString());
    }
    if (toFilter.value) {
      const instant = new Date(toFilter.value);
      if (!Number.isNaN(instant.getTime())) params.set("to", instant.toISOString());
    }
    params.set("page", String(page));
    params.set("pageSize", pageSizeFilter.value);
    return params.toString();
  }

  function renderTable(events: AuditEvent[]) {
    const table = document.createElement("table");
    table.className = "audit-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const cell of ["时间", "动作", "议题", "结果", "详情"]) headRow.append(htmlCell("th", cell));
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const event of events) {
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
    tableMount.replaceChildren(table);
  }

  function renderPager(data: AuditPage) {
    latestTotalPages = Math.max(data.totalPages, 1);
    pageIndicator.textContent = `第 ${data.page} / ${latestTotalPages} 页`;
    firstButton.disabled = data.page <= 1;
    prevButton.disabled = data.page <= 1;
    // On an out-of-range empty page next/last are disabled while first/prev
    // remain an escape hatch; the empty state explains how to return.
    nextButton.disabled = data.totalPages === 0 || data.page >= data.totalPages;
    lastButton.disabled = data.totalPages === 0 || data.page >= data.totalPages;
  }

  async function load() {
    if (loading) return;
    loading = true;
    const seq = ++requestSeq;
    for (const button of [firstButton, prevButton, nextButton, lastButton]) button.disabled = true;
    setState("loading", "正在读取审计记录…");
    tableMount.replaceChildren();
    summaryLine.textContent = "";
    try {
      const data = await request<AuditPage>(`/api/admin/audit?${buildQuery()}`);
      if (seq !== requestSeq) return; // A newer request superseded this one.
      renderPager(data);
      summaryLine.textContent = `共 ${data.total} 条事件 · ${Math.max(data.totalPages, 1)} 页 · 每页 ${data.pageSize} 条（倒序；仅记录动作、议题、结果、时间与详情，不记录令牌、秘密或证明）`;
      if (data.events.length === 0) {
        const beyond = data.total > 0 && data.page > data.totalPages;
        setState("empty", beyond ? "本页没有记录：请求的页码超出范围，请用分页按钮返回。" : "没有符合当前筛选条件的审计事件。");
        tableMount.replaceChildren();
      } else {
        setState("loaded", "");
        stateLine.textContent = "";
        renderTable(data.events);
      }
    } catch (error) {
      if (seq !== requestSeq) return;
      const status = (error as { status?: number }).status;
      setState("error", status === 401
        ? "未授权（401 admin_unauthorized）：管理令牌缺失或错误，请在右上角设置正确的令牌后重试。"
        : status === 400
          ? `查询参数不合法（400）：${errorText(error)}`
          : isNetworkFailure(error)
            ? "网络失败：无法连接服务端，请稍后重试。"
            : errorText(error));
      summaryLine.textContent = "";
      pageIndicator.textContent = "";
      firstButton.disabled = false; prevButton.disabled = false;
      nextButton.disabled = false; lastButton.disabled = false;
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  // Any filter change returns to page 1; pageSize is a filter for that purpose.
  for (const control of [pollFilter, actionFilter, resultFilter, fromFilter, toFilter, pageSizeFilter]) {
    control.addEventListener("change", () => { page = 1; void load(); });
  }
  firstButton.addEventListener("click", () => { if (page !== 1) { page = 1; void load(); } });
  prevButton.addEventListener("click", () => { if (page > 1) { page -= 1; void load(); } });
  nextButton.addEventListener("click", () => { page += 1; void load(); });
  lastButton.addEventListener("click", () => {
    // Jump to the last page known from the most recent successful response.
    if (page !== latestTotalPages) { page = latestTotalPages; void load(); }
  });

  void load();
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
  void loadPolls().then(polls => { if (polls[0]) void showPoll(polls[0].id); else detail.replaceChildren(text("div", "", "empty")); });
});
clearButton.addEventListener("click", () => {
  adminToken = "";
  applyAdminMode();
  void loadPolls().then(polls => { if (polls[0]) void showPoll(polls[0].id); });
});
createButton.addEventListener("click", () => createDraftModal());
auditButton.addEventListener("click", () => auditModal());
applyAdminMode();

try {
  const polls = await loadPolls();
  if (polls[0]) await showPoll(polls[0].id); else list.append(text("p", "暂无议题"));
} catch (error) { list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error")); }
