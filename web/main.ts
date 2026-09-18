import "./style.css";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { generateProof } from "@semaphore-protocol/proof";
import type { PollDetail, PollResult, PollSummary, VoteReceipt } from "../src/types.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/" aria-label="VeilVote 首页"><span class="mark">V</span>VeilVote</a><span class="header-note">社区议事 / 匿名投票</span></header><main><section class="intro"><p class="eyebrow">COMMUNITY COMMONS</p><h1>让每个声音，<br>都从知情开始。</h1><p>浏览社区正在讨论的议题，以 Semaphore 零知识证明匿名投出一票：服务器只验证成员资格，无法把选票关联到任何身份。</p><div class="intro-footer"><span class="status-dot"></span>议题目录<span class="intro-divider">/</span><span id="poll-count">正在读取…</span></div></section><section class="workspace" aria-label="议题浏览器"><aside><p class="section-caption">当前议题</p><div id="poll-list" aria-live="polite">加载中…</div></aside><article id="poll-detail" aria-live="polite"><div class="empty">选择议题查看内容</div></article></section></main><footer><span>VeilVote</span><span>公开信息 · 独立判断 · 社区共识</span></footer>`;
const list = document.querySelector<HTMLDivElement>("#poll-list")!;
const detail = document.querySelector<HTMLElement>("#poll-detail")!;

function text(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function date(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
function dateTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new VoteError(response.status, body.error);
  return body as T;
}
class VoteError extends Error {
  constructor(public status: number, public code?: string) { super(code ?? `请求失败（${status}）`); }
}
const ERROR_TEXT: Record<string, string> = {
  invalid_request: "提交格式不正确，请刷新后重试。",
  invalid_option: "所选方案已失效，请重新选择。",
  invalid_proof: "证明无效或已被篡改，请重新生成后再试。",
  poll_closed: "议题已截止，无法投票。",
  duplicate_vote: "该身份在此议题已投过票，不能重复提交。",
  poll_not_found: "议题不存在。",
  receipt_not_found: "回执不存在。"
};
function explain(error: unknown): string {
  return error instanceof VoteError ? (ERROR_TEXT[error.code ?? ""] ?? `投票失败（${error.status}），请重试。`) : "网络或证明生成失败，请重试。";
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
    const commitments = document.createElement("details"); commitments.className = "commitments";
    commitments.append(text("summary", `成员公开承诺 · ${poll.eligibleMemberCommitments.length} 项`));
    commitments.append(text("p", "承诺用于标识已登记的成员资格，不包含姓名或身份秘密。此处展示演示成员数据。", "muted"));
    poll.eligibleMemberCommitments.forEach(commitment => commitments.append(text("code", commitment)));
    detail.replaceChildren(
      heading, text("h2", poll.title), text("p", poll.description, "description"), text("p", `议题组织方 / ${poll.organizer}`, "organizer"),
      stats, buildVotePanel(poll), commitments, buildResultsPanel(poll)
    );
  } catch (error) { if (selected === id) detail.replaceChildren(text("p", error instanceof Error ? error.message : "暂时无法读取议题", "error")); }
}

function buildVotePanel(poll: PollDetail): HTMLElement {
  const panel = text("section", "", "vote-panel");
  panel.append(text("h3", "匿名投票"));
  panel.append(text("p", "身份秘密只在本浏览器内存中使用：证明在本地生成，秘密不会上传、不会保存。演示身份 veilvote-demo-member-01 至 08 仅对应合成数据，不可用于真实成员。", "vote-note"));
  const identityRow = text("div", "", "identity-row");
  const secretInput = document.createElement("input");
  secretInput.type = "password"; secretInput.placeholder = "输入身份秘密（演示：veilvote-demo-member-01）";
  secretInput.autocomplete = "off"; secretInput.setAttribute("aria-label", "身份秘密");
  const memberBadge = text("span", "未输入身份", "member-badge");
  identityRow.append(secretInput, memberBadge);
  const optionList = text("div", "", "vote-options");
  const radios: HTMLInputElement[] = [];
  poll.options.forEach((option, index) => {
    const label = document.createElement("label"); label.className = "vote-option";
    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = `option-${poll.id}`; radio.value = option.id;
    radios.push(radio);
    label.append(radio, text("span", String(index + 1).padStart(2, "0"), "option-number"), text("span", option.label));
    optionList.append(label);
  });
  const submit = document.createElement("button");
  submit.type = "button"; submit.className = "vote-submit"; submit.textContent = "生成证明并投票"; submit.disabled = true;
  const status = text("p", "", "vote-status");
  const receiptBox = text("div", "", "receipt-box");
  receiptBox.hidden = true;

  // The identity lives only in this closure — never stored, never sent.
  let identity: Identity | undefined;
  secretInput.addEventListener("input", () => {
    identity = undefined;
    const secret = secretInput.value.trim();
    if (!secret) { memberBadge.textContent = "未输入身份"; memberBadge.dataset.state = ""; }
    else {
      try {
        const candidate = new Identity(secret);
        const isMember = poll.eligibleMemberCommitments.includes(candidate.commitment.toString());
        identity = isMember ? candidate : undefined;
        memberBadge.textContent = isMember ? "已登记成员" : "不在成员名单";
        memberBadge.dataset.state = isMember ? "ok" : "bad";
      } catch { memberBadge.textContent = "身份无效"; memberBadge.dataset.state = "bad"; }
    }
    submit.disabled = !identity || !radios.some(radio => radio.checked);
  });
  radios.forEach(radio => radio.addEventListener("change", () => { submit.disabled = !identity || !radios.some(item => item.checked); }));

  let busy = false;
  submit.addEventListener("click", () => {
    if (busy || !identity) return;
    const chosen = radios.find(radio => radio.checked);
    if (!chosen) return;
    busy = true; // 处理中防重复提交；失败时恢复，可重试
    submit.disabled = true; submit.textContent = "正在生成证明…";
    status.textContent = "正在本地生成零知识证明，请稍候…"; status.className = "vote-status";
    receiptBox.hidden = true;
    void (async () => {
      try {
        const group = new Group(poll.eligibleMemberCommitments);
        const proof = await generateProof(identity, group, chosen.value, poll.id);
        status.textContent = "证明已生成，正在提交…";
        const { receipt } = await request<{ receipt: VoteReceipt }>(`/api/polls/${encodeURIComponent(poll.id)}/votes`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId: chosen.value, proof })
        });
        status.textContent = "投票已被匿名接受。"; status.className = "vote-status ok";
        submit.textContent = "已投票";
        receiptBox.replaceChildren(
          text("p", "投票回执（可凭回执编号在 GET /api/receipts/:id 查验）", "receipt-title"),
          text("code", `回执编号 ${receipt.id}`),
          text("code", `Nullifier ${receipt.nullifier}`),
          text("code", `接受时间 ${dateTime(receipt.acceptedAt)}`)
        );
        receiptBox.hidden = false;
        detail.querySelector(".results-panel")?.dispatchEvent(new Event("refresh-results"));
      } catch (error) {
        status.textContent = explain(error); status.className = "vote-status error";
        submit.disabled = false; submit.textContent = "重试投票";
        busy = false;
        return;
      }
    })();
  });
  panel.append(identityRow, optionList, submit, status, receiptBox);
  return panel;
}

function buildResultsPanel(poll: PollDetail): HTMLElement {
  const panel = text("section", "", "results-panel");
  const titleRow = text("div", "", "results-heading");
  const refresh = document.createElement("button");
  refresh.type = "button"; refresh.className = "results-refresh"; refresh.textContent = "刷新";
  titleRow.append(text("h3", "匿名计票结果"), refresh);
  const body = text("div", "", "results-body");
  panel.append(titleRow, body);
  async function load() {
    refresh.disabled = true;
    try {
      const { result } = await request<{ result: PollResult }>(`/api/polls/${encodeURIComponent(poll.id)}/results`);
      const labels = new Map(poll.options.map(option => [option.id, option.label]));
      body.replaceChildren(text("p", `已计入 ${result.total} 张匿名选票`, "results-total"));
      const rows = text("div", "", "results-rows");
      const max = Math.max(1, ...result.options.map(option => option.count));
      for (const option of result.options) {
        const row = text("div", "", "result-row");
        const bar = text("span", "", "result-bar");
        bar.style.width = `${Math.max(2, (option.count / max) * 100)}%`;
        row.append(text("span", labels.get(option.id) ?? option.id, "result-label"), bar, text("span", `${option.count} 票`, "result-count"));
        rows.append(row);
      }
      body.append(rows);
    } catch (error) { body.replaceChildren(text("p", explain(error), "error")); }
    refresh.disabled = false;
  }
  refresh.addEventListener("click", () => void load());
  panel.addEventListener("refresh-results", () => void load());
  void load();
  return panel;
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
