import "./style.css";
import type { PollDetail, PollSummary } from "../src/types.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><a class="brand" href="/" aria-label="VeilVote 首页"><span class="mark">V</span>VeilVote</a><span class="header-note">社区议事 / 公开议题</span></header><main><section class="intro"><p class="eyebrow">COMMUNITY COMMONS</p><h1>让每个声音，<br>都从知情开始。</h1><p>浏览社区正在讨论的议题，了解可选方案与参与名单的公开承诺。</p><div class="intro-footer"><span class="status-dot"></span>议题目录<span class="intro-divider">/</span><span id="poll-count">正在读取…</span></div></section><section class="workspace" aria-label="议题浏览器"><aside><p class="section-caption">当前议题</p><div id="poll-list" aria-live="polite">加载中…</div></aside><article id="poll-detail" aria-live="polite"><div class="empty">选择议题查看内容</div></article></section></main><footer><span>VeilVote</span><span>公开信息 · 独立判断 · 社区共识</span></footer>`;
const list = document.querySelector<HTMLDivElement>("#poll-list")!;
const detail = document.querySelector<HTMLElement>("#poll-detail")!;

function text(tag: string, content: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
}
function date(value: string) { return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
async function request<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`读取失败（${response.status}）`);
  return response.json() as Promise<T>;
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
    detail.replaceChildren(heading, text("h2", poll.title), text("p", poll.description, "description"), text("p", `议题组织方 / ${poll.organizer}`, "organizer"), stats, text("h3", "议题方案"), options, commitments, text("p", "当前页面提供议题与公开成员信息浏览。", "read-only-note"));
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
