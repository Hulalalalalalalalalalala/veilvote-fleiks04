import "./style.css";
import type { GroupVersionSummary, PollDetail, PollResults, PollSummary, VoteReceipt } from "../src/types.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/" aria-label="VeilVote 首页"><span class="mark">V</span>VeilVote</a><span class="header-note">社区议事 / 匿名投票</span></header><main><section class="intro"><p class="eyebrow">COMMUNITY COMMONS</p><h1>让每个声音，<br>都从知情开始。</h1><p>浏览社区正在讨论的议题，以 Semaphore 零知识证明匿名投出你的一票。</p><div class="intro-footer"><span class="status-dot"></span>议题目录<span class="intro-divider">/</span><span id="poll-count">正在读取…</span></div></section><section class="workspace" aria-label="议题浏览器"><aside><p class="section-caption">当前议题</p><div id="poll-list" aria-live="polite">加载中…</div></aside><article id="poll-detail" aria-live="polite"><div class="empty">选择议题查看内容</div></article></section></main><footer><span>VeilVote</span><span>公开信息 · 独立判断 · 社区共识</span></footer>`;
const list = document.querySelector<HTMLDivElement>("#poll-list")!;
const detail = document.querySelector<HTMLElement>("#poll-detail")!;

function text(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function date(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw Object.assign(new Error(`请求失败（${response.status}）`), { status: response.status, body: await response.json().catch(() => undefined) });
  return response.json() as Promise<T>;
}
async function fetchPoll(id: string): Promise<PollDetail> {
  return (await request<{ poll: PollDetail }>(`/api/polls/${encodeURIComponent(id)}`)).poll;
}

const ERROR_TEXT: Record<string, string> = {
  poll_closed: "议题已截止，无法投票",
  duplicate_nullifier: "该身份已在此议题投过票（重复提交被拒绝）",
  invalid_proof: "证明无效，投票被拒绝",
  proof_binding_mismatch: "证明与议题、选项或成员快照不匹配，投票被拒绝",
  unknown_option: "选项无效",
  invalid_vote: "提交内容格式不正确",
  invalid_group_change: "成员变更格式不正确",
  invalid_json: "提交内容不是合法 JSON",
  poll_not_found: "议题不存在",
  group_version_changed: "成员资格快照已变更（版本过期）",
  group_frozen: "首张选票已冻结成员资格，此后不能再变更",
  commitment_not_found: "目标承诺不在当前成员快照中",
  duplicate_commitment: "该承诺已存在于当前成员快照中",
  empty_group: "不能撤销最后一位成员，成员组不能为空"
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

function shortRoot(root: string): string {
  return `${root.slice(0, 10)}…${root.slice(-8)}`;
}

function voteSection(getPoll: () => PollDetail, refreshSnapshot: () => Promise<PollDetail>): HTMLElement {
  const section = text("section", "", "vote");
  section.append(text("h3", "匿名投票"));
  section.append(text("p", "身份秘密仅在本页内存中用于生成 Semaphore 零知识证明，不会上传、保存或离开浏览器。证明严格按议题详情中的成员快照（版本与 Merkle 根如下）生成。演示身份 veilvote-demo-member-01 至 veilvote-demo-member-08 仅供合成演示数据，不可用于真实用户。", "muted vote-note"));

  const identityLabel = text("label", "身份秘密", "vote-label");
  const identityInput = document.createElement("input");
  identityInput.type = "password";
  identityInput.autocomplete = "off";
  identityInput.placeholder = "演示：veilvote-demo-member-01";
  identityLabel.append(identityInput);

  const optionFieldset = document.createElement("fieldset");
  optionFieldset.className = "vote-options";
  const legend = text("legend", "选择方案");
  optionFieldset.append(legend);
  getPoll().options.forEach((option, index) => {
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
    const poll = getPoll();
    try {
      const { result } = await request<{ result: PollResults }>(`/api/polls/${encodeURIComponent(poll.id)}/results`);
      resultsMount.replaceChildren(resultsBlock(result, poll));
    } catch (error) { resultsMount.replaceChildren(text("p", errorText(error), "error")); }
  }

  let busy = false;
  submit.addEventListener("click", async () => {
    if (busy) return;
    const poll = getPoll();
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
      const commitment = identity.commitment.toString();
      if (!poll.eligibleMemberCommitments.includes(commitment)) {
        throw new Error("该身份不在当前版本的成员承诺中，请刷新后确认成员快照。");
      }
      const group = new Group(poll.eligibleMemberCommitments);
      status.textContent = `正在按成员快照 v${poll.groupVersion} 生成零知识证明（首次需下载证明参数）…`;
      const proof = await generateProof(identity, group, optionId, poll.id);
      status.textContent = "正在提交选票…";
      const response = await fetch(`/api/polls/${encodeURIComponent(poll.id)}/votes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optionId, proof, groupVersion: poll.groupVersion })
      });
      if (response.status === 409) {
        const conflict = await response.json().catch(() => undefined) as { error?: string; groupVersion?: number } | undefined;
        if (conflict?.error === "group_version_changed") {
          const updated = await refreshSnapshot();
          status.textContent = `成员快照已从 v${poll.groupVersion} 更新到 v${updated.groupVersion}，旧证明未被接受。请用新快照重新点击提交。`;
          status.className = "vote-status error";
          return;
        }
        throw Object.assign(new Error("请求失败（409）"), { status: 409, body: conflict });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`请求失败（${response.status}）`), { status: response.status, body: await response.json().catch(() => undefined) });
      }
      const { receipt } = await response.json() as { receipt: VoteReceipt };
      identityInput.value = "";
      status.textContent = `投票已被接受（冻结于成员快照 v${receipt.groupVersion}），回执如下（可凭回执编号随时查询）。`;
      status.className = "vote-status ok";
      const receiptList = document.createElement("dl");
      for (const [label, value] of [["回执编号", receipt.id], ["议题", receipt.pollId], ["选项", receipt.optionId], ["成员版本", `v${receipt.groupVersion}`], ["Nullifier", receipt.nullifier], ["接受时间", receipt.acceptedAt]]) {
        receiptList.append(text("dt", label), text("dd", value));
      }
      receiptBox.replaceChildren(receiptList);
      await refreshSnapshot();
      await refreshResults();
    } catch (error) {
      status.textContent = `${errorText(error)} 可修正后重试。`;
      status.className = "vote-status error";
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

/**
 * Demo-only member administration: the identity secret stays in the page and
 * only the derived public commitment is sent to the server.
 */
function groupAdminSection(
  getPoll: () => PollDetail,
  refreshSnapshot: () => Promise<PollDetail>,
  onVersionChange: (listener: () => void) => void
): HTMLElement {
  const section = text("section", "", "group-admin");
  section.append(text("h3", "成员资格变更（演示）"));
  section.append(text("p", "在本地由身份秘密推导公开承诺后再提交，秘密本身不会上传。join 追加承诺；rotate 以新承诺原位替换旧承诺；revoke 删除承诺。首张选票接受后快照冻结。", "muted vote-note"));

  const versionLine = text("p", "", "group-version-line");
  const renderVersion = () => {
    const poll = getPoll();
    versionLine.replaceChildren(
      text("span", `当前版本 v${poll.groupVersion} · ${poll.memberCount} 位成员 · Merkle 根 ${shortRoot(poll.merkleRoot)} · `, "muted"),
      poll.frozen ? text("strong", "已冻结", "frozen") : text("span", "可变更", "open")
    );
    submit.disabled = poll.frozen;
    submit.textContent = poll.frozen ? "成员快照已冻结" : "推导承诺并提交变更";
  };
  // The sibling vote section (or this one) lets us know when the snapshot moved.
  onVersionChange(renderVersion);

  const opFieldset = document.createElement("fieldset");
  opFieldset.className = "vote-options";
  opFieldset.append(text("legend", "操作类型"));
  for (const [value, label] of [["join", "join 加入"], ["rotate", "rotate 轮换"], ["revoke", "revoke 撤销"]] as const) {
    const labelElement = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "group-op";
    radio.value = value;
    if (value === "join") radio.checked = true;
    labelElement.append(radio, text("span", label));
    opFieldset.append(labelElement);
  }

  const oldLabel = text("label", "现有身份秘密（rotate / revoke）", "vote-label");
  const oldInput = document.createElement("input");
  oldInput.type = "password";
  oldInput.autocomplete = "off";
  oldInput.placeholder = "演示：veilvote-demo-member-01";
  oldLabel.append(oldInput);

  const newLabel = text("label", "新身份秘密（join / rotate）", "vote-label");
  const newInput = document.createElement("input");
  newInput.type = "password";
  newInput.autocomplete = "off";
  newInput.placeholder = "例如：veilvote-demo-member-09";
  newLabel.append(newInput);

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "vote-submit";
  submit.textContent = "推导承诺并提交变更";
  const status = text("p", "", "vote-status");

  async function deriveCommitment(secret: string): Promise<string> {
    const { Identity } = await import("@semaphore-protocol/identity");
    return new Identity(secret).commitment.toString();
  }

  submit.addEventListener("click", async () => {
    const poll = getPoll();
    const operation = opFieldset.querySelector<HTMLInputElement>("input:checked")?.value as "join" | "rotate" | "revoke" | undefined;
    if (!operation) return;
    const oldSecret = oldInput.value.trim();
    const newSecret = newInput.value.trim();
    if ((operation === "rotate" || operation === "revoke") && !oldSecret) { status.textContent = "请填写现有身份秘密。"; status.className = "vote-status error"; return; }
    if ((operation === "join" || operation === "rotate") && !newSecret) { status.textContent = "请填写新身份秘密。"; status.className = "vote-status error"; return; }
    submit.disabled = true;
    try {
      status.textContent = "正在本地推导公开承诺…";
      status.className = "vote-status";
      const payload: Record<string, unknown> = { operation, expectedVersion: poll.groupVersion };
      if (operation === "join") payload.commitment = await deriveCommitment(newSecret);
      else if (operation === "revoke") payload.commitment = await deriveCommitment(oldSecret);
      else {
        payload.oldCommitment = await deriveCommitment(oldSecret);
        payload.newCommitment = await deriveCommitment(newSecret);
      }
      const response = await fetch(`/api/polls/${encodeURIComponent(poll.id)}/group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => undefined) as { group?: GroupVersionSummary; error?: string };
      if (!response.ok) throw Object.assign(new Error(`请求失败（${response.status}）`), { status: response.status, body });
      const group = body.group!;
      oldInput.value = "";
      newInput.value = "";
      status.textContent = `变更成功：新版本 v${group.groupVersion}，Merkle 根 ${shortRoot(group.merkleRoot)}，${group.memberCount} 位成员。`;
      status.className = "vote-status ok";
      await refreshSnapshot();
    } catch (error) {
      const code = (error as { body?: { error?: string } })?.body?.error;
      if (code === "group_version_changed") {
        const updated = await refreshSnapshot();
        status.textContent = `版本过期：快照已更新到 v${updated.groupVersion}，请基于新版本重试。`;
      } else {
        status.textContent = errorText(error);
      }
      status.className = "vote-status error";
    } finally {
      submit.disabled = false;
      renderVersion();
    }
  });

  section.append(versionLine, opFieldset, oldLabel, newLabel, submit, status);
  renderVersion();
  return section;
}

let selected = "";
async function showPoll(id: string) {
  selected = id;
  list.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.classList.toggle("selected", button.dataset.id === id); button.setAttribute("aria-pressed", String(button.dataset.id === id)); });
  detail.replaceChildren(text("p", "正在读取议题…", "empty"));
  try {
    let poll = await fetchPoll(id);
    if (selected !== id) return;

    const snapshotMount = text("div", "", "snapshot");
    function renderSnapshot() {
      snapshotMount.replaceChildren();
      const line = text("p", "");
      line.append(text("span", "成员资格快照 ", "snapshot-label"), text("strong", `v${poll.groupVersion}`), text("span", ` · ${poll.memberCount} 位成员 · `, "muted"));
      line.append(poll.frozen ? text("strong", "已冻结", "frozen") : text("span", "投票前可变更", "open"));
      snapshotMount.append(line);
      const root = text("code", poll.merkleRoot, "snapshot-root");
      snapshotMount.append(text("p", "Semaphore Merkle 根", "muted"), root);
    }
    const heading = text("div", "", "detail-heading");
    heading.append(text("span", "公开议题", "tag"), text("span", `发布于 ${date(poll.publishedAt)}`, "muted"));
    const stats = text("div", "", "stats");
    function renderStats() {
      stats.replaceChildren();
      for (const [label, value] of [["参与成员", `${poll.memberCount} 位`], ["成员版本", `v${poll.groupVersion}${poll.frozen ? "（已冻结）" : ""}`], ["截止日期", date(poll.closesAt)]]) {
        const item = text("div", ""); item.append(text("span", label, "muted"), text("strong", value)); stats.append(item);
      }
    }
    const commitments = document.createElement("details"); commitments.className = "commitments";
    function renderCommitments() {
      commitments.replaceChildren(
        text("summary", `成员公开承诺 · ${poll.eligibleMemberCommitments.length} 项（快照 v${poll.groupVersion}）`),
        text("p", "承诺用于标识已登记的成员资格，不包含姓名或身份秘密。此处展示当前不可变版本；变更成员会生成新版本。", "muted"),
        ...poll.eligibleMemberCommitments.map(commitment => text("code", commitment))
      );
    }
    const options = document.createElement("ol"); options.className = "options";
    poll.options.forEach((option, index) => { const item = document.createElement("li"); item.append(text("span", String(index + 1).padStart(2, "0"), "option-number"), text("span", option.label)); options.append(item); });

    renderSnapshot();
    renderStats();
    renderCommitments();
    // Sections notify each other when the snapshot moves (vote freezes it; a
    // group change advances it), so every block keeps showing the same version.
    const versionListeners = new Set<() => void>();
    const refreshSnapshot = async (): Promise<PollDetail> => {
      poll = await fetchPoll(id);
      if (selected === id) {
        renderSnapshot(); renderStats(); renderCommitments();
        for (const listener of versionListeners) listener();
      }
      return poll;
    };
    const getPoll = () => poll;

    detail.replaceChildren(
      heading, text("h2", poll.title), text("p", poll.description, "description"), text("p", `议题组织方 / ${poll.organizer}`, "organizer"),
      stats, snapshotMount, text("h3", "议题方案"), options, commitments,
      voteSection(getPoll, refreshSnapshot),
      groupAdminSection(getPoll, refreshSnapshot, listener => versionListeners.add(listener))
    );
  } catch (error) { if (selected === id) detail.replaceChildren(text("p", error instanceof Error ? error.message : "暂时无法读取议题", "error")); }
}
try {
  const { polls } = await request<{ polls: PollSummary[] }>("/api/polls");
  document.querySelector("#poll-count")!.textContent = `${polls.length} 个议题`;
  list.replaceChildren();
  polls.forEach(poll => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.id = poll.id; button.className = "poll-card";
    button.append(text("span", poll.organizer, "card-organizer"), text("strong", poll.title), text("span", poll.summary, "card-summary"), text("span", `${poll.memberCount} 位成员 · v${poll.groupVersion} · ${poll.optionCount} 个方案`, "card-meta"));
    button.addEventListener("click", () => void showPoll(poll.id)); list.append(button);
  });
  if (polls[0]) await showPoll(polls[0].id); else list.append(text("p", "暂无议题"));
} catch (error) { list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error")); }
