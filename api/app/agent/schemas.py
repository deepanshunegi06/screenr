"""Tool schemas for Deepgram, derived from the same tools LangGraph uses.

There is one definition of every tool, in `tools.py`. Deepgram needs them as
JSON-schema function declarations; this converts them rather than restating them,
so the voice agent and the typed agent can never drift apart on what a tool is
called or what it takes.
"""

from __future__ import annotations

from langchain_core.utils.function_calling import convert_to_openai_tool

from .state import InterviewContext
from .tools import build_tools


def deepgram_functions(ctx: InterviewContext) -> list[dict]:
    functions = []
    for tool in build_tools(ctx):
        spec = convert_to_openai_tool(tool)["function"]
        functions.append(
            {
                "name": spec["name"],
                "description": spec.get("description", ""),
                "parameters": spec.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return functions


def run_tool(ctx: InterviewContext, name: str, arguments: dict) -> str:
    """Execute a tool by name against this interview's context."""
    for tool in build_tools(ctx):
        if tool.name == name:
            try:
                return str(tool.invoke(arguments))
            except Exception as exc:
                # The model gets the error as an observation and can correct itself.
                # A raised exception here would kill the socket mid-interview.
                return f"That call failed: {exc}"
    return f"No tool named {name}."
