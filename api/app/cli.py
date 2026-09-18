"""Run an interview in the terminal, in text, with no audio.

    python -m app.cli                         interview yourself
    python -m app.cli --persona bluffer       watch a scripted candidate
    python -m app.cli --persona all           run every persona, print the traces

This is how development happens. Audio costs credit and takes twenty minutes a
run; text costs almost nothing and takes seconds, so the agent's behaviour gets
exercised hundreds of times before a microphone is ever involved.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .agent.graph import Interviewer
from .roles import build_context
from .scoring import build_scorecard


def _print_card(card: dict) -> None:
    print("\n" + "-" * 60)
    print(f"  {card['role_title']}   {card['duration_seconds']}s   {card['turns']} turns")
    print(f"  overall {card['overall']}  |  {card['confidence']} confidence")
    print(f"  recommendation: {card['recommendation']}  (a human decides)")
    if card["escalation_note"]:
        print(f"  escalated: {card['escalation_note']}")
    print("-" * 60)
    for skill in card["skills"]:
        score = skill["score"]
        shown = f"{score:.1f}" if score is not None else "  -"
        print(f"  {shown}  {skill['name']}")
        for item in skill["evidence"]:
            quote = item["quote"]
            print(f'        "{quote[:88]}{"..." if len(quote) > 88 else ""}"')
    if any(c["status"] != "unverified" for c in card["claims"]):
        print("\n  resume claims")
        for claim in card["claims"]:
            print(f"    [{claim['status']:>10}] {claim['text'][:70]}")
    if card["flags"]:
        print("\n  flags")
        for flag in card["flags"]:
            print(f"    {flag['kind']}: {flag['detail']}")
    print()


def run_personas(names: list[str]) -> None:
    from evals import personas as p
    from evals.runner import run_interview

    lookup = {persona.name: persona for persona in p.ALL}
    chosen = p.ALL if names == ["all"] else [lookup[n] for n in names]

    for persona in chosen:
        run = run_interview(persona, max_turns=8)
        print(run.pretty())
        _print_card(run.scorecard)


def run_live(rubric: str, resume_path: str | None) -> None:
    resume = Path(resume_path).read_text(encoding="utf-8") if resume_path else ""
    ctx = build_context(rubric, resume_text=resume)
    agent = Interviewer(ctx)

    print("\n(type 'quit' to stop)\n")
    print(f"  agent: {agent.open()}\n")

    while not ctx.is_finished():
        try:
            answer = input("  you: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if answer.lower() in {"quit", "exit"}:
            break
        if not answer:
            continue
        print(f"\n  agent: {agent.turn(answer)}\n")

    _print_card(build_scorecard(ctx))
    print("  tools called per turn:")
    for i, turn in enumerate(ctx.tool_log):
        print(f"    {i}: {' -> '.join(turn) or '(spoke without calling tools)'}")


def main() -> int:
    parser = argparse.ArgumentParser(prog="screenr")
    parser.add_argument("--persona", help="scripted candidate name, or 'all'")
    parser.add_argument("--rubric", default="backend_intern")
    parser.add_argument("--resume", help="path to a resume text file")
    args = parser.parse_args()

    if args.persona:
        run_personas([n.strip() for n in args.persona.split(",")])
    else:
        run_live(args.rubric, args.resume)
    return 0


if __name__ == "__main__":
    sys.exit(main())
