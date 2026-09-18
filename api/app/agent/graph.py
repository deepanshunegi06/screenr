"""The interviewer agent.

One turn = one call to ``run_turn``. Inside a turn the model may call tools any
number of times (capped); the turn ends when it produces something to say.

The graph is deliberately small. What makes this an agent is not the topology --
it is that the model chooses which tools to call, in what order, based on what the
candidate just said. Two candidates who get the same opening question will produce
different tool sequences. ``evals/test_branching.py`` asserts exactly that.
"""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.messages.utils import trim_messages
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from ..config import get_settings
from ..llm import build_llm
from .state import InterviewContext, InterviewState
from .tools import build_tools

PROMPT = (Path(__file__).parent / "prompts" / "interviewer.md").read_text(encoding="utf-8")

# How many recent messages travel with each request. The system prompt carries
# the state that matters, so this only needs to cover the current exchange and
# its tool calls.
WINDOW_MESSAGES = 10


def render_system_prompt(ctx: InterviewContext) -> str:
    s = get_settings()

    skills_block = "\n".join(
        f"- **{sk.key}** ({sk.name}): {sk.what_good_looks_like}" for sk in ctx.skills
    )
    claims_block = (
        "\n".join(f"- `{c.id}` [{c.status}] {c.text}" for c in ctx.claims)
        or "- No resume claims were extracted. Ask them what they have built."
    )

    remaining = s.max_interview_seconds - ctx.elapsed_seconds()
    closing_note = ""
    if remaining < 180 and not ctx.is_finished():
        closing_note = (
            "> Under three minutes left. Cover any skill with no evidence now, "
            "then call `end_interview`."
        )

    return PROMPT.format(
        role_title=ctx.role_title,
        skills_block=skills_block,
        claims_block=claims_block,
        elapsed=int(ctx.elapsed_seconds()),
        max_seconds=s.max_interview_seconds,
        turn_count=ctx.turn_count,
        max_turns=s.max_turns,
        uncovered=", ".join(sk.key for sk in ctx.uncovered_skills()) or "none",
        asked="\n".join(f"- {q}" for q in ctx.asked[-5:]) or "- (none yet)",
        unverified=", ".join(c.id for c in ctx.unverified_claims()) or "none",
        closing_note=closing_note,
    )


def build_graph(ctx: InterviewContext, checkpointer=None):
    settings = get_settings()
    tools = build_tools(ctx)
    llm = build_llm().bind_tools(tools)
    tool_node = ToolNode(tools)

    def agent(state: InterviewState) -> dict:
        # Only the recent conversation goes to the model. Everything the agent has
        # concluded is already in the system prompt -- scores recorded, skills still
        # uncovered, claims still open -- so the older turns are redundant context,
        # and re-sending them every turn is what burns a token-per-minute budget.
        recent = trim_messages(
            state["messages"],
            strategy="last",
            token_counter=len,
            max_tokens=WINDOW_MESSAGES,
            start_on="human",
            include_system=False,
            allow_partial=False,
        )
        messages = [SystemMessage(render_system_prompt(ctx)), *(recent or state["messages"][-1:])]
        return {"messages": [llm.invoke(messages)]}

    def route(state: InterviewState) -> str:
        last = state["messages"][-1]
        if not getattr(last, "tool_calls", None):
            return END
        # Guardrail: a model that keeps calling tools without ever speaking would
        # leave the candidate in silence. Cut it off and make it answer.
        used = sum(1 for m in state["messages"] if isinstance(m, ToolMessage))
        if used >= settings.max_tool_iterations:
            return END
        return "tools"

    g = StateGraph(InterviewState)
    g.add_node("agent", agent)
    g.add_node("tools", tool_node)
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", route, {"tools": "tools", END: END})
    g.add_edge("tools", "agent")
    return g.compile(checkpointer=checkpointer)


class Interviewer:
    """Wraps the graph with the turn-level rules that must not be left to the model:
    caps, stop reasons, and the guarantee that every turn produces something to say."""

    def __init__(self, ctx: InterviewContext, checkpointer=None) -> None:
        self.ctx = ctx
        self.graph = build_graph(ctx, checkpointer)
        self.settings = get_settings()
        self._seen = 0

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
        # invoke() returns the whole accumulated history, so only look at what is
        # new since the last turn.
        messages = result["messages"]
        called = [
            call["name"]
            for message in messages[self._seen :]
            for call in (getattr(message, "tool_calls", None) or [])
        ]
        self._seen = len(messages)
        self.ctx.tool_log.append(called)

    def _speak(self, result: dict) -> str:
        for message in reversed(result["messages"]):
            if isinstance(message, AIMessage) and isinstance(message.content, str):
                if message.content.strip():
                    return message.content.strip()
        # ponytail: the model called tools until the cap without speaking. Rare,
        # but silence on a live call is worse than a filler line.
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
        result = self.graph.invoke({"messages": [HumanMessage(answer)]}, self._config())
        self._record_tools(result)
        return self._remember(self._speak(result))
