import "./style.css";
import type { PollDetail, PollResults, PollSummary, VoteReceipt } from "../src/types.ts";

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

const ERROR_TEXT: Record<string, string> = {
  poll_closed: "议题已截止，无法投票",
  duplicate_nullifier: "该身份已在此议题投过票（重复提交被拒绝）",
  invalid_proof: "证明无效，投票被拒绝",
  proof_binding_mismatch: "证明与议题或选项不匹配，投票被拒绝",
  unknown_option: "选项无效",
  invalid_vote: "提交内容格式不正确",
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
  const legend = text("legend", "选择方案");
  optionFieldset.append(legend);
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
        body: JSON.stringify({ optionId, proof })
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

let selected = "";
async function showPoll(id: string) {
  selected = id;
  list.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.classList.toggle("selected", button.dataset.id === id); button.setAttribute("aria-pressed", String(button.dataset.id === id)); });
  detail.replaceChildren(text("p", "正在读取议题…", "empty"));
  try {
    const { poll } = await request<{ poll: PollDetail }>(`/api/polls/${encodeURIComponent(id)}`);
    if (selected !== id) return;
    const heading = text("div", "", "detail-heading");
    heading.append(text("span", "公开议题", "tag"), text("span", `发布于 ${date(poll.publishedAt)}`, "muted"));
    const stats = text("div", "", "stats");
    for (const [label, value] of [["参与成员", `${poll.memberCount} 位`], ["可选方案", `${poll.optionCount} 项`], ["截止日期", date(poll.closesAt)]]) {
      const item = text("div", ""); item.append(text("span", label, "muted"), text("strong", value)); stats.append(item);
    }
    const options = document.createElement("ol"); options.className = "options";
    poll.options.forEach((option, index) => { const item = document.createElement("li"); item.append(text("span", String(index + 1).padStart(2, "0"), "option-number"), text("span", option.label)); options.append(item); });
    const commitments = document.createElement("details"); commitments.className = "commitments";
    commitments.append(text("summary", `成员公开承诺 · ${poll.eligibleMemberCommitments.length} 项`));
    commitments.append(text("p", "承诺用于标识已登记的成员资格，不包含姓名或身份秘密。此处展示演示成员数据。", "muted"));
    poll.eligibleMemberCommitments.forEach(commitment => commitments.append(text("code", commitment)));
    detail.replaceChildren(heading, text("h2", poll.title), text("p", poll.description, "description"), text("p", `议题组织方 / ${poll.organizer}`, "organizer"), stats, text("h3", "议题方案"), options, commitments, voteSection(poll));
  } catch (error) { if (selected === id) detail.replaceChildren(text("p", error instanceof Error ? error.message : "暂时无法读取议题", "error")); }
}
try {
  const { polls } = await request<{ polls: PollSummary[] }>("/api/polls");
  document.querySelector("#poll-count")!.textContent = `${polls.length} 个议题`;
  list.replaceChildren();
  polls.forEach(poll => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.id = poll.id; button.className = "poll-card";
    button.append(text("span", poll.organizer, "card-organizer"), text("strong", poll.title), text("span", poll.summary, "card-summary"), text("span", `${poll.memberCount} 位成员 · ${poll.optionCount} 个方案`, "card-meta"));
    button.addEventListener("click", () => void showPoll(poll.id)); list.append(button);
  });
  if (polls[0]) await showPoll(polls[0].id); else list.append(text("p", "暂无议题"));
} catch (error) { list.replaceChildren(text("p", error instanceof Error ? error.message : "目录暂时不可用", "error")); }
