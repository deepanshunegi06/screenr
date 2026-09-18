"""The interviewer agent, typed path.

One turn = one call to ``Interviewer.turn``. Inside a turn the model may call tools
any number of times (capped per turn); the turn ends when it produces something
to say.

The graph is deliberately small. What makes this an agent is not the topology --
it is that the model chooses which tools to call, in what order, based on what the
candidate just said. Two candidates who get the same opening question produce
different tool sequences. ``evals/test_branching.py`` asserts exactly that.

``render_system_prompt`` is shared with the voice driver, so both paths reason from
the same rubric, the same anchors and the same live state.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.messages.utils import trim_messages
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from ..config import get_settings
from ..llm import build_llm
from .state import InterviewContext, InterviewState
from .tools import build_tools

PROMPT = (Path(__file__).parent / "prompts" / "interviewer.md").read_text(encoding="utf-8")

# How many earlier messages travel with each request, on top of the whole current
# turn. The system prompt carries the state that matters -- evidence recorded,
# skills uncovered, questions asked -- so history is context, not memory.
WINDOW_MESSAGES = 12

# Resume text beyond this is cut. A two-page resume fits; the point is to let the
# model check a claim against it, not to embed a dossier.
RESUME_CHARS = 4000


def render_system_prompt(ctx: InterviewContext) -> str:
    s = get_settings()

    skills_block = "\n".join(
        f"- `{sk.key}` ({sk.name}{', cross-cutting' if sk.cross_cutting else ''}): {sk.what_good_looks_like}"
        for sk in ctx.skills
    )
    claims_block = (
        "\n".join(f"- `{c.id}` [{c.status}] {c.text}" for c in ctx.claims)
        or "- No claims extracted. Ask what they have built."
    )
    resume_block = ctx.resume_text.strip()[:RESUME_CHARS] or "(no resume supplied)"
    evidence_block = (
        "\n".join(f'- {e.skill_key} {e.score:g}/5: "{e.quote[:160]}" -- {e.note}' for e in ctx.evidence)
        or "- nothing yet"
    )

    nudge = ""
    if ctx.turn_count - ctx.last_evidence_turn >= 2 and not ctx.is_finished():
        nudge = (
            "> You have spoken without recording anything for the last two answers. "
            "Call record_evidence or plan_probe now, before asking anything."
        )

    remaining = s.max_interview_seconds - ctx.elapsed_seconds()
    closing_note = ""
    if remaining < 180 and not ctx.is_finished():
        closing_note = (
            "> Under three minutes left. Cover any skill with no evidence now, "
            "score cross-cutting skills, then call end_interview."
        )

    return PROMPT.format(
        role_title=ctx.role_title,
        skills_block=skills_block,
        claims_block=claims_block,
        resume_block=resume_block,
        evidence_block=evidence_block,
        elapsed=int(ctx.elapsed_seconds()),
        max_seconds=s.max_interview_seconds,
        turn_count=ctx.turn_count,
        uncovered=", ".join(sk.key for sk in ctx.uncovered_skills()) or "none",
        probes=", ".join(f"{k}={v}" for k, v in ctx.probes.items()) or "none",
        unverified=", ".join(c.id for c in ctx.unverified_claims()) or "none",
        asked="\n".join(f"- {q}" for q in ctx.asked[-6:]) or "- (none yet)",
        nudge=nudge,
        closing_note=closing_note,
    )


def _current_turn_start(messages: list) -> int:
    """Index of the HumanMessage that opened the turn in progress."""
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], HumanMessage):
            return i
    return 0


def _tools_this_turn(messages: list) -> int:
    start = _current_turn_start(messages)
    return sum(isinstance(m, ToolMessage) for m in messages[start:])


def build_graph(ctx: InterviewContext, checkpointer=None):
    settings = get_settings()
    tools = build_tools(ctx)
    llm_with_tools = build_llm().bind_tools(tools)
    # Once a turn has spent its tool budget the model must speak. Forcing
    # tool_choice off is how; routing to END with a dangling tool call would leave
    # history the next provider call rejects.
    llm_speak_only = build_llm().bind_tools(tools, tool_choice="none")
    tool_node = ToolNode(tools)

    def agent(state: InterviewState) -> dict:
        messages = state["messages"]
        start = _current_turn_start(messages)
        # Everything in the current turn always goes to the model -- cutting a
        # tool call from its result produces an invalid sequence. Only history
        # before the turn is windowed.
        earlier = trim_messages(
            messages[:start],
            strategy="last",
            token_counter=len,
            max_tokens=WINDOW_MESSAGES,
            start_on="human",
            include_system=False,
            allow_partial=False,
        )
        model = (
            llm_speak_only if _tools_this_turn(messages) >= settings.max_tool_iterations else llm_with_tools
        )
        prompt = [SystemMessage(render_system_prompt(ctx)), *earlier, *messages[start:]]
        return {"messages": [model.invoke(prompt)]}

    def route(state: InterviewState) -> str:
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    g = StateGraph(InterviewState)
    g.add_node("agent", agent)
    g.add_node("tools", tool_node)
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", route, {"tools": "tools", END: END})
    g.add_edge("tools", "agent")
    return g.compile(checkpointer=checkpointer or MemorySaver())


class Interviewer:
    """Wraps the graph with the turn-level rules that must not be left to the model:
    caps, stop reasons, and the guarantee that every turn produces something to say."""

    def __init__(self, ctx: InterviewContext, checkpointer=None) -> None:
        self.ctx = ctx
        self.graph = build_graph(ctx, checkpointer)
        self.settings = get_settings()

    def _config(self) -> dict:
        return {"configurable": {"thread_id": self.ctx.session_id}}

    def _enforce_caps(self) -> str | None:
        if self.ctx.elapsed_seconds() >= self.settings.max_interview_seconds:
            self.ctx.stop_reason = "duration_cap"
        elif self.ctx.turn_count >= self.settings.max_turns:
            self.ctx.stop_reason = "turn_cap"
        else:
            return None
        return (
            "That is all the time we have. Thanks for walking me through your work "
            "-- someone from the team will follow up with next steps."
        )

    def _record_tools(self, result: dict) -> None:
        messages = result["messages"]
        start = _current_turn_start(messages)
        called = [
            call["name"]
            for message in messages[start:]
            for call in (getattr(message, "tool_calls", None) or [])
        ]
        self.ctx.tool_log.append(called)

    def _speak(self, result: dict) -> str:
        messages = result["messages"]
        start = _current_turn_start(messages)
        for message in reversed(messages[start:]):
            if isinstance(message, AIMessage):
                text = (message.text if isinstance(message.text, str) else message.text()).strip()
                if text:
                    return text
        # The model spent the turn on tools and produced nothing to say. Rare,
        # and silence on a live call is worse than a filler line.
        return "Sorry, could you say a bit more about that?"

    def _remember(self, utterance: str) -> str:
        self.ctx.asked.append(utterance)
        return utterance

    def open(self) -> str:
        result = self.graph.invoke(
            {"messages": [HumanMessage("[The candidate has joined. Begin the interview.]")]},
            self._config(),
        )
        self._record_tools(result)
        return self._remember(self._speak(result))

    def turn(self, answer: str) -> str:
        if self.ctx.is_finished():
            return "We are all done -- thanks again for your time."

        capped = self._enforce_caps()
        if capped:
            return capped

        self.ctx.turn_count += 1
        self.ctx.answers.append(answer)
        result = self.graph.invoke({"messages": [HumanMessage(answer)]}, self._config())
        self._record_tools(result)
        return self._remember(self._speak(result))
